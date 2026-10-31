use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, Weak};

use serde_json::json;

use super::*;
use crate::screen::ax::AppIdentity;

type WindowReads = Arc<Mutex<VecDeque<Result<Vec<WindowIdentity>, Fault>>>>;

struct Fake {
    windows: Mutex<Result<Vec<WindowIdentity>, Fault>>,
    window_reads: WindowReads,
    walk: Arc<Mutex<Vec<Node>>>,
    walk_fault: Mutex<Option<Fault>>,
    focus_fault: Mutex<Option<Fault>>,
    act_fault: Mutex<Option<ActFault>>,
    acted: Mutex<Vec<(String, Action)>>,
    /// Nodes the window holds once a fresh walk passed, before dispatch.
    swap: Mutex<Option<Vec<Node>>>,
    /// Holds window 9's walk: signals entry, then waits for release.
    hold: Mutex<Option<(Sender<()>, Receiver<()>)>>,
    walks: AtomicUsize,
    resolves: AtomicUsize,
    missing_size: std::sync::atomic::AtomicBool,
    forget_on_walk: Arc<Mutex<Option<Weak<Screen>>>>,
}

impl Fake {
    fn new(nodes: Vec<Node>) -> Self {
        Self {
            windows: Mutex::new(Ok(vec![window(0)])),
            window_reads: Arc::new(Mutex::new(VecDeque::new())),
            walk: Arc::new(Mutex::new(nodes)),
            walk_fault: Mutex::new(None),
            focus_fault: Mutex::new(None),
            act_fault: Mutex::new(None),
            acted: Mutex::new(Vec::new()),
            swap: Mutex::new(None),
            hold: Mutex::new(None),
            walks: AtomicUsize::new(0),
            resolves: AtomicUsize::new(0),
            missing_size: std::sync::atomic::AtomicBool::new(false),
            forget_on_walk: Arc::new(Mutex::new(None)),
        }
    }
}

/// The node `path` names, by the same role-index steps a backend resolves.
fn resolve<'a>(nodes: &'a [Node], path: &str) -> Option<&'a Node> {
    let mut paths: Vec<String> = Vec::new();
    let mut counts: HashMap<(Option<usize>, String), usize> = HashMap::new();
    for node in nodes {
        let role = ax::slug(&node.attributes.role);
        let count = counts.entry((node.parent, role.clone())).or_default();
        let segment = format!("{role}[{count}]");
        *count += 1;
        paths.push(match node.parent {
            Some(parent) => format!("{}/{segment}", paths[parent]),
            None => segment,
        });
    }
    nodes
        .iter()
        .zip(&paths)
        .find(|(_, at)| *at == path)
        .map(|(node, _)| node)
}

impl Observer for Fake {
    fn window_size(&self, _: &WindowIdentity) -> Result<(i64, i64), Fault> {
        if self.missing_size.load(Ordering::SeqCst) {
            Err(Fault::Absent)
        } else {
            Ok((1024, 1024))
        }
    }
    fn hit_test(&self, _: &WindowIdentity, _: &[Segment], _: (i64, i64)) -> Result<Hit, Fault> {
        Ok(Hit::Target)
    }
    fn focused(
        &self,
        _: &WindowIdentity,
    ) -> Result<Option<crate::screen::private::Focused>, Fault> {
        if let Some(fault) = self.focus_fault.lock().expect("lock").clone() {
            return Err(fault);
        }
        let nodes = self.walk.lock().expect("lock");
        Ok(nodes
            .iter()
            .find(|node| node.attributes.focused)
            .map(|node| crate::screen::private::Focused {
                role: node.attributes.role.clone(),
                secure: node.attributes.secure,
            })
            .or_else(|| {
                Some(crate::screen::private::Focused {
                    role: "AXWindow".into(),
                    secure: false,
                })
            }))
    }
    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
        if let Some(next) = self.window_reads.lock().expect("lock").pop_front() {
            return next;
        }
        self.windows.lock().expect("lock").clone()
    }

    fn walk(&self, window: &WindowIdentity, bounds: &Bounds) -> Result<Walk, Fault> {
        self.walks.fetch_add(1, Ordering::SeqCst);
        if let Some(screen) = self
            .forget_on_walk
            .lock()
            .expect("lock")
            .as_ref()
            .and_then(Weak::upgrade)
        {
            screen.forget();
        }
        if window.window_id == 9 {
            if let Some((entered, release)) = self.hold.lock().expect("lock").take() {
                entered.send(()).expect("entered");
                release.recv().expect("released");
            }
        }
        if let Some(fault) = self.walk_fault.lock().expect("lock").clone() {
            return Err(fault);
        }
        let mut nodes = self.walk.lock().expect("lock").clone();
        let complete = nodes.len() <= bounds.max_elements;
        nodes.truncate(bounds.max_elements);
        let focused = nodes.iter().position(|node| node.attributes.focused);
        Ok(Walk {
            nodes,
            focused,
            complete,
        })
    }

    fn resolve(&self, _: &WindowIdentity, path: &[Segment]) -> Result<Option<Attributes>, Fault> {
        self.resolves.fetch_add(1, Ordering::SeqCst);
        let path = path
            .iter()
            .map(Segment::to_string)
            .collect::<Vec<_>>()
            .join("/");
        let nodes = self.walk.lock().expect("lock");
        Ok(resolve(&nodes, &path).map(|node| node.attributes.clone()))
    }

    fn act(
        &self,
        window: &WindowIdentity,
        path: &[Segment],
        admit: ax::Admit<'_>,
        action: &Action,
    ) -> Result<(), ActFault> {
        self.act_guarded(window, path, admit, action, &|| true)
    }

    fn act_guarded(
        &self,
        _: &WindowIdentity,
        path: &[Segment],
        admit: ax::Admit<'_>,
        action: &Action,
        before_dispatch: &dyn Fn() -> bool,
    ) -> Result<(), ActFault> {
        if let Some(fault) = self.act_fault.lock().expect("lock").clone() {
            return Err(fault);
        }
        if let Some(nodes) = self.swap.lock().expect("lock").take() {
            *self.walk.lock().expect("lock") = nodes;
        }
        let path: Vec<String> = path.iter().map(Segment::to_string).collect();
        let path = path.join("/");
        let nodes = self.walk.lock().expect("lock").clone();
        self.resolves.fetch_add(1, Ordering::SeqCst);
        let found = resolve(&nodes, &path).ok_or(ActFault::NotFound)?;
        if !admit(&found.attributes) {
            return Err(ActFault::NotFound);
        }
        if !before_dispatch() {
            return Err(ActFault::NotFound);
        }
        let label = found.attributes.label.clone().unwrap_or_default();
        self.acted
            .lock()
            .expect("lock")
            .push((format!("{path} {label}"), action.clone()));
        Ok(())
    }
}

#[test]
fn unreadable_focus_returns_empty_private_observation_without_tree_walk() {
    let fake = Fake::new(tree());
    *fake.focus_fault.lock().expect("lock") = Some(Fault::Permission);
    *fake.walk_fault.lock().expect("lock") = Some(Fault::Failed("walk must not run".into()));
    let observations = Observations::default();
    let result = observe(&observations, &fake, None);
    assert_eq!(result["status"], "ok");
    assert_eq!(result["private"], true);
    assert_eq!(result["elements"], json!([]));
}

#[test]
fn private_observation_issues_no_refs_for_actions() {
    let fake = Fake::new(tree());
    fake.walk.lock().expect("lock")[3].attributes.secure = true;
    let observations = Observations::default();
    let result = observe(&observations, &fake, None);
    assert_eq!(result["private"], true);
    assert_eq!(result["elements"], json!([]));
    assert_eq!(
        observations.act(&fake, &act("o1", "AXButton[0]", Action::Press)),
        Err(Refusal::Private)
    );
    assert!(fake.acted.lock().expect("lock").is_empty());
}

#[test]
fn empty_accessibility_window_set_is_private_for_input() {
    let fake = Fake::new(tree());
    *fake.windows.lock().expect("lock") = Ok(Vec::new());
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(32, 16, 1.0)),
        1,
    )
    .observing(Box::new(fake));
    assert_eq!(screen.input_private(None), Ok(true));
}

#[test]
fn ambiguous_pointer_targets_fail_closed() {
    let fake = Fake::new(tree());
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(32, 16, 1.0)),
        1,
    )
    .observing(Box::new(fake));
    assert_eq!(screen.input_private(Some((-1, -1))), Ok(true));
    let fake = Fake::new(tree());
    let window = crate::screen::Window {
        id: 9,
        display: 1,
        title: "Editor".into(),
        owner: "fixture".into(),
        pid: Some(7),
        app: None,
        x: 0,
        y: 0,
        width: 16,
        height: 16,
    };
    let source = crate::screen::fixture::Fixture {
        windows: vec![window.clone(), crate::screen::Window { id: 10, ..window }],
        ..crate::screen::fixture::Fixture::display(32, 16, 1.0)
    };
    let screen = Screen::new(Box::new(source), 1).observing(Box::new(fake));
    assert_eq!(screen.input_private(Some((4, 4))), Ok(true));
}

#[test]
fn pointer_hit_test_uses_captured_window_size_when_observer_cannot_measure_it() {
    let fake = Fake::new(tree());
    fake.missing_size.store(true, Ordering::SeqCst);
    let window = crate::screen::Window {
        id: 9,
        display: 1,
        title: "Editor".into(),
        owner: "fixture".into(),
        pid: Some(7),
        app: None,
        x: 100,
        y: 50,
        width: 16,
        height: 16,
    };
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture {
            windows: vec![window],
            ..crate::screen::fixture::Fixture::display(256, 128, 1.0)
        }),
        1,
    )
    .observing(Box::new(fake));
    assert_eq!(screen.pointer_at(104, 54), Some((7, 9)));
    assert_eq!(screen.pointer_at(120, 54), None);
}

#[test]
fn private_edges_track_enter_and_leave_with_the_window_epoch() {
    let fake = Fake::new(tree());
    let walk = Arc::clone(&fake.walk);
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(32, 16, 1.0)),
        1,
    )
    .observing(Box::new(fake));
    assert_eq!(screen.private_edges(), Ok(vec![]));
    walk.lock().expect("walk")[3].attributes.secure = true;
    let target = Target {
        pid: 7,
        window_id: 9,
        epoch: Some(0),
    };
    assert_eq!(
        screen.private_edges(),
        Ok(vec![(target, crate::screen::private::Edge::Entered)])
    );
    assert_eq!(screen.private_edges(), Ok(vec![]));
    walk.lock().expect("walk")[3].attributes.secure = false;
    assert_eq!(
        screen.private_edges(),
        Ok(vec![(target, crate::screen::private::Edge::Left)])
    );
}

#[test]
fn capture_guard_defers_to_capture_permission_when_observation_is_denied() {
    let fake = Fake::new(tree());
    *fake.windows.lock().expect("lock") = Err(Fault::Permission);
    let source = crate::screen::fixture::Fixture {
        windows: vec![crate::screen::Window {
            id: 9,
            display: 1,
            title: "Editor".into(),
            owner: "fixture".into(),
            pid: Some(7),
            app: None,
            x: 0,
            y: 0,
            width: 16,
            height: 16,
        }],
        ..crate::screen::fixture::Fixture::display(32, 16, 1.0)
    };
    let screen = Screen::new(Box::new(source), 1).observing(Box::new(fake));
    assert_eq!(screen.capture_guard(9), Ok(()));
}

#[test]
fn capture_guard_refuses_excluded_and_minimized_windows() {
    let fake = Fake::new(tree());
    let screen = Screen::absent()
        .observing(Box::new(fake))
        .excluding(vec!["com.example.editor".into()]);
    assert_eq!(screen.capture_guard(9), Err(Fault::OwnWindow));

    let fake = Fake::new(tree());
    let mut minimized = window(0);
    minimized.minimized = true;
    *fake.windows.lock().expect("lock") = Ok(vec![minimized]);
    let screen = Screen::absent().observing(Box::new(fake));
    assert_eq!(screen.capture_guard(9), Err(Fault::WindowMinimized));
}

#[test]
fn window_capture_without_an_observer_uses_the_capture_source() {
    let source = crate::screen::fixture::Fixture {
        windows: vec![crate::screen::Window {
            id: 9,
            display: 1,
            title: "Editor".into(),
            owner: "fixture".into(),
            pid: Some(7),
            app: None,
            x: 0,
            y: 0,
            width: 16,
            height: 16,
        }],
        ..crate::screen::fixture::Fixture::display(32, 16, 1.0)
    };
    let screen = Screen::new(Box::new(source), 1);
    let encoding = crate::screen::encode::Encoding {
        format: crate::screen::encode::Format::Png,
        quality: 0,
        max_bytes: crate::screen::MAX_BYTES,
        max_dimension: crate::screen::MAX_DIMENSION,
    };
    assert_eq!(
        screen.shoot(
            &crate::screen::Target::Window("9".into()),
            &encoding,
            |_| json!("captured")
        ),
        Ok(json!("captured"))
    );
}

#[test]
fn window_capture_guard_propagates_observer_failure() {
    let fake = Fake::new(tree());
    *fake.windows.lock().expect("lock") = Err(Fault::Failed("observer unavailable".into()));
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(32, 16, 1.0)),
        1,
    )
    .observing(Box::new(fake));
    let encoding = crate::screen::encode::Encoding {
        format: crate::screen::encode::Format::Png,
        quality: 0,
        max_bytes: crate::screen::MAX_BYTES,
        max_dimension: crate::screen::MAX_DIMENSION,
    };
    assert_eq!(
        screen.shoot(
            &crate::screen::Target::Window("9".into()),
            &encoding,
            |_| json!("captured")
        ),
        Err(Fault::Failed("observer unavailable".into()))
    );
}

#[test]
fn display_capture_and_stream_propagate_mask_observer_failure() {
    let fake = Fake::new(tree());
    *fake.windows.lock().expect("lock") = Err(Fault::Failed("observer unavailable".into()));
    let source = crate::screen::fixture::Fixture {
        windows: vec![crate::screen::Window {
            id: 9,
            display: 1,
            title: "Editor".into(),
            owner: "fixture".into(),
            pid: Some(7),
            app: None,
            x: 0,
            y: 0,
            width: 16,
            height: 16,
        }],
        ..crate::screen::fixture::Fixture::display(32, 16, 1.0)
    };
    let screen = Screen::new(Box::new(source), 1).observing(Box::new(fake));
    let request: oni_protocol::ScreenCaptureRequest = oni_protocol::decode(json!({
        "target":{"kind":"display","display":1},"encoding":{"format":"png"}
    }))
    .expect("capture");
    let result = screen.capture(&request);
    assert_eq!(result["reason"], "capture_failed");
    assert_eq!(result["message"], "observer unavailable");

    let source = serde_json::from_value(json!({"kind":"display","display":1})).expect("source");
    let mut frame = Vec::new();
    assert_eq!(
        screen.frame_private(&source, 32, &mut frame),
        Err(Fault::Failed("observer unavailable".into()))
    );
}

#[test]
fn ordinary_stream_frame_is_returned_unmasked() {
    let fake = Fake::new(tree());
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(32, 16, 1.0)),
        1,
    )
    .observing(Box::new(fake));
    let source = serde_json::from_value(json!({"kind":"display","display":1})).expect("source");
    let mut frame = Vec::new();
    let (size, private) = screen
        .frame_private(&source, 32, &mut frame)
        .expect("frame");
    assert_eq!(size, (32, 16));
    assert!(!private);
    assert!(frame.iter().any(|byte| *byte != 0));
}

#[test]
fn display_capture_masks_a_private_window() {
    let fake = Fake::new(tree());
    fake.walk.lock().expect("walk")[3].attributes.secure = true;
    let walk = Arc::clone(&fake.walk);
    let source = crate::screen::fixture::Fixture {
        windows: vec![crate::screen::Window {
            id: 9,
            display: 1,
            title: "Editor".into(),
            owner: "fixture".into(),
            pid: Some(7),
            app: None,
            x: 0,
            y: 0,
            width: 16,
            height: 16,
        }],
        ..crate::screen::fixture::Fixture::display(32, 16, 1.0)
    };
    let screen = Screen::new(Box::new(source), 1).observing(Box::new(fake));
    let request: oni_protocol::ScreenCaptureRequest = oni_protocol::decode(json!({
        "target":{"kind":"display","display":1},"encoding":{"format":"png"}
    }))
    .expect("capture");
    let result = screen.capture(&request);
    assert_eq!(result["status"], "ok");
    walk.lock().expect("walk")[3].attributes.secure = false;
    let ordinary = screen.capture(&request);
    assert_eq!(ordinary["status"], "ok");
    assert_ne!(result["data"], ordinary["data"]);
}

#[test]
fn private_edge_lookup_failure_refuses_before_any_edge() {
    let fake = Fake::new(tree());
    fake.window_reads
        .lock()
        .expect("lock")
        .extend([Ok(vec![window(0)]), Err(Fault::Permission)]);
    let screen = Screen::absent().observing(Box::new(fake));
    assert_eq!(
        screen.private_edges(),
        Err(Fault::Failed("permission_denied".into()))
    );
}

#[test]
fn private_edge_lookup_failure_preserves_prior_edges() {
    let fake = Fake::new(tree());
    *fake.windows.lock().expect("lock") = Ok(vec![window_at(9, 0), window_at(10, 0)]);
    fake.window_reads.lock().expect("lock").extend([
        Ok(vec![window_at(9, 0), window_at(10, 0)]),
        Ok(vec![window_at(9, 0), window_at(10, 0)]),
        Err(Fault::Permission),
    ]);
    fake.walk.lock().expect("lock")[3].attributes.secure = true;
    let screen = Screen::absent().observing(Box::new(fake));
    assert_eq!(
        screen.private_edges(),
        Ok(vec![(
            Target {
                pid: 7,
                window_id: 9,
                epoch: Some(0)
            },
            crate::screen::private::Edge::Entered
        )])
    );
}

#[test]
fn private_focus_blocks_points_but_not_unrelated_ref_actions() {
    let fake = Fake::new(tree());
    let observations = Observations::default();
    let first = observe(&observations, &fake, None);
    assert_eq!(first["private"], false);
    fake.walk.lock().expect("lock")[3].attributes.secure = true;
    assert_eq!(
        observations.act(&fake, &act("o1", "AXButton[0]", Action::Press)),
        Ok(())
    );
    assert_eq!(fake.acted.lock().expect("lock").len(), 1);
    assert_eq!(
        observations.point(&fake, "o1", "AXButton[0]"),
        Err(Refusal::Private)
    );
    assert_eq!(Refusal::Private.reason(), "private");
    assert_eq!(Refusal::Private.observed()["reason"], "observe_failed");
}

#[test]
fn ref_actions_refuse_secure_attributes_and_secure_text_roles() {
    for (role, secure) in [("AXButton", true), ("AXSecureTextField", false)] {
        let mut nodes = tree();
        nodes[0].attributes.role = role.into();
        nodes[0].attributes.secure = secure;
        let fake = Fake::new(nodes);
        let observations = Observations::default();
        let first = observe(&observations, &fake, None);
        assert_eq!(first["private"], false);
        assert_eq!(
            observations.act(&fake, &act("o1", &format!("{role}[0]"), Action::Press)),
            Err(Refusal::Private)
        );
        assert!(fake.acted.lock().expect("lock").is_empty());
    }
}

#[test]
fn target_for_tracks_recreation_and_refuses_missing_window() {
    let fake = Fake::new(tree());
    let observations = Observations::default();
    assert_eq!(
        observations.target_for(&fake, &window(0)),
        Ok(Target {
            pid: 7,
            window_id: 9,
            epoch: Some(0)
        })
    );
    *fake.windows.lock().expect("lock") = Ok(vec![window(1)]);
    assert_eq!(
        observations.target_for(&fake, &window(1)),
        Ok(Target {
            pid: 7,
            window_id: 9,
            epoch: Some(1)
        })
    );
    assert_eq!(
        observations.target_for(&fake, &window_at(10, 0)),
        Err(Refusal::WindowNotFound)
    );
}

#[test]
fn offscreen_observation_reference_refuses_pointing() {
    let mut nodes = tree();
    nodes[0].attributes.frame = Frame {
        x: 1000,
        y: 1000,
        width: 12,
        height: 12,
    };
    let fake = Fake::new(nodes);
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(32, 16, 1.0)),
        1,
    )
    .observing(Box::new(fake));
    let request: ScreenObserveRequest = oni_protocol::decode(json!({
        "target":{"pid":7,"windowId":9},"screenshot":false
    }))
    .expect("request");
    let result = screen.observe(&request);
    let id = result["observationId"].as_str().expect("observation");
    assert!(matches!(
        screen.point(id, "AXButton[0]"),
        Err(Refusal::OffScreen)
    ));
}

#[test]
fn ordinary_observation_includes_a_window_screenshot() {
    let fake = Fake::new(tree());
    let source = crate::screen::fixture::Fixture {
        windows: vec![crate::screen::Window {
            id: 9,
            display: 1,
            title: "Editor".into(),
            owner: "fixture".into(),
            pid: Some(7),
            app: None,
            x: 0,
            y: 0,
            width: 16,
            height: 16,
        }],
        ..crate::screen::fixture::Fixture::display(32, 16, 1.0)
    };
    let screen = Screen::new(Box::new(source), 1).observing(Box::new(fake));
    let request: ScreenObserveRequest = oni_protocol::decode(json!({
        "target":{"pid":7,"windowId":9},"screenshot":true
    }))
    .expect("request");
    let result = screen.observe(&request);
    assert_eq!(result["status"], "ok");
    assert_eq!(result["screenshot"]["format"], "png");
    assert!(result["screenshot"]["data"]
        .as_str()
        .is_some_and(|data| !data.is_empty()));
}

#[test]
fn observation_screenshot_capture_failure_does_not_mint_an_observation() {
    let fake = Fake::new(tree());
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(32, 16, 1.0)),
        1,
    )
    .observing(Box::new(fake));
    let request: ScreenObserveRequest = oni_protocol::decode(json!({
        "target":{"pid":7,"windowId":9},"screenshot":true
    }))
    .expect("request");
    let refused = screen.observe(&request);
    assert_eq!(refused["status"], "refused");
    assert_eq!(refused["reason"], "window_not_found");

    let request: ScreenObserveRequest = oni_protocol::decode(json!({
        "target":{"pid":7,"windowId":9},"screenshot":false
    }))
    .expect("request");
    assert_eq!(screen.observe(&request)["observationId"], "o1");
}

fn window(token: u64) -> WindowIdentity {
    window_at(9, token)
}

fn window_at(window_id: u32, token: u64) -> WindowIdentity {
    WindowIdentity {
        pid: 7,
        window_id,
        owner_pid: 7,
        title: "Editor".into(),
        app: AppIdentity {
            bundle_id: Some("com.example.editor".into()),
            path: "/Applications/Editor.app/Contents/MacOS/Editor".into(),
        },
        token,
        origin: (100, 50),
        minimized: false,
    }
}

fn node(role: &str, label: Option<&str>, parent: Option<usize>) -> Node {
    Node {
        attributes: Attributes {
            role: role.into(),
            label: label.map(Into::into),
            actions: vec!["AXPress".into()],
            frame: Frame {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            },
            ..Attributes::default()
        },
        parent,
    }
}

fn tree() -> Vec<Node> {
    let mut field = node("AXTextField", Some("Name"), None);
    field.attributes.value = Some("ada".into());
    field.attributes.focused = true;
    field.attributes.actions = Vec::new();
    vec![
        node("AXButton", Some("OK"), None),
        node("AXGroup", None, None),
        node("AXCheckBox", Some("Bold"), Some(1)),
        field,
    ]
}

fn request(epoch: Option<u64>, since: Option<&str>) -> Request {
    Request {
        target: Target {
            pid: 7,
            window_id: 9,
            epoch,
        },
        since: since.map(Into::into),
        max_elements: MAX_ELEMENTS,
    }
}

fn act(observation: &str, reference: &str, action: Action) -> Act {
    Act {
        target: request(Some(0), None).target,
        observation: observation.into(),
        reference: reference.into(),
        action,
        wait_ms: 0,
    }
}

fn observe(observations: &Observations, fake: &Fake, since: Option<&str>) -> Value {
    observations
        .observe(fake, &request(None, since), |_| Ok(None))
        .expect("observe")
}

fn shoot(observations: &Observations, fake: &Fake, request: &Request) -> Result<Value, Refusal> {
    observations.observe(fake, request, |_| Ok(None))
}

fn minted(nodes: Vec<Node>, focused: Option<usize>) -> Minted {
    mint(Walk {
        nodes,
        focused,
        complete: true,
    })
}

fn refs(elements: &[Element]) -> Vec<Option<&str>> {
    elements
        .iter()
        .map(|element| element.reference.as_deref())
        .collect()
}

#[test]
fn refusals_map_faults_and_render_both_wire_reasons() {
    let cases = [
        (
            Refusal::NotAvailable,
            "observe_not_available",
            "input_not_available",
        ),
        (
            Refusal::Permission,
            "permission_denied",
            "permission_denied",
        ),
        (
            Refusal::WindowNotFound,
            "window_not_found",
            "window_not_found",
        ),
        (Refusal::EpochChanged, "epoch_changed", "epoch_changed"),
        (Refusal::Stale, "stale_observation", "stale_observation"),
        (Refusal::RefNotFound, "observe_failed", "ref_not_found"),
        (Refusal::OffScreen, "observe_failed", "invalid_region"),
        (
            Refusal::Unsupported,
            "observe_failed",
            "action_not_supported",
        ),
        (Refusal::OffScreen, "observe_failed", "invalid_region"),
        (
            Refusal::Failed(String::new()),
            "observe_failed",
            "input_failed",
        ),
    ];
    for (refusal, observed, acted) in cases {
        assert_eq!(
            refusal.observed(),
            json!({"status": "refused", "reason": observed})
        );
        assert_eq!(
            refusal.acted(),
            json!({"status": "refused", "reason": acted})
        );
    }
    let long = Refusal::Failed("x".repeat(300)).acted();
    assert_eq!(long["message"].as_str().map(str::len), Some(MAX_MESSAGE));

    assert_eq!(Refusal::from(Fault::Absent), Refusal::NotAvailable);
    assert_eq!(Refusal::from(Fault::Permission), Refusal::Permission);
    assert_eq!(
        Refusal::from(Fault::WindowNotFound),
        Refusal::WindowNotFound
    );
    assert_eq!(
        Refusal::from(Fault::Failed("io".into())),
        Refusal::Failed("io".into())
    );
    assert_eq!(
        Refusal::from(Fault::InvalidRegion),
        Refusal::Failed("invalid_region".into())
    );
    assert_eq!(Refusal::from(ActFault::NotFound), Refusal::RefNotFound);
    assert_eq!(Refusal::from(ActFault::Unsupported), Refusal::Unsupported);
    assert_eq!(Refusal::from(ActFault::Permission), Refusal::Permission);
    assert_eq!(
        Refusal::from(ActFault::Failed("ax".into())),
        Refusal::Failed("ax".into())
    );
}

#[test]
fn epochs_bump_on_owner_token_or_reappearance_only() {
    let mut table = EpochTable::default();
    let key = (7, 9);
    table.update(&[window(0)]);
    table.update(&[window(0)]);
    assert_eq!(table.epoch(key), 0);
    table.update(&[window(1)]);
    assert_eq!(table.epoch(key), 1);
    let mut moved = window(1);
    moved.owner_pid = 8;
    table.update(&[moved.clone()]);
    assert_eq!(table.epoch(key), 2);
    table.update(&[]);
    assert_eq!(table.epoch(key), 2);
    table.update(&[moved]);
    assert_eq!(table.epoch(key), 3);
    assert_eq!(table.epoch((1, 1)), 0);
}

#[test]
fn a_full_observation_names_its_lineage_window_and_focus() {
    let fake = Fake::new(tree());
    let observations = Observations::default();
    let body = observations
        .observe(&fake, &request(Some(0), None), |window| {
            Ok(Some(json!({"captureId": "c1", "window": window})))
        })
        .expect("observe");
    assert_eq!(body["observationId"], "o1");
    assert_eq!(body["lineage"], "w7-9-0");
    assert_eq!(body["target"], json!({"pid": 7, "windowId": 9, "epoch": 0}));
    assert_eq!(
        body["window"],
        json!({"pid": 7, "windowId": 9, "epoch": 0, "title": "Editor",
            "app": {"bundleId": "com.example.editor",
            "path": "/Applications/Editor.app/Contents/MacOS/Editor"}})
    );
    assert_eq!(
        (body["complete"].clone(), body["private"].clone()),
        (json!(true), json!(false))
    );
    assert_eq!(body["focused"], "AXTextField[0]");
    assert_eq!(body["screenshot"], json!({"captureId": "c1", "window": 9}));
    let failed = observations.observe(&fake, &request(Some(0), None), |_| {
        Err(Refusal::Failed("shot".into()))
    });
    assert_eq!(failed.err(), Some(Refusal::Failed("shot".into())));
    let next = observe(&observations, &fake, Some("o1"));
    assert_eq!(
        next["observationId"], "o2",
        "a failed observe names nothing"
    );
    assert_eq!(
        body["elements"][2],
        json!({"ref": "AXGroup[0]/AXCheckBox[0]", "role": "AXCheckBox", "label": "Bold",
            "actions": ["AXPress"], "frame": {"x": 0, "y": 0, "width": 1, "height": 1},
            "parent": "AXGroup[0]", "secure": false})
    );
}

#[test]
fn locating_refuses_missing_windows_recreations_and_platform_faults() {
    let fake = Fake::new(tree());
    let observations = Observations::default();
    let mut elsewhere = request(None, None);
    elsewhere.target.window_id = 10;
    assert_eq!(
        shoot(&observations, &fake, &elsewhere).err(),
        Some(Refusal::WindowNotFound)
    );
    assert_eq!(
        shoot(&observations, &fake, &request(Some(1), None)).err(),
        Some(Refusal::EpochChanged)
    );
    *fake.walk_fault.lock().expect("lock") = Some(Fault::Permission);
    assert_eq!(
        shoot(&observations, &fake, &request(None, None)).err(),
        Some(Refusal::Permission)
    );
    *fake.windows.lock().expect("lock") = Err(Fault::Failed("list".into()));
    assert_eq!(
        shoot(&observations, &fake, &request(None, None)).err(),
        Some(Refusal::Failed("list".into()))
    );
}

#[test]
fn since_answers_a_ref_diff_against_the_latest_observation_only() {
    let fake = Fake::new(tree());
    let observations = Observations::default();
    observe(&observations, &fake, None);
    let mut nodes = tree();
    nodes[0].attributes.label = Some("Done".into());
    nodes[0].attributes.focused = true;
    nodes.truncate(3);
    nodes.push(node("AXLink", Some("Help"), None));
    *fake.walk.lock().expect("lock") = nodes;
    let body = observe(&observations, &fake, Some("o1"));
    assert_eq!(body["diff"]["since"], "o1");
    let names = |key: &str| -> Vec<Value> {
        body["diff"][key]
            .as_array()
            .expect("diff list")
            .iter()
            .map(|element| element["ref"].clone())
            .collect()
    };
    assert_eq!(names("added"), vec![json!("AXLink[0]")]);
    assert_eq!(names("changed"), vec![json!("AXButton[0]")]);
    assert_eq!(body["diff"]["removed"], json!(["AXTextField[0]"]));
    assert!(body.get("elements").is_none());
    assert_eq!(
        shoot(&observations, &fake, &request(None, Some("o1"))).err(),
        Some(Refusal::Stale)
    );
}

#[test]
fn an_element_without_a_ref_on_either_side_answers_every_element_again() {
    let fake = Fake::new(tree());
    let observations = Observations::default();
    let mut blank = tree();
    blank.push(node("", Some("before"), None));
    *fake.walk.lock().expect("lock") = blank.clone();
    observe(&observations, &fake, None);
    blank[4].attributes.label = Some("after".into());
    *fake.walk.lock().expect("lock") = blank;
    let changed = observe(&observations, &fake, Some("o1"));
    assert!(changed.get("diff").is_none());
    assert_eq!(changed["elements"][4]["label"], "after");

    *fake.walk.lock().expect("lock") = tree();
    let removed = observe(&observations, &fake, Some("o2"));
    assert!(
        removed.get("diff").is_none(),
        "o2 held an element without a ref"
    );
    assert_eq!(removed["elements"].as_array().map(Vec::len), Some(4));

    let mut twins = tree();
    twins.push(node("AXButton", Some("OK"), None));
    *fake.walk.lock().expect("lock") = twins;
    let ambiguous = observe(&observations, &fake, Some("o3"));
    assert!(ambiguous.get("diff").is_none(), "twins lose their refs");
    assert_eq!(ambiguous["elements"][0]["ref"], Value::Null);

    *fake.walk.lock().expect("lock") = tree();
    let back = observe(&observations, &fake, Some("o4"));
    assert!(back.get("diff").is_none());
    let same = observe(&observations, &fake, Some("o5"));
    assert_eq!(
        same["diff"],
        json!({"since": "o5", "added": [], "changed": [], "removed": []})
    );
}

#[test]
fn an_incomplete_walk_mints_no_ref_and_refuses_ref_actions() {
    let fake = Fake::new(tree());
    let observations = Observations::default();
    let mut cut = request(None, None);
    cut.max_elements = 2;
    let body = shoot(&observations, &fake, &cut).expect("observe");
    assert_eq!(body["complete"], false);
    assert_eq!(body["elements"][0]["ref"], Value::Null);
    assert_eq!(
        observations.act(&fake, &act("o1", "AXButton[0]", Action::Press)),
        Err(Refusal::RefNotFound)
    );

    let mut wide: Vec<Node> = (0..MAX_ELEMENTS)
        .map(|at| node("AXButton", Some(&format!("b{at}")), None))
        .collect();
    *fake.walk.lock().expect("lock") = wide[..3].to_vec();
    let full = observe(&observations, &fake, None);
    assert_eq!(full["complete"], true);
    assert_eq!(full["elements"][0]["ref"], "AXButton[0]");
    wide.push(node("AXButton", Some("b0"), None));
    *fake.walk.lock().expect("lock") = wide;
    assert_eq!(
        observations.act(&fake, &act("o2", "AXButton[0]", Action::Press)),
        Err(Refusal::RefNotFound),
        "a twin beyond the walk limit makes the fresh walk incomplete"
    );
    assert_eq!(
        observations.point(&fake, "o2", "AXButton[0]"),
        Err(Refusal::RefNotFound)
    );
    let over = observe(&observations, &fake, None);
    assert_eq!(over["complete"], false);
    assert_eq!(over["elements"][0]["ref"], Value::Null);
    assert!(fake.acted.lock().expect("lock").is_empty());
}

#[test]
fn identity_compares_unclipped_labels() {
    let prefix = "p".repeat(MAX_LABEL);
    let (first, second) = (format!("{prefix}save"), format!("{prefix}delete"));
    let fake = Fake::new(vec![
        node("AXButton", Some(&first), None),
        node("AXButton", Some(&second), None),
    ]);
    let observations = Observations::default();
    let body = observe(&observations, &fake, None);
    assert_eq!(body["elements"][0]["label"], json!(prefix));
    assert_eq!(body["elements"][0]["ref"], "AXButton[0]");
    fake.walk.lock().expect("lock").swap(0, 1);
    for parent in &mut *fake.walk.lock().expect("lock") {
        parent.parent = None;
    }
    assert_eq!(
        observations.act(&fake, &act("o1", "AXButton[0]", Action::Press)),
        Err(Refusal::RefNotFound)
    );
    assert_eq!(
        observations.point(&fake, "o1", "AXButton[0]"),
        Err(Refusal::RefNotFound)
    );
    assert!(fake.acted.lock().expect("lock").is_empty());
}

#[test]
fn dispatch_admits_only_the_identity_it_validated() {
    let fake = Fake::new(vec![
        node("AXButton", Some("Save"), None),
        node("AXButton", Some("Delete"), None),
    ]);
    let observations = Observations::default();
    observe(&observations, &fake, None);
    *fake.swap.lock().expect("lock") = Some(vec![
        node("AXButton", Some("Delete"), None),
        node("AXButton", Some("Save"), None),
    ]);
    assert_eq!(
        observations.act(&fake, &act("o1", "AXButton[0]", Action::Press)),
        Err(Refusal::RefNotFound)
    );
    assert!(fake.acted.lock().expect("lock").is_empty());
    *fake.walk.lock().expect("lock") = vec![node("AXButton", Some("Save"), None)];
    observe(&observations, &fake, None);
    *fake.swap.lock().expect("lock") = Some(Vec::new());
    assert_eq!(
        observations.act(&fake, &act("o2", "AXButton[0]", Action::Press)),
        Err(Refusal::RefNotFound),
        "an element gone at dispatch is not found"
    );
}

#[test]
fn cancellation_during_the_fresh_walk_cuts_off_the_native_action() {
    use crate::input::dispatch::DispatchLedger;
    let fake = Fake::new(tree());
    let observations = Observations::default();
    observe(&observations, &fake, None);
    let ledger = DispatchLedger::default();
    ledger.attach(1);
    let entry = ledger.start("1-1").expect("input entry");
    let (entered, walking) = channel();
    let (release, released) = channel();
    *fake.hold.lock().expect("lock") = Some((entered, released));
    std::thread::scope(|scope| {
        let action = scope.spawn(|| {
            observations.act_guarded(&fake, &act("o1", "AXButton[0]", Action::Press), &|| {
                entry.before_event(ledger.current())
            })
        });
        walking
            .recv_timeout(Duration::from_secs(30))
            .expect("fresh walk started");
        ledger.cancel();
        release.send(()).expect("release fresh walk");
        assert_eq!(
            action.join().expect("action thread"),
            Err(Refusal::RefNotFound)
        );
    });
    assert!(fake.acted.lock().expect("lock").is_empty());
    assert!(!entry.before_event(ledger.current()));
}

#[test]
fn supersession_during_the_fresh_walk_cuts_off_the_native_action() {
    use crate::input::dispatch::DispatchLedger;
    let fake = Fake::new(tree());
    let observations = Observations::default();
    observe(&observations, &fake, None);
    let ledger = DispatchLedger::default();
    ledger.attach(1);
    let entry = ledger.start("1-1").expect("input entry");
    let (entered, walking) = channel();
    let (release, released) = channel();
    *fake.hold.lock().expect("lock") = Some((entered, released));
    std::thread::scope(|scope| {
        let action = scope.spawn(|| {
            observations.act_guarded(&fake, &act("o1", "AXButton[0]", Action::Press), &|| {
                entry.before_event(ledger.current())
            })
        });
        walking
            .recv_timeout(Duration::from_secs(30))
            .expect("fresh walk started");
        ledger.attach(2);
        release.send(()).expect("release fresh walk");
        assert_eq!(
            action.join().expect("action thread"),
            Err(Refusal::RefNotFound)
        );
    });
    assert!(fake.acted.lock().expect("lock").is_empty());
    assert!(!entry.before_event(ledger.current()));
}

#[test]
fn forget_keeps_counting_ids_so_old_ones_stay_stale() {
    let fake = Fake::new(tree());
    let observations = Observations::default();
    observe(&observations, &fake, None);
    observations.forget();
    let body = observe(&observations, &fake, None);
    assert_eq!(body["observationId"], "o2");
    assert_eq!(
        observations.act(&fake, &act("o1", "AXButton[0]", Action::Press)),
        Err(Refusal::Stale)
    );
    assert_eq!(
        observations.point(&fake, "o1", "AXButton[0]"),
        Err(Refusal::Stale)
    );
    assert_eq!(
        shoot(&observations, &fake, &request(None, Some("o1"))).err(),
        Some(Refusal::Stale)
    );
}

#[test]
fn a_blocked_window_does_not_block_another_window() {
    let fake = Fake::new(tree());
    *fake.windows.lock().expect("lock") = Ok(vec![window_at(9, 0), window_at(10, 0)]);
    let (entered, walking) = channel();
    let (release, released) = channel();
    *fake.hold.lock().expect("lock") = Some((entered, released));
    let observations = Observations::default();
    let mut other = request(None, None);
    other.target.window_id = 10;
    std::thread::scope(|scope| {
        let held = scope.spawn(|| shoot(&observations, &fake, &request(None, None)));
        walking.recv().expect("window 9 walking");
        let (done, finished) = channel();
        let (observations, fake, other) = (&observations, &fake, &other);
        scope.spawn(move || done.send(shoot(observations, fake, other)).expect("send"));
        let body = finished
            .recv_timeout(Duration::from_secs(30))
            .expect("window 10 is not serialized behind window 9")
            .expect("observe");
        assert_eq!(body["lineage"], "w7-10-0");
        release.send(()).expect("release");
        let body = held.join().expect("join").expect("observe");
        assert_eq!(body["lineage"], "w7-9-0");
    });
}

#[test]
fn ambiguous_siblings_and_their_descendants_get_no_ref() {
    let nodes = vec![
        node("AXButton", Some("OK"), None),
        node("AXButton", Some("OK"), None),
        node("AXImage", None, Some(1)),
        node("AXButton", Some("Cancel"), None),
        node("", Some("blank"), None),
    ];
    let walk = Walk {
        nodes,
        focused: Some(2),
        complete: true,
    };
    let Minted {
        elements,
        focused,
        complete,
        ..
    } = mint(walk);
    assert_eq!(
        refs(&elements),
        vec![None, None, None, Some("AXButton[2]"), None]
    );
    assert_eq!(elements[2].parent, None);
    assert!(elements[4].actions.is_empty());
    assert_eq!((focused, complete), (None, true));
}

#[test]
fn identifiers_address_ten_unlabeled_siblings_without_a_fresh_action_walk() {
    let nodes = (0..10)
        .map(|index| {
            let mut row = node("AXRow", None, None);
            row.attributes.identifier = Some(format!("row-{index}"));
            row
        })
        .collect();
    let fake = Fake::new(nodes);
    let observations = Observations::default();
    let body = observe(&observations, &fake, None);
    for index in 0..10 {
        assert_eq!(body["elements"][index]["ref"], format!("AXRow[{index}]"));
        assert_eq!(body["elements"][index]["id"], format!("row-{index}"));
    }
    let walks = fake.walks.load(Ordering::SeqCst);
    let resolves = fake.resolves.load(Ordering::SeqCst);
    observations
        .act(&fake, &act("o1", "AXRow[5]", Action::Press))
        .expect("identified row");
    assert_eq!(fake.walks.load(Ordering::SeqCst), walks);
    assert_eq!(fake.resolves.load(Ordering::SeqCst), resolves + 2);
}

#[test]
fn identified_row_relocates_after_a_swap_and_refuses_an_absent_identifier() {
    let mut first = node("AXRow", None, None);
    first.attributes.identifier = Some("first".into());
    let mut second = node("AXRow", None, None);
    second.attributes.identifier = Some("second".into());
    let fake = Fake::new(vec![first, second]);
    let observations = Observations::default();
    observe(&observations, &fake, None);
    fake.walk.lock().expect("lock").swap(0, 1);
    observations
        .act(&fake, &act("o1", "AXRow[0]", Action::Press))
        .expect("relocated");
    assert_eq!(fake.acted.lock().expect("lock")[0].0, "AXRow[1] ");
    fake.walk.lock().expect("lock")[1].attributes.identifier = Some("replacement".into());
    assert_eq!(
        observations.act(&fake, &act("o1", "AXRow[0]", Action::Press)),
        Err(Refusal::RefNotFound)
    );
    fake.walk.lock().expect("lock")[1].attributes.identifier = Some("first".into());
    fake.walk.lock().expect("lock")[1].attributes.label = Some("different".into());
    let mut duplicate = node("AXRow", None, None);
    duplicate.attributes.identifier = Some("first".into());
    fake.walk.lock().expect("lock").push(duplicate);
    assert_eq!(
        observations.act(&fake, &act("o1", "AXRow[0]", Action::Press)),
        Err(Refusal::RefNotFound),
        "two elements with one identifier and role cannot be relocated"
    );
}

#[test]
fn deep_paths_lose_their_ref_and_bytes_cut_the_walk() {
    let deep: Vec<Node> = (0_usize..30)
        .map(|at| node("AXGroup", None, at.checked_sub(1)))
        .collect();
    let elements = minted(deep, None).elements;
    assert!(elements[22].reference.is_some());
    assert_eq!(elements[23].reference, None);

    let wide: Vec<Node> = (0..300)
        .map(|at| {
            let label = format!("{at:04}{}", "x".repeat(1020));
            node("AXButton", Some(&label), None)
        })
        .collect();
    let Minted {
        elements,
        focused,
        complete,
        ..
    } = minted(wide, Some(299));
    assert!(!complete);
    assert_eq!(focused, None);
    let bytes = serde_json::to_vec(&elements).expect("serialize").len();
    assert!(bytes <= MAX_BYTES && elements.len() < 300, "{bytes}");
}

#[test]
fn elements_clip_bound_and_hide_secure_values() {
    let mut actions: Vec<String> = (0..20).map(|at| format!("AXAction{at}")).collect();
    actions.insert(0, String::new());
    actions.insert(1, "A".repeat(65));
    let attributes = Attributes {
        role: "AXSecureTextField".into(),
        value: Some("hunter2".into()),
        actions,
        frame: Frame {
            x: -20_000,
            y: 20_000,
            width: -5,
            height: 20_000,
        },
        secure: true,
        ..Attributes::default()
    };
    let secure = element(attributes, Some("AXSecureTextField[0]".into()), None);
    assert_eq!(secure.value, None);
    assert_eq!(secure.actions.len(), MAX_ACTIONS);
    assert_eq!(secure.actions[0], "AXAction0");
    assert_eq!(
        secure.frame,
        Frame {
            x: -COORDINATE,
            y: COORDINATE,
            width: 0,
            height: COORDINATE
        }
    );
    assert_eq!(clip("a\u{1F600}b", 2), "a");
    assert_eq!(clip("a\u{1F600}b", 3), "a\u{1F600}");
}

#[test]
fn actions_revalidate_the_observation_and_the_element_before_acting() {
    let fake = Fake::new(tree());
    let observations = Observations::default();
    observe(&observations, &fake, None);
    let cases = [
        (act("o9", "AXButton[0]", Action::Press), Refusal::Stale),
        (act("o1", "AXLink[0]", Action::Press), Refusal::RefNotFound),
        (
            act("o1", "AXTextField[0]", Action::Press),
            Refusal::Unsupported,
        ),
        (
            act("o1", "AXButton[0]", Action::Perform("AXShowMenu".into())),
            Refusal::Unsupported,
        ),
    ];
    for (act, refusal) in cases {
        assert_eq!(observations.act(&fake, &act), Err(refusal));
    }
    observations
        .act(
            &fake,
            &act("o1", "AXButton[0]", Action::Perform("AXPress".into())),
        )
        .expect("perform");
    observations
        .act(
            &fake,
            &act("o1", "AXTextField[0]", Action::SetValue("grace".into())),
        )
        .expect("set value");
    assert_eq!(
        *fake.acted.lock().expect("lock"),
        vec![
            ("AXButton[0] OK".into(), Action::Perform("AXPress".into())),
            (
                "AXTextField[0] Name".into(),
                Action::SetValue("grace".into())
            ),
        ]
    );
    *fake.act_fault.lock().expect("lock") = Some(ActFault::Permission);
    assert_eq!(
        observations.act(&fake, &act("o1", "AXButton[0]", Action::Press)),
        Err(Refusal::Permission)
    );
    fake.walk.lock().expect("lock")[0].attributes.label = Some("Done".into());
    assert_eq!(
        observations.act(&fake, &act("o1", "AXButton[0]", Action::Press)),
        Err(Refusal::RefNotFound)
    );
    *fake.windows.lock().expect("lock") = Ok(vec![window(1)]);
    assert_eq!(
        observations.act(&fake, &act("o1", "AXButton[0]", Action::Press)),
        Err(Refusal::EpochChanged)
    );
}

#[test]
fn points_resolve_the_fresh_element_centre_in_global_points() {
    let mut nodes = tree();
    nodes[0].attributes.frame = Frame {
        x: 10,
        y: 4,
        width: 41,
        height: 20,
    };
    let fake = Fake::new(nodes);
    let observations = Observations::default();
    observe(&observations, &fake, None);
    assert_eq!(
        observations.point(&fake, "o9", "AXButton[0]"),
        Err(Refusal::Stale)
    );
    assert_eq!(
        observations.point(&fake, "o1", "AXLink[0]"),
        Err(Refusal::RefNotFound)
    );
    assert_eq!(
        observations.point(&fake, "o1", "AXButton[0]"),
        Ok((130, 64))
    );
    fake.walk.lock().expect("lock")[0].attributes.label = Some("Done".into());
    assert_eq!(
        observations.point(&fake, "o1", "AXButton[0]"),
        Err(Refusal::RefNotFound)
    );
    *fake.windows.lock().expect("lock") = Ok(vec![window(1)]);
    assert_eq!(
        observations.point(&fake, "o1", "AXButton[0]"),
        Err(Refusal::EpochChanged)
    );
}

#[test]
fn identified_point_follows_its_element_and_refuses_ambiguous_relocation() {
    let mut first = node("AXRow", None, None);
    first.attributes.identifier = Some("first".into());
    first.attributes.frame.x = 8;
    let mut second = node("AXRow", None, None);
    second.attributes.identifier = Some("second".into());
    second.attributes.frame.x = 20;
    let fake = Fake::new(vec![first, second]);
    let observations = Observations::default();
    observe(&observations, &fake, None);
    assert_eq!(observations.point(&fake, "o1", "AXRow[0]"), Ok((108, 50)));

    fake.walk.lock().expect("lock").swap(0, 1);
    assert_eq!(observations.point(&fake, "o1", "AXRow[0]"), Ok((108, 50)));
    fake.walk.lock().expect("lock")[1].attributes.label = Some("changed".into());
    assert_eq!(
        observations.point(&fake, "o1", "AXRow[0]"),
        Err(Refusal::RefNotFound)
    );
    fake.walk.lock().expect("lock")[1].attributes.label = None;
    let mut duplicate = node("AXRow", None, None);
    duplicate.attributes.identifier = Some("first".into());
    fake.walk.lock().expect("lock").push(duplicate);
    assert_eq!(
        observations.point(&fake, "o1", "AXRow[0]"),
        Err(Refusal::RefNotFound)
    );
}

#[test]
fn identified_ref_refuses_relocation_when_fresh_walk_is_incomplete() {
    let mut original = node("AXRow", None, None);
    original.attributes.identifier = Some("original".into());
    let fake = Fake::new(vec![original]);
    let observations = Observations::default();
    observe(&observations, &fake, None);
    let mut changed = node("AXRow", None, None);
    changed.attributes.identifier = Some("different".into());
    let mut replacement = node("AXRow", None, None);
    replacement.attributes.identifier = Some("original".into());
    let mut nodes = vec![changed; MAX_ELEMENTS];
    nodes.push(replacement);
    *fake.walk.lock().expect("lock") = nodes;
    assert_eq!(
        observations.point(&fake, "o1", "AXRow[0]"),
        Err(Refusal::RefNotFound)
    );
}

#[test]
fn wire_targets_convert_and_an_absent_observer_refuses() {
    assert_eq!(
        target(7, 9, Some(2)),
        Target {
            pid: 7,
            window_id: 9,
            epoch: Some(2)
        }
    );
    assert_eq!(target(7, 9, None).epoch, None);
    let screen = Screen::absent();
    let request: ScreenObserveRequest =
        oni_protocol::decode(json!({"target": {"pid": 7, "windowId": 9}, "screenshot": false}))
            .expect("observe request");
    assert_eq!(
        screen.observe(&request),
        json!({"status": "refused", "reason": "observe_not_available"})
    );
    assert_eq!(
        screen.act(&act("o1", "AXButton[0]", Action::Press)),
        Err(Refusal::NotAvailable)
    );
    assert_eq!(
        screen.point("o1", "AXButton[0]").map(|(_, x, y)| (x, y)),
        Err(Refusal::NotAvailable)
    );
}

#[test]
fn screen_pointer_resolves_only_a_point_on_an_active_display() {
    let request: ScreenObserveRequest =
        oni_protocol::decode(json!({"target":{"pid":7,"windowId":9},"screenshot":false}))
            .expect("observe request");
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(256, 128, 1.0)),
        1,
    )
    .observing(Box::new(Fake::new(tree())));
    assert_eq!(screen.observe(&request)["observationId"], "o1");
    let (display, x, y) = screen.point("o1", "AXButton[0]").expect("pointer");
    assert_eq!((display.id, x, y), (1, 100, 50));
    assert_eq!(screen.observation_target("o1"), Ok((7, 9)));
    assert_eq!(screen.observation_target("missing"), Err(Refusal::Stale));

    for far_x in [300, i64::from(i32::MAX) + 1] {
        let mut far = tree();
        far[0].attributes.frame.x = far_x;
        let screen = Screen::new(
            Box::new(crate::screen::fixture::Fixture::display(256, 128, 1.0)),
            1,
        )
        .observing(Box::new(Fake::new(far)));
        assert_eq!(screen.observe(&request)["observationId"], "o1");
        assert_eq!(screen.point("o1", "AXButton[0]"), Err(Refusal::OffScreen));
    }
}

#[test]
fn background_ref_refuses_when_observation_is_forgotten_during_resolution() {
    let fake = Fake::new(tree());
    let forget_on_walk = Arc::clone(&fake.forget_on_walk);
    let screen = Arc::new(
        Screen::new(
            Box::new(crate::screen::fixture::Fixture::display(256, 128, 1.0)),
            1,
        )
        .observing(Box::new(fake)),
    );
    let request: ScreenObserveRequest =
        oni_protocol::decode(json!({"target":{"pid":7,"windowId":9},"screenshot":false}))
            .expect("observe request");
    let observed = screen.observe(&request);
    assert_eq!(observed["elements"][0]["ref"], "AXButton[0]");
    *forget_on_walk.lock().expect("lock") = Some(Arc::downgrade(&screen));
    let pointer: oni_protocol::InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"background","kind":"click",
        "at":{"observationId":observed["observationId"],"ref":"AXButton[0]"},
        "button":"left","count":1
    }))
    .expect("pointer request");
    let recorder = crate::input::recorder::Recorder::default();
    let input = crate::input::Input::new(recorder.clone());
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"refused","reason":"stale_observation"})
    );
    assert!(recorder.events().is_empty());
}

#[test]
fn background_window_refuses_when_target_focus_cannot_be_read() {
    let fake = Fake::new(tree());
    let window_reads = Arc::clone(&fake.window_reads);
    let source = crate::screen::fixture::Fixture {
        windows: vec![crate::screen::Window {
            id: 9,
            display: 1,
            title: "Editor".into(),
            owner: "fixture".into(),
            pid: Some(7),
            app: None,
            x: 100,
            y: 50,
            width: 16,
            height: 16,
        }],
        ..crate::screen::fixture::Fixture::display(256, 128, 1.0)
    };
    let screen = Screen::new(Box::new(source), 1).observing(Box::new(fake));
    let capture: oni_protocol::ScreenCaptureRequest = oni_protocol::decode(json!({
        "target":{"kind":"window","windowId":"9"},"encoding":{"format":"png"}
    }))
    .expect("window capture request");
    let captured = screen.capture(&capture);
    assert_eq!(captured["status"], "ok");
    window_reads.lock().expect("lock").extend([
        Ok(vec![window(0)]),
        Ok(vec![window(0)]),
        Err(Fault::Permission),
    ]);
    let pointer: oni_protocol::InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"background","kind":"click",
        "at":{"captureId":captured["captureId"],"x":104,"y":54},
        "button":"left","count":1
    }))
    .expect("pointer request");
    let recorder = crate::input::recorder::Recorder::default();
    let input = crate::input::Input::new(recorder.clone());
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"refused","reason":"private"})
    );
    assert!(recorder.events().is_empty());
}

#[test]
fn screen_observation_respects_explicit_element_limit() {
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(256, 128, 1.0)),
        1,
    )
    .observing(Box::new(Fake::new(tree())));
    let request: ScreenObserveRequest = oni_protocol::decode(json!({
        "target":{"pid":7,"windowId":9},"screenshot":false,"maxElements":1
    }))
    .expect("observe request");
    let observed = screen.observe(&request);
    assert_eq!(observed["status"], "ok");
    assert_eq!(observed["complete"], false);
    assert_eq!(observed["elements"].as_array().expect("elements").len(), 1);
}

struct RejectNotifications(Arc<AtomicUsize>);

impl super::super::settle::Notifications for RejectNotifications {
    fn subscribe(
        &self,
        _: u32,
        _: u32,
        _: Instant,
        _: Instant,
        _: Arc<dyn Observer>,
    ) -> Result<Box<dyn Subscription>, super::super::settle::Unsupported> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(super::super::settle::Unsupported::WindowNotFound)
    }
}

#[test]
fn screen_action_wait_subscription_refuses_missing_or_unrepresentable_targets() {
    let mut nodes = tree();
    nodes[0].attributes.enabled = Some(false);
    let calls = Arc::new(AtomicUsize::new(0));
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(256, 128, 1.0)),
        1,
    )
    .observing(Box::new(Fake::new(nodes)))
    .notifying(Box::new(RejectNotifications(Arc::clone(&calls))));
    let request: ScreenObserveRequest =
        oni_protocol::decode(json!({"target":{"pid":7,"windowId":9},"screenshot":false}))
            .expect("observe request");
    assert_eq!(screen.observe(&request)["observationId"], "o1");
    let mut action = act("o1", "AXButton[0]", Action::Press);
    action.wait_ms = 2000;
    assert_eq!(screen.act(&action), Err(Refusal::NotActionable("disabled")));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let now = Instant::now();
    assert!(screen
        .subscribe_action(
            Target {
                pid: u64::MAX,
                ..action.target
            },
            now,
            now
        )
        .is_none());
    assert!(screen
        .subscribe_action(
            Target {
                window_id: u64::MAX,
                ..action.target
            },
            now,
            now
        )
        .is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(Screen::absent()
        .subscribe_action(action.target, now, now)
        .is_none());
}

#[test]
fn actionability_decision_names_first_blocker_and_set_value_only_checks_disabled() {
    let mut attributes = Attributes {
        enabled: Some(false),
        frame: Frame {
            x: 100,
            y: 0,
            width: 0,
            height: 3,
        },
        ..Attributes::default()
    };
    let size = (10, 10);
    assert_eq!(
        blocker(&attributes, size, &Action::Press, Some(Hit::Covered)),
        Some("disabled")
    );
    attributes.enabled = None;
    assert_eq!(
        blocker(&attributes, size, &Action::Press, Some(Hit::Covered)),
        Some("zero_size")
    );
    attributes.frame.width = 3;
    assert_eq!(
        blocker(&attributes, size, &Action::Press, Some(Hit::Covered)),
        Some("off_window")
    );
    attributes.frame.x = 1;
    assert_eq!(
        blocker(
            &attributes,
            size,
            &Action::Perform("AXPress".into()),
            Some(Hit::Occluded)
        ),
        Some("occluded")
    );
    assert_eq!(
        blocker(&attributes, size, &Action::Press, Some(Hit::Covered)),
        Some("covered")
    );
    assert_eq!(
        blocker(&attributes, size, &Action::Press, Some(Hit::Target)),
        None
    );
    attributes.frame.width = 0;
    assert_eq!(
        blocker(&attributes, size, &Action::SetValue("x".into()), None),
        None
    );
    attributes.enabled = Some(false);
    assert_eq!(
        blocker(&attributes, size, &Action::SetValue("x".into()), None),
        Some("disabled")
    );
}

#[test]
fn disabled_action_refuses_without_dispatch_and_names_blocker() {
    let fake = Fake::new(tree());
    fake.walk.lock().expect("lock")[0].attributes.enabled = Some(false);
    let observations = Observations::default();
    observe(&observations, &fake, None);
    let refusal = observations
        .act(&fake, &act("o1", "AXButton[0]", Action::Press))
        .expect_err("disabled button");
    assert_eq!(
        refusal.acted(),
        json!({
            "status": "refused", "reason": "not_actionable",
            "message": "disabled: element is not actionable"
        })
    );
    assert!(fake.acted.lock().expect("lock").is_empty());
}

struct LayoutTick {
    fake: Arc<Fake>,
    now: Instant,
    enable: bool,
}

impl Subscription for LayoutTick {
    fn now(&self) -> Instant {
        self.now
    }
    fn receive_until(&mut self, deadline: Instant) -> Option<(Instant, Notification)> {
        self.now = deadline;
        if self.enable {
            self.fake.walk.lock().expect("lock")[0].attributes.enabled = Some(true);
        }
        None
    }
    fn sample(&mut self, _: Instant) -> Result<super::super::settle::Sample, Refusal> {
        let bounds = Bounds {
            max_elements: MAX_ELEMENTS,
            max_visits: MAX_VISITS,
            budget: BUDGET,
        };
        Ok(super::super::settle::Sample {
            windows: self.fake.windows().map_err(Refusal::from)?,
            walk: self.fake.walk(&window(0), &bounds).map_err(Refusal::from)?,
            private: false,
        })
    }
    fn commit_if_current(&mut self, _: Box<dyn FnOnce() -> Value + '_>) -> Option<Value> {
        None
    }
}

#[test]
fn blocked_action_rechecks_on_quiet_tick_and_zero_wait_refuses_immediately() {
    let fake = Arc::new(Fake::new(tree()));
    fake.walk.lock().expect("lock")[0].attributes.enabled = Some(false);
    let observations = Observations::default();
    observe(&observations, fake.as_ref(), None);
    let mut action = act("o1", "AXButton[0]", Action::Press);
    assert_eq!(
        observations.act(fake.as_ref(), &action),
        Err(Refusal::NotActionable("disabled"))
    );
    assert!(fake.acted.lock().expect("lock").is_empty());
    action.wait_ms = 2000;
    assert_eq!(
        observations.act_waiting(&*fake, &action, &|| true, &|start, _| {
            Some(Box::new(LayoutTick {
                fake: Arc::clone(&fake),
                now: start,
                enable: true,
            }))
        }),
        Ok(())
    );
    assert_eq!(fake.acted.lock().expect("lock").len(), 1);
}

#[test]
fn quiet_ticks_end_with_the_first_remaining_blocker() {
    let fake = Arc::new(Fake::new(tree()));
    fake.walk.lock().expect("lock")[0].attributes.enabled = Some(false);
    let observations = Observations::default();
    observe(&observations, fake.as_ref(), None);
    let mut action = act("o1", "AXButton[0]", Action::Press);
    action.wait_ms = 400;
    assert_eq!(
        observations.act_waiting(fake.as_ref(), &action, &|| true, &|start, _| {
            Some(Box::new(LayoutTick {
                fake: Arc::clone(&fake),
                now: start,
                enable: false,
            }))
        }),
        Err(Refusal::NotActionable("disabled"))
    );
    assert!(fake.acted.lock().expect("lock").is_empty());
}

struct RefusalTick {
    fake: Arc<Fake>,
    now: Instant,
    refusal: Refusal,
}

impl Subscription for RefusalTick {
    fn now(&self) -> Instant {
        self.now
    }

    fn receive_until(&mut self, deadline: Instant) -> Option<(Instant, Notification)> {
        self.now = deadline;
        (self.refusal == Refusal::WindowNotFound).then_some((deadline, Notification::Destroyed))
    }

    fn sample(&mut self, _: Instant) -> Result<super::super::settle::Sample, Refusal> {
        let bounds = Bounds {
            max_elements: MAX_ELEMENTS,
            max_visits: MAX_VISITS,
            budget: BUDGET,
        };
        Ok(super::super::settle::Sample {
            windows: if self.refusal == Refusal::EpochChanged {
                vec![window(1)]
            } else {
                self.fake.windows().map_err(Refusal::from)?
            },
            walk: self.fake.walk(&window(0), &bounds).map_err(Refusal::from)?,
            private: self.refusal == Refusal::Private,
        })
    }

    fn commit_if_current(&mut self, _: Box<dyn FnOnce() -> Value + '_>) -> Option<Value> {
        None
    }
}

#[test]
fn blocked_action_refuses_destroyed_private_and_recreated_targets_on_tick() {
    let fake = Arc::new(Fake::new(tree()));
    fake.walk.lock().expect("lock")[0].attributes.enabled = Some(false);
    let observations = Observations::default();
    observe(&observations, fake.as_ref(), None);
    let mut action = act("o1", "AXButton[0]", Action::Press);
    action.wait_ms = 2000;
    assert_eq!(
        observations.act_waiting(fake.as_ref(), &action, &|| true, &|_, _| None),
        Err(Refusal::NotActionable("disabled"))
    );
    for refusal in [
        Refusal::WindowNotFound,
        Refusal::Private,
        Refusal::EpochChanged,
    ] {
        assert_eq!(
            observations.act_waiting(fake.as_ref(), &action, &|| true, &|start, _| {
                Some(Box::new(RefusalTick {
                    fake: Arc::clone(&fake),
                    now: start,
                    refusal: refusal.clone(),
                }))
            }),
            Err(refusal)
        );
    }
    assert!(fake.acted.lock().expect("lock").is_empty());
}
