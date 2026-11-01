//! The headless observer: the `elements` trees of the fixture layout's
//! windows, re-read from the layout file on every call so a test can
//! rewrite it to move, replace or recreate a window (a changed `epoch`
//! token is a recreation). A row is observable when it names `pid`; its
//! `app` defaults to `/fixture/<pid>` without a bundle id. Actions land as
//! `kind: "action"` recorder lines.

use std::{
    collections::HashMap,
    fs,
    marker::PhantomData,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    assemble, attribute_fault, resolve, target, walk, ActFault, Action, Admit, AppIdentity,
    AttributeFault, Attributes, Bounds, Frame, Hit, Observer, Raw, Segment, Surface, SurfaceKind,
    Tree, Walk, WindowIdentity, ATTRIBUTES,
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
    id: Option<String>,
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
    #[serde(default)]
    faults: HashMap<String, i32>,
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
    #[serde(default = "default_extent")]
    width: i64,
    #[serde(default = "default_extent")]
    height: i64,
    #[serde(default)]
    epoch: u64,
    #[serde(default)]
    elements: Vec<Element>,
    #[serde(default, rename = "focusError")]
    focus_error: bool,
    #[serde(default)]
    minimized: bool,
    kind: Option<FixtureKind>,
    parent: Option<u32>,
    #[serde(default)]
    timeline: Vec<Timeline>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum FixtureKind {
    Menu,
    Sheet,
    Popover,
    Alert,
}

impl From<FixtureKind> for SurfaceKind {
    fn from(kind: FixtureKind) -> Self {
        match kind {
            FixtureKind::Menu => Self::Menu,
            FixtureKind::Sheet => Self::Sheet,
            FixtureKind::Popover => Self::Popover,
            FixtureKind::Alert => Self::Alert,
        }
    }
}
fn default_extent() -> i64 {
    1024
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
        let values = [
            Raw::Text(item.role.clone()),
            Raw::Text(if item.secure { "AXSecureTextField" } else { "" }.into()),
            Raw::Other,
            item.label.clone().map_or(Raw::Other, Raw::Text),
            item.value.clone().map_or(Raw::Other, Raw::Text),
            Raw::Point(item.frame.x as f64, item.frame.y as f64),
            Raw::Size(item.frame.width as f64, item.frame.height as f64),
            item.enabled.map_or(Raw::Other, Raw::Flag),
            item.selected.map_or(Raw::Other, Raw::Flag),
            item.expanded.map_or(Raw::Other, Raw::Flag),
            Raw::Flag(item.focused),
            Raw::Items(item.children.iter().collect()),
            item.id.clone().map_or(Raw::Other, Raw::Text),
        ];
        let values = ATTRIBUTES
            .iter()
            .zip(values)
            .map(|(name, value)| {
                item.faults
                    .get(*name)
                    .map_or(value, |code| Raw::Error(*code))
            })
            .collect();
        let (mut attributes, children) = assemble(values, Ok(item.actions.clone()), (0.0, 0.0))?;
        attributes.checked = match item.faults.get("AXChecked") {
            Some(code) => match attribute_fault(*code)? {
                AttributeFault::Absent => None,
                AttributeFault::Unknown => Some(None),
            },
            None => item.checked.map(Some),
        };
        Ok((attributes, children))
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
    fn window_size(&self, window: &WindowIdentity) -> Result<(i64, i64), Fault> {
        let row = self.row(window)?;
        Ok((row.width, row.height))
    }

    fn hit_test(
        &self,
        window: &WindowIdentity,
        path: &[Segment],
        point: (i64, i64),
    ) -> Result<Hit, Fault> {
        let rows = self.rows()?;
        let Some(row) = rows
            .iter()
            .filter(|row| row.kind.is_some())
            .chain(rows.iter().filter(|row| row.kind.is_none()))
            .find(|row| {
                point.0 >= row.x
                    && point.0 < row.x + row.width
                    && point.1 >= row.y
                    && point.1 < row.y + row.height
            })
        else {
            return Ok(Hit::Occluded);
        };
        if row.id != window.window_id || row.pid != Some(window.pid) {
            return Ok(Hit::Occluded);
        }
        let target = resolve(&Rows(PhantomData), row.elements.iter().collect(), path)?
            .map(|(element, _)| element);
        let Some(target) = target else {
            return Err(Fault::WindowNotFound);
        };
        fn deepest(elements: &[Element], point: (i64, i64)) -> Option<&Element> {
            elements.iter().rev().find_map(|element| {
                let frame = element.frame;
                let inside = point.0 >= frame.x
                    && point.0 < frame.x + frame.width
                    && point.1 >= frame.y
                    && point.1 < frame.y + frame.height;
                inside.then(|| deepest(&element.children, point).unwrap_or(element))
            })
        }
        fn contains(root: &Element, found: &Element) -> bool {
            std::ptr::eq(root, found) || root.children.iter().any(|child| contains(child, found))
        }
        let local = (point.0 - row.x, point.1 - row.y);
        Ok(
            if deepest(&row.elements, local).is_some_and(|found| contains(target, found)) {
                Hit::Target
            } else {
                Hit::Covered
            },
        )
    }

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
        let row = self.row(window)?;
        if row.focus_error {
            return Err(Fault::Permission);
        }
        Ok(find(&row.elements))
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
                    surface: row.kind.map(|kind| Surface {
                        kind: kind.into(),
                        parent: row.parent,
                        frame: Frame {
                            x: row.x,
                            y: row.y,
                            width: row.width,
                            height: row.height,
                        },
                    }),
                })
            })
            .collect())
    }

    fn walk(&self, window: &WindowIdentity, bounds: &Bounds) -> Result<Walk, Fault> {
        let row = self.row(window)?;
        walk(&Rows(PhantomData), row.elements.iter().collect(), bounds)
    }

    fn resolve(
        &self,
        window: &WindowIdentity,
        path: &[Segment],
    ) -> Result<Option<Attributes>, Fault> {
        let row = self.row(window)?;
        resolve(&Rows(PhantomData), row.elements.iter().collect(), path)
            .map(|found| found.map(|(_, attributes)| attributes))
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
        if let Some(id) = &element.id {
            line["id"] = json!(id);
        }
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
            surface: None,
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

    fn observe_fault(attribute: &str, code: i32) -> Value {
        let directory = tempfile::tempdir().expect("tempdir");
        let layout = json!({"windows":[{"id":9,"title":"Editor","pid":7,"elements":[
        {"role":"AXGroup","frame":{"x":0,"y":0,"width":10,"height":10},
         "children":[
            {"role":"AXButton","label":"Faulted","enabled":true,
             "frame":{"x":0,"y":0,"width":1,"height":1},
             "children":[{"role":"AXTextField",
                "frame":{"x":0,"y":0,"width":1,"height":1}}]},
            {"role":"AXButton","label":"Sibling",
             "frame":{"x":1,"y":0,"width":1,"height":1}}
        ]}]}]});
        let mut layout = layout;
        layout["windows"][0]["elements"][0]["children"][0]["faults"] = json!({attribute: code});
        let fixture = scripted(directory.path(), &layout.to_string());
        let request = observe::Request {
            target: observe::Target {
                pid: 7,
                window_id: 9,
                epoch: Some(0),
            },
            since: None,
            max_elements: 2000,
        };
        observe::Observations::default()
            .observe(&fixture, &request, |_| Ok(None))
            .unwrap_or_else(|refusal| refusal.observed())
    }

    #[test]
    fn transient_flag_fault_preserves_observation_with_explicit_unknown() {
        let observed = observe_fault("AXEnabled", -25204);
        assert_eq!(observed["status"], "ok");
        assert_eq!(observed["elements"][1]["enabled"], Value::Null);
        assert!(observed["elements"][1].get("selected").is_none());
        assert_eq!(observed["elements"][3]["ref"], "AXGroup[0]/AXButton[1]");
        assert_eq!(observed["elements"].as_array().expect("elements").len(), 4);
    }

    #[test]
    fn checked_fault_distinguishes_missing_and_unknown() {
        let unknown = observe_fault("AXChecked", -25204);
        assert_eq!(unknown["status"], "ok");
        assert_eq!(unknown["elements"][1]["checked"], Value::Null);
        let absent = observe_fault("AXChecked", -25212);
        assert!(absent["elements"][1].get("checked").is_none());
    }

    #[test]
    fn transient_children_fault_keeps_siblings_and_complete_census() {
        let observed = observe_fault("AXChildren", -25202);
        assert_eq!(observed["status"], "ok");
        assert_eq!(observed["complete"], true);
        assert_eq!(observed["elements"][1]["children"], Value::Null);
        assert_eq!(observed["elements"][2]["ref"], "AXGroup[0]/AXButton[1]");
        assert_eq!(observed["elements"].as_array().expect("elements").len(), 3);
    }

    #[test]
    fn transient_role_fault_keeps_unaddressable_subtree() {
        let observed = observe_fault("AXRole", -25201);
        assert_eq!(observed["status"], "ok");
        assert_eq!(observed["elements"][1]["role"], "");
        assert_eq!(observed["elements"][1]["ref"], Value::Null);
        assert_eq!(observed["elements"][2]["role"], "AXTextField");
        assert_eq!(observed["elements"][2]["ref"], Value::Null);
        assert_eq!(observed["elements"][3]["ref"], "AXGroup[0]/AXButton[0]");
    }

    #[test]
    fn disabled_api_fault_refuses_entire_observation() {
        let observed = observe_fault("AXEnabled", -25211);
        assert_eq!(observed["status"], "refused");
        assert_eq!(observed["reason"], "permission_denied");
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
    fn focus_query_failure_is_distinct_from_an_absent_element() {
        let directory = tempfile::tempdir().expect("tempdir");
        let fixture = scripted(directory.path(), LAYOUT);
        assert_eq!(fixture.focused(&window()), Ok(None));
        let mut layout: Value = serde_json::from_str(LAYOUT).expect("layout");
        layout["windows"][0]["focusError"] = json!(true);
        fs::write(&fixture.layout, layout.to_string()).expect("failed focus");
        assert_eq!(fixture.focused(&window()), Err(Fault::Permission));
        assert_eq!(fixture.windows().expect("windows").len(), 1);
    }

    #[test]
    fn hit_test_refuses_a_missing_path_and_an_occluding_window() {
        let directory = tempfile::tempdir().expect("tempdir");
        let fixture = scripted(directory.path(), LAYOUT);
        let missing = super::super::segments("AXButton[1]").expect("missing path");
        assert_eq!(
            fixture.hit_test(&window(), &missing, (0, 0)),
            Err(Fault::WindowNotFound)
        );
        assert_eq!(
            fixture.hit_test(&window(), &path(), (2048, 2048)),
            Ok(Hit::Occluded)
        );
        assert_eq!(
            fixture.hit_test(&window(), &path(), (9, 9)),
            Ok(Hit::Covered)
        );
        let overlay = json!({"windows": [
            {"id": 10, "title": "Overlay", "pid": 8},
            {"id": 9, "title": "Editor", "pid": 7, "elements": [{
                "role": "AXButton", "actions": ["AXPress"],
                "frame": {"x": 0, "y": 0, "width": 1, "height": 1}
            }]}
        ]});
        fs::write(&fixture.layout, overlay.to_string()).expect("overlay");
        assert_eq!(
            fixture.hit_test(&window(), &path(), (0, 0)),
            Ok(Hit::Occluded)
        );
        let nested = json!({"windows":[{"id":9,"title":"Editor","pid":7,"elements":[
            {"role":"AXGroup","frame":{"x":0,"y":0,"width":4,"height":4},
             "children":[{"role":"AXButton","frame":{"x":1,"y":1,"width":2,"height":2}}]}
        ]}]});
        fs::write(&fixture.layout, nested.to_string()).expect("nested layout");
        assert_eq!(
            fixture.hit_test(
                &window(),
                &super::super::segments("AXGroup[0]").expect("group"),
                (2, 2),
            ),
            Ok(Hit::Target)
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

    #[test]
    fn identified_siblings_relocate_in_the_fixture_and_unidentified_siblings_have_no_refs() {
        let directory = tempfile::tempdir().expect("tempdir");
        let elements: Vec<Value> = (0..10)
            .map(|index| {
                json!({
                    "role": "AXRow", "id": format!("row-{index}"), "actions": ["AXPress"],
                    "frame": {"x": index, "y": 0, "width": 1, "height": 1}
                })
            })
            .collect();
        let mut layout = json!({"windows": [{
            "id": 9, "title": "Editor", "pid": 7, "elements": elements
        }]});
        let fixture = scripted(directory.path(), &layout.to_string());
        let observations = observe::Observations::default();
        let request = observe::Request {
            target: observe::Target {
                pid: 7,
                window_id: 9,
                epoch: Some(0),
            },
            since: None,
            max_elements: 2000,
        };
        let observed = observations
            .observe(&fixture, &request, |_| Ok(None))
            .expect("observe");
        for index in 0..10 {
            assert_eq!(
                observed["elements"][index]["ref"],
                format!("AXRow[{index}]")
            );
        }
        let rows = layout["windows"][0]["elements"]
            .as_array_mut()
            .expect("rows");
        rows.swap(0, 1);
        fs::write(&fixture.layout, layout.to_string()).expect("reorder");
        let action = observe::Act {
            target: request.target,
            observation: "o1".into(),
            reference: "AXRow[0]".into(),
            action: Action::Press,
            wait_ms: 0,
        };
        observations
            .act(&fixture, &action)
            .expect("relocated press");
        let recorded = fs::read_to_string(&fixture.recorder).expect("recorded");
        assert_eq!(
            serde_json::from_str::<Value>(recorded.trim()).expect("line"),
            json!({"kind": "action", "pid": 7, "windowId": 9,
                "ref": "AXRow[1]", "id": "row-0", "action": "press"})
        );
        layout["windows"][0]["elements"][1]["id"] = json!("replacement");
        fs::write(&fixture.layout, layout.to_string()).expect("replace");
        assert_eq!(
            observations.act(&fixture, &action),
            Err(observe::Refusal::RefNotFound)
        );
        for row in layout["windows"][0]["elements"]
            .as_array_mut()
            .expect("rows")
        {
            row.as_object_mut().expect("row").remove("id");
        }
        fs::write(&fixture.layout, layout.to_string()).expect("without ids");
        let without = observations
            .observe(&fixture, &request, |_| Ok(None))
            .expect("observe");
        assert!(without["elements"]
            .as_array()
            .expect("elements")
            .iter()
            .all(|element| element["ref"].is_null()));
        let unaddressable = observe::Act {
            observation: "o2".into(),
            ..action
        };
        assert_eq!(
            observations.act(&fixture, &unaddressable),
            Err(observe::Refusal::RefNotFound)
        );
    }

    #[test]
    fn blocked_fixture_elements_refuse_without_recording_an_action() {
        let directory = tempfile::tempdir().expect("tempdir");
        let layout = json!({"windows": [{
            "id": 9, "title": "Editor", "pid": 7, "width": 12, "height": 12,
            "elements": [
                {"role": "AXButton", "id": "disabled", "actions": ["AXPress"],
                 "enabled": false, "frame": {"x": 1, "y": 1, "width": 2, "height": 2}},
                {"role": "AXButton", "id": "zero", "actions": ["AXPress"],
                 "frame": {"x": 1, "y": 1, "width": 0, "height": 2}},
                {"role": "AXButton", "id": "outside", "actions": ["AXPress"],
                 "frame": {"x": 20, "y": 1, "width": 2, "height": 2}},
                {"role": "AXButton", "id": "covered", "actions": ["AXPress"],
                 "frame": {"x": 1, "y": 1, "width": 2, "height": 2}},
                {"role": "AXGroup", "frame": {"x": 1, "y": 1, "width": 2, "height": 2}}
            ]
        }]});
        let fixture = scripted(directory.path(), &layout.to_string());
        let observations = observe::Observations::default();
        let target = observe::Target {
            pid: 7,
            window_id: 9,
            epoch: Some(0),
        };
        let request = observe::Request {
            target,
            since: None,
            max_elements: 2000,
        };
        observations
            .observe(&fixture, &request, |_| Ok(None))
            .expect("observe");
        for (index, blocker) in ["disabled", "zero_size", "off_window", "covered"]
            .iter()
            .enumerate()
        {
            let act = observe::Act {
                target,
                observation: "o1".into(),
                reference: format!("AXButton[{index}]"),
                action: Action::Press,
                wait_ms: 0,
            };
            assert_eq!(
                observations.act(&fixture, &act),
                Err(observe::Refusal::NotActionable(blocker))
            );
            assert!(!fixture.recorder.exists());
        }
    }

    struct RewriteTick {
        layout: PathBuf,
        enabled: Value,
        now: Instant,
        fixture: Scripted,
    }

    impl Subscription for RewriteTick {
        fn now(&self) -> Instant {
            self.now
        }
        fn receive_until(&mut self, deadline: Instant) -> Option<(Instant, Notification)> {
            self.now = deadline;
            fs::write(&self.layout, self.enabled.to_string()).expect("layout rewrite");
            None
        }
        fn sample(&mut self, _: Instant) -> Result<Sample, observe::Refusal> {
            let window = self
                .fixture
                .windows()
                .map_err(observe::Refusal::from)?
                .into_iter()
                .next()
                .expect("fixture window");
            let bounds = Bounds {
                max_elements: 2000,
                max_visits: 5000,
                budget: observe::BUDGET,
            };
            Ok(Sample {
                windows: vec![window.clone()],
                walk: self
                    .fixture
                    .walk(&window, &bounds)
                    .map_err(observe::Refusal::from)?,
                private: false,
            })
        }
        fn commit_if_current(&mut self, _: Box<dyn FnOnce() -> Value + '_>) -> Option<Value> {
            None
        }
    }

    #[test]
    fn layout_rewrite_enables_a_waiting_fixture_action_without_waiting_for_wall_clock() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut layout = json!({"windows": [{
            "id": 9, "title": "Editor", "pid": 7,
            "elements": [{
                "role": "AXButton", "id": "submit", "enabled": false, "actions": ["AXPress"],
                "frame": {"x": 1, "y": 1, "width": 2, "height": 2}
            }]
        }]});
        let fixture = scripted(directory.path(), &layout.to_string());
        let observations = observe::Observations::default();
        let target = observe::Target {
            pid: 7,
            window_id: 9,
            epoch: Some(0),
        };
        observations
            .observe(
                &fixture,
                &observe::Request {
                    target,
                    since: None,
                    max_elements: 2000,
                },
                |_| Ok(None),
            )
            .expect("observe");
        let mut action = observe::Act {
            target,
            observation: "o1".into(),
            reference: "AXButton[0]".into(),
            action: Action::Press,
            wait_ms: 0,
        };
        assert_eq!(
            observations.act(&fixture, &action),
            Err(observe::Refusal::NotActionable("disabled"))
        );
        assert!(!fixture.recorder.exists());
        layout["windows"][0]["elements"][0]["enabled"] = json!(true);
        action.wait_ms = 2000;
        assert_eq!(
            observations.act_waiting(&fixture, &action, &|| true, &|start, _, _| {
                let mut tick = RewriteTick {
                    layout: fixture.layout.clone(),
                    enabled: layout.clone(),
                    now: start,
                    fixture: Scripted {
                        layout: fixture.layout.clone(),
                        recorder: fixture.recorder.clone(),
                    },
                };
                assert_eq!(
                    tick.commit_if_current(Box::new(|| panic!("uncommitted sample"))),
                    None
                );
                Some(Box::new(tick))
            }),
            Ok(())
        );
        let recorded = fs::read_to_string(&fixture.recorder).expect("action");
        assert_eq!(recorded.lines().count(), 1);
    }

    #[test]
    fn another_window_covering_the_center_refuses_occluded() {
        let directory = tempfile::tempdir().expect("tempdir");
        let fixture = scripted(
            directory.path(),
            &json!({"windows": [
                {"id": 10, "title": "Overlay", "pid": 8, "width": 10, "height": 10},
                {"id": 9, "title": "Editor", "pid": 7, "width": 10, "height": 10,
                 "elements": [{
                     "role": "AXButton", "actions": ["AXPress"],
                     "frame": {"x": 1, "y": 1, "width": 2, "height": 2}
                 }]}
            ]})
            .to_string(),
        );
        let observations = observe::Observations::default();
        let target = observe::Target {
            pid: 7,
            window_id: 9,
            epoch: Some(0),
        };
        observations
            .observe(
                &fixture,
                &observe::Request {
                    target,
                    since: None,
                    max_elements: 2000,
                },
                |_| Ok(None),
            )
            .expect("observe");
        let action = observe::Act {
            target,
            observation: "o1".into(),
            reference: "AXButton[0]".into(),
            action: Action::Press,
            wait_ms: 0,
        };
        assert_eq!(
            observations.act(&fixture, &action),
            Err(observe::Refusal::NotActionable("occluded"))
        );
        assert!(!fixture.recorder.exists());
    }
}

#[cfg(test)]
#[path = "fixture/tests.rs"]
mod settle_tests;
