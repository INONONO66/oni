use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;

use serde_json::json;

use super::*;
use crate::screen::ax::AppIdentity;

struct Fake {
    windows: Mutex<Result<Vec<WindowIdentity>, Fault>>,
    walk: Mutex<Vec<Node>>,
    walk_fault: Mutex<Option<Fault>>,
    act_fault: Mutex<Option<ActFault>>,
    acted: Mutex<Vec<(String, Action)>>,
    /// Nodes the window holds once a fresh walk passed, before dispatch.
    swap: Mutex<Option<Vec<Node>>>,
    /// Holds window 9's walk: signals entry, then waits for release.
    hold: Mutex<Option<(Sender<()>, Receiver<()>)>>,
}

impl Fake {
    fn new(nodes: Vec<Node>) -> Self {
        Self {
            windows: Mutex::new(Ok(vec![window(0)])),
            walk: Mutex::new(nodes),
            walk_fault: Mutex::new(None),
            act_fault: Mutex::new(None),
            acted: Mutex::new(Vec::new()),
            swap: Mutex::new(None),
            hold: Mutex::new(None),
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
    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
        self.windows.lock().expect("lock").clone()
    }

    fn walk(&self, window: &WindowIdentity, bounds: &Bounds) -> Result<Walk, Fault> {
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

    fn act(
        &self,
        _: &WindowIdentity,
        path: &[Segment],
        admit: ax::Admit<'_>,
        action: &Action,
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
        let found = resolve(&nodes, &path).ok_or(ActFault::NotFound)?;
        if !admit(&found.attributes) {
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
    }
}

fn node(role: &str, label: Option<&str>, parent: Option<usize>) -> Node {
    Node {
        attributes: Attributes {
            role: role.into(),
            label: label.map(Into::into),
            actions: vec!["AXPress".into()],
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
            "actions": ["AXPress"], "frame": {"x": 0, "y": 0, "width": 0, "height": 0},
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
