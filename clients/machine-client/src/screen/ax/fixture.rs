//! The headless observer: the `elements` trees of the fixture layout's
//! windows, re-read from the layout file on every call so a test can
//! rewrite it to move, replace or recreate a window (a changed `epoch`
//! token is a recreation). A row is observable when it names `pid`; its
//! `app` defaults to `/fixture/<pid>` without a bundle id. Actions land as
//! `kind: "action"` recorder lines.

use std::{
    fs,
    marker::PhantomData,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    target, walk, ActFault, Action, Admit, AppIdentity, Attributes, Bounds, Frame, Observer,
    Segment, Tree, Walk, WindowIdentity,
};
use crate::screen::observe;
use crate::screen::settle::{
    observer, Notification, Notifications, Sample, Subscription, Unsupported,
};
use crate::{
    computer::append,
    screen::{private::Focused, Fault},
};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Element {
    role: String,
    label: Option<String>,
    value: Option<String>,
    #[serde(default)]
    actions: Vec<String>,
    frame: Frame,
    #[serde(default)]
    secure: bool,
    enabled: Option<bool>,
    selected: Option<bool>,
    checked: Option<bool>,
    expanded: Option<bool>,
    #[serde(default)]
    focused: bool,
    #[serde(default)]
    children: Vec<Element>,
}

#[derive(Deserialize)]
struct Layout {
    #[serde(default)]
    windows: Vec<Row>,
}

#[derive(Deserialize)]
struct Row {
    id: u32,
    title: String,
    pid: Option<u32>,
    app: Option<AppIdentity>,
    #[serde(default)]
    x: i64,
    #[serde(default)]
    y: i64,
    #[serde(default)]
    epoch: u64,
    #[serde(default)]
    elements: Vec<Element>,
    #[serde(default)]
    minimized: bool,
    #[serde(default)]
    timeline: Vec<Timeline>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Timeline {
    at_ms: u64,
    kind: TimelineKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum TimelineKind {
    ValueChanged,
    LayoutChanged,
    Destroyed,
}

pub struct Scripted {
    pub layout: PathBuf,
    pub recorder: PathBuf,
}

pub struct ScriptedNotifications {
    pub layout: PathBuf,
}

struct Events {
    queued: Vec<(Instant, Notification)>,
    now: Instant,
    observer: Arc<dyn Observer>,
    pid: u32,
    window: u32,
}

impl Subscription for Events {
    fn now(&self) -> Instant {
        self.now
    }

    fn receive_until(&mut self, deadline: Instant) -> Option<(Instant, Notification)> {
        if self.queued.first().is_some_and(|(at, _)| *at <= deadline) {
            let event = self.queued.remove(0);
            self.now = self.now.max(event.0);
            Some(event)
        } else {
            self.now = self.now.max(deadline);
            None
        }
    }

    fn sample(&mut self, deadline: Instant) -> Result<Sample, observe::Refusal> {
        observer::sample(
            self.observer.as_ref(),
            self.pid,
            self.window,
            deadline,
            || self.now,
        )
    }
    fn commit_if_current(&mut self, commit: Box<dyn FnOnce() -> Value + '_>) -> Option<Value> {
        Some(commit())
    }
}

impl Notifications for ScriptedNotifications {
    fn subscribe(
        &self,
        pid: u32,
        window_id: u32,
        start: Instant,
        _deadline: Instant,
        observer: Arc<dyn Observer>,
    ) -> Result<Box<dyn Subscription>, Unsupported> {
        let rows = Scripted {
            layout: self.layout.clone(),
            recorder: PathBuf::new(),
        };
        let row = rows
            .rows()
            .map_err(|_| Unsupported::NoObserver)?
            .into_iter()
            .find(|row| row.pid == Some(pid) && row.id == window_id)
            .ok_or(Unsupported::WindowNotFound)?;
        let mut queued: Vec<_> = row
            .timeline
            .into_iter()
            .map(|event| {
                let kind = match event.kind {
                    TimelineKind::Destroyed => Notification::Destroyed,
                    TimelineKind::ValueChanged | TimelineKind::LayoutChanged => {
                        Notification::Changed
                    }
                };
                (start + Duration::from_millis(event.at_ms), kind)
            })
            .collect();
        queued.sort_by_key(|(at, _)| *at);
        Ok(Box::new(Events {
            queued,
            now: start,
            observer,
            pid,
            window: window_id,
        }))
    }
}

struct Rows<'a>(PhantomData<&'a Element>);

impl<'a> Tree for Rows<'a> {
    type Item = &'a Element;

    fn read(&self, item: &&'a Element) -> Result<(Attributes, Vec<&'a Element>), Fault> {
        let attributes = Attributes {
            role: item.role.clone(),
            label: item.label.clone(),
            value: item.value.clone(),
            actions: item.actions.clone(),
            frame: item.frame,
            secure: item.secure,
            enabled: item.enabled,
            selected: item.selected,
            checked: item.checked,
            expanded: item.expanded,
            focused: item.focused,
        };
        Ok((attributes, item.children.iter().collect()))
    }
}

impl Scripted {
    fn rows(&self) -> Result<Vec<Row>, Fault> {
        let text = fs::read(&self.layout).map_err(|error| Fault::Failed(error.to_string()))?;
        let layout: Layout =
            serde_json::from_slice(&text).map_err(|error| Fault::Failed(error.to_string()))?;
        Ok(layout.windows)
    }

    fn row(&self, window: &WindowIdentity) -> Result<Row, Fault> {
        self.rows()?
            .into_iter()
            .find(|row| row.id == window.window_id && row.pid == Some(window.pid))
            .ok_or(Fault::WindowNotFound)
    }
}

/// The app a fixture row without `app` reports.
pub fn fixture_app(pid: u32) -> AppIdentity {
    AppIdentity {
        bundle_id: None,
        path: format!("/fixture/{pid}"),
    }
}

fn supports(element: &Element, action: &Action) -> bool {
    match action {
        Action::Press => element.actions.iter().any(|name| name == "AXPress"),
        Action::SetValue(_) => element.value.is_some() || element.secure,
        Action::Perform(name) => element.actions.contains(name),
    }
}

impl Observer for Scripted {
    fn lifecycle(&self, window: &WindowIdentity, park: bool) -> Result<(), ActFault> {
        self.row(window).map_err(|_| ActFault::NotFound)?;
        append(
            &self.recorder,
            &json!({
                "kind": if park { "window_park" } else { "window_close" },
                "pid": window.pid, "windowId": window.window_id
            }),
        )
        .map_err(|error| ActFault::Failed(error.to_string()))
    }
    fn focused(&self, window: &WindowIdentity) -> Result<Option<Focused>, Fault> {
        fn find(elements: &[Element]) -> Option<Focused> {
            for element in elements {
                if element.focused {
                    return Some(Focused {
                        role: element.role.clone(),
                        secure: element.secure,
                    });
                }
                if let Some(focused) = find(&element.children) {
                    return Some(focused);
                }
            }
            None
        }
        Ok(find(&self.row(window)?.elements))
    }
    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
        Ok(self
            .rows()?
            .into_iter()
            .filter_map(|row| {
                let pid = row.pid?;
                Some(WindowIdentity {
                    pid,
                    window_id: row.id,
                    owner_pid: pid,
                    title: row.title,
                    app: row.app.unwrap_or_else(|| fixture_app(pid)),
                    token: row.epoch,
                    origin: (row.x, row.y),
                    minimized: row.minimized,
                })
            })
            .collect())
    }

    fn walk(&self, window: &WindowIdentity, bounds: &Bounds) -> Result<Walk, Fault> {
        let row = self.row(window)?;
        walk(&Rows(PhantomData), row.elements.iter().collect(), bounds)
    }

    fn act(
        &self,
        window: &WindowIdentity,
        path: &[Segment],
        admit: Admit<'_>,
        action: &Action,
    ) -> Result<(), ActFault> {
        self.act_guarded(window, path, admit, action, &|| true)
    }

    fn act_guarded(
        &self,
        window: &WindowIdentity,
        path: &[Segment],
        admit: Admit<'_>,
        action: &Action,
        before_dispatch: &dyn Fn() -> bool,
    ) -> Result<(), ActFault> {
        let row = self.row(window)?;
        let (element, _) = target(
            &Rows(PhantomData),
            row.elements.iter().collect(),
            path,
            admit,
        )?;
        if !supports(element, action) {
            return Err(ActFault::Unsupported);
        }
        let reference: Vec<String> = path.iter().map(Segment::to_string).collect();
        let (verb, argument) = match action {
            Action::Press => ("press", None),
            Action::SetValue(value) => ("setValue", Some(("value", value))),
            Action::Perform(name) => ("perform", Some(("name", name))),
        };
        let mut line = json!({
            "kind": "action", "pid": window.pid, "windowId": window.window_id,
            "ref": reference.join("/"), "action": verb,
        });
        if let Some((key, text)) = argument {
            line[key] = json!(text);
        }
        if !before_dispatch() {
            return Err(ActFault::NotFound);
        }
        append(&self.recorder, &line).map_err(|error| ActFault::Failed(error.to_string()))
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> WindowIdentity {
        WindowIdentity {
            pid: 7,
            window_id: 9,
            owner_pid: 7,
            title: "Editor".into(),
            app: fixture_app(7),
            token: 0,
            origin: (0, 0),
            minimized: false,
        }
    }

    fn scripted(directory: &std::path::Path, layout: &str) -> Scripted {
        let path = directory.join("layout.json");
        fs::write(&path, layout).expect("layout");
        Scripted {
            layout: path,
            recorder: directory.join("recorder.jsonl"),
        }
    }

    const LAYOUT: &str = r#"{"windows":[{"id":9,"title":"Editor","pid":7,"elements":[
        {"role":"AXButton","label":"OK","actions":["AXPress"],
         "frame":{"x":0,"y":0,"width":1,"height":1}}]}]}"#;

    fn path() -> Vec<Segment> {
        super::super::segments("AXButton[0]").expect("a ref")
    }

    #[test]
    fn nested_focused_element_is_reported_by_the_fixture_observer() {
        let directory = tempfile::tempdir().expect("tempdir");
        let fixture = scripted(
            directory.path(),
            r#"{"windows":[{"id":9,"title":"Editor","pid":7,"elements":[
                {"role":"AXGroup","frame":{"x":0,"y":0,"width":1,"height":1},
                 "children":[{"role":"AXSecureTextField","secure":true,"focused":true,
                   "frame":{"x":0,"y":0,"width":1,"height":1}}]}]}]}"#,
        );
        assert_eq!(
            fixture.focused(&window()),
            Ok(Some(Focused {
                role: "AXSecureTextField".into(),
                secure: true,
            }))
        );
    }

    #[test]
    fn a_missing_or_malformed_layout_fails_every_read() {
        let directory = tempfile::tempdir().expect("tempdir");
        let missing = Scripted {
            layout: directory.path().join("absent.json"),
            recorder: directory.path().join("recorder.jsonl"),
        };
        assert!(matches!(missing.windows(), Err(Fault::Failed(_))));
        let malformed = scripted(directory.path(), "{");
        assert!(matches!(malformed.windows(), Err(Fault::Failed(_))));
        let bounds = Bounds {
            max_elements: 10,
            max_visits: 10,
            budget: std::time::Duration::from_secs(5),
        };
        assert!(matches!(
            malformed.walk(&window(), &bounds),
            Err(Fault::Failed(_))
        ));
        assert!(matches!(
            malformed.act(&window(), &path(), &|_| true, &Action::Press),
            Err(ActFault::Failed(_))
        ));
        assert!(!directory.path().join("recorder.jsonl").exists());
    }

    #[test]
    fn an_unadmitted_element_or_an_unwritable_recorder_injects_nothing() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut fixture = scripted(directory.path(), LAYOUT);
        assert_eq!(
            fixture.act(&window(), &path(), &|_| false, &Action::Press),
            Err(ActFault::NotFound)
        );
        assert!(!fixture.recorder.exists());
        fixture.recorder = directory.path().to_path_buf();
        assert!(matches!(
            fixture.act(&window(), &path(), &|_| true, &Action::Press),
            Err(ActFault::Failed(_))
        ));
        let entries = fs::read_dir(directory.path()).expect("list").count();
        assert_eq!(entries, 1, "only the layout exists");
    }

    #[test]
    fn a_rejected_dispatch_guard_records_no_action() {
        let directory = tempfile::tempdir().expect("tempdir");
        let fixture = scripted(directory.path(), LAYOUT);

        assert_eq!(
            fixture.act_guarded(&window(), &path(), &|_| true, &Action::Press, &|| false),
            Err(ActFault::NotFound)
        );
        assert!(!fixture.recorder.exists());
    }

    #[test]
    fn supported_actions_record_their_argument_and_others_refuse() {
        let directory = tempfile::tempdir().expect("tempdir");
        let fixture = scripted(
            directory.path(),
            r#"{"windows":[{"id":9,"title":"Editor","pid":7,"elements":[
                {"role":"AXButton","label":"OK","value":"a","actions":["AXShowMenu"],
                 "frame":{"x":0,"y":0,"width":1,"height":1}}]}]}"#,
        );
        let act = |action: &Action| fixture.act(&window(), &path(), &|_| true, action);
        assert_eq!(act(&Action::Press), Err(ActFault::Unsupported));
        assert_eq!(
            act(&Action::Perform("AXRaise".into())),
            Err(ActFault::Unsupported)
        );
        assert_eq!(act(&Action::SetValue("b".into())), Ok(()));
        assert_eq!(act(&Action::Perform("AXShowMenu".into())), Ok(()));
        let recorded = fs::read_to_string(&fixture.recorder).expect("recorder");
        let lines: Vec<serde_json::Value> = recorded
            .lines()
            .map(|line| serde_json::from_str(line).expect("a json line"))
            .collect();
        assert_eq!(
            lines,
            [
                json!({"kind": "action", "pid": 7, "windowId": 9, "ref": "AXButton[0]", "action": "setValue", "value": "b"}),
                json!({"kind": "action", "pid": 7, "windowId": 9, "ref": "AXButton[0]", "action": "perform", "name": "AXShowMenu"}),
            ]
        );
    }
}

#[cfg(test)]
#[path = "fixture/tests.rs"]
mod settle_tests;
