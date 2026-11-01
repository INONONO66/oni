use super::*;

fn large() -> Vec<Node> {
    let mut nodes = vec![
        node("AXWindow", Some("Editor"), None),
        node("AXGroup", Some("Toolbar"), Some(0)),
        node("AXButton", Some("Save As"), Some(1)),
        node("AXGroup", Some("Rows"), Some(0)),
    ];
    nodes.extend((0..2996).map(|at| node("AXRow", Some(&at.to_string()), Some(3))));
    nodes
}

fn depth(depth: usize) -> Request {
    let mut request = request(None, None);
    request.scope.max_depth = Some(depth);
    request
}

#[test]
fn depth_two_observes_three_of_three_thousand_nodes_and_its_refs_act() {
    let fake = Fake::new(large());
    let observations = Observations::default();
    let full = shoot(&observations, &fake, &request(None, None)).expect("full");
    assert_eq!(full["complete"], false);
    assert!(full["elements"]
        .as_array()
        .expect("elements")
        .iter()
        .all(|e| e["ref"].is_null()));
    let skeleton = shoot(&observations, &fake, &depth(2)).expect("skeleton");
    assert_eq!(skeleton["complete"], true);
    assert_eq!(skeleton["elements"].as_array().expect("elements").len(), 3);
    assert_eq!(skeleton["elements"][1]["children"], 1);
    assert_eq!(skeleton["elements"][2]["children"], 2996);
    assert_eq!(*fake.scoped_reads.lock().expect("reads"), [0, 1, 3]);
    observations
        .act(&fake, &act("o2", "AXWindow[0]/AXGroup[1]", Action::Press))
        .expect("act");
    assert_eq!(
        *fake.scoped_reads.lock().expect("reads"),
        [0, 1, 3, 0, 1, 3]
    );
    assert_eq!(fake.acted.lock().expect("acted").len(), 1);
}

#[test]
fn root_keeps_full_paths_and_never_reads_other_subtrees() {
    let fake = Fake::new(large());
    let observations = Observations::default();
    shoot(&observations, &fake, &depth(2)).expect("skeleton");
    fake.scoped_reads.lock().expect("reads").clear();
    let mut scoped = request(Some(0), None);
    scoped.scope.root = Some("AXWindow[0]/AXGroup[0]".into());
    let result = shoot(&observations, &fake, &scoped).expect("subtree");
    assert_eq!(result["complete"], true);
    assert_eq!(result["elements"].as_array().expect("elements").len(), 2);
    assert_eq!(
        result["elements"][1]["ref"],
        "AXWindow[0]/AXGroup[0]/AXButton[0]"
    );
    assert_eq!(*fake.scoped_reads.lock().expect("reads"), [0, 1, 2, 3]);
    observations
        .act(
            &fake,
            &act("o2", "AXWindow[0]/AXGroup[0]/AXButton[0]", Action::Press),
        )
        .expect("press");
    assert_eq!(
        observations.point(&fake, "o2", "AXWindow[0]/AXGroup[0]/AXButton[0]"),
        Ok((100, 50))
    );
    assert_eq!(fake.scoped_reads.lock().expect("reads").len(), 12);
}

#[test]
fn match_searches_labels_not_values_and_keeps_only_matching_refs_and_ancestors() {
    let mut nodes = large();
    nodes[4].attributes.value = Some("save".into());
    let fake = Fake::new(nodes);
    let observations = Observations::default();
    let mut scoped = request(None, None);
    scoped.scope.matching = Some(Matching {
        role: Some("AXButton".into()),
        label: Some("save".into()),
    });
    let result = shoot(&observations, &fake, &scoped).expect("search");
    assert_eq!(result["complete"], true);
    assert_eq!(result["elements"].as_array().expect("elements").len(), 3);
    assert!(result["elements"][0]["ref"].is_null());
    assert!(result["elements"][1]["ref"].is_null());
    assert_eq!(
        result["elements"][2]["ref"],
        "AXWindow[0]/AXGroup[0]/AXButton[0]"
    );
    observations
        .act(
            &fake,
            &act("o1", "AXWindow[0]/AXGroup[0]/AXButton[0]", Action::Press),
        )
        .expect("press");
    assert_eq!(fake.scoped_reads.lock().expect("reads").len(), 3004);
}

#[test]
fn an_ambiguous_scope_root_cannot_issue_or_revalidate_refs() {
    let fake = Fake::new(large());
    let observations = Observations::default();
    shoot(&observations, &fake, &depth(2)).expect("skeleton");
    fake.walk.lock().expect("nodes")[3].attributes.label = Some("Toolbar".into());
    let mut scoped = request(None, None);
    scoped.scope.root = Some("AXWindow[0]/AXGroup[0]".into());
    assert_eq!(
        shoot(&observations, &fake, &scoped),
        Err(Refusal::RefNotFound)
    );
    assert_eq!(
        observations.act(&fake, &act("o1", "AXWindow[0]/AXGroup[0]", Action::Press)),
        Err(Refusal::RefNotFound)
    );
    assert!(fake.acted.lock().expect("acted").is_empty());
}

#[test]
fn unlabeled_layout_wrappers_do_not_spend_depth() {
    let mut nodes = vec![node("AXWindow", None, None)];
    for role in [
        "AXGroup",
        "AXGenericElement",
        "AXSection",
        "AXSplitGroup",
        "AXScrollArea",
        "AXLayoutArea",
    ] {
        nodes.push(node(role, None, Some(nodes.len() - 1)));
    }
    nodes.push(node("AXButton", Some("Save"), Some(6)));
    nodes.push(node("AXImage", None, Some(7)));
    let fake = Fake::new(nodes);
    let result = shoot(&Observations::default(), &fake, &depth(2)).expect("wrappers");
    assert_eq!(result["complete"], true);
    assert_eq!(result["elements"].as_array().expect("elements").len(), 8);
    assert_eq!(result["elements"][7]["children"], 1);
    assert_eq!(fake.scoped_reads.lock().expect("reads").len(), 8);
}

#[test]
fn since_requires_identical_scope_and_same_scope_returns_diff() {
    let fake = Fake::new(large());
    let observations = Observations::default();
    shoot(&observations, &fake, &depth(2)).expect("skeleton");
    let mut next = depth(2);
    next.since = Some("o1".into());
    let diff = shoot(&observations, &fake, &next).expect("same scope");
    assert_eq!(
        diff["diff"],
        json!({"since":"o1","added":[],"changed":[],"removed":[]})
    );
    next.since = Some("o2".into());
    next.scope.max_depth = Some(1);
    let changed = shoot(&observations, &fake, &next).expect_err("different scope");
    assert_eq!(changed, Refusal::ScopeChanged);
    assert_eq!(changed.observed()["reason"], "stale_observation");
    assert!(changed.message().expect("scope message").contains("scope"));
    assert_eq!(changed.acted()["reason"], "stale_observation");
}

#[test]
fn root_refuses_absent_snapshot_missing_path_changed_key_and_backend_fault() {
    let fake = Fake::new(large());
    let observations = Observations::default();
    let mut scoped = depth(2);
    scoped.scope.root = Some("AXWindow[0]/AXGroup[0]".into());
    assert_eq!(shoot(&observations, &fake, &scoped), Err(Refusal::Stale));
    shoot(&observations, &fake, &depth(2)).expect("skeleton");
    scoped.scope.root = Some("AXWindow[0]/AXGroup[2]".into());
    assert_eq!(
        shoot(&observations, &fake, &scoped),
        Err(Refusal::RefNotFound)
    );
    scoped.scope.root = Some("AXWindow[0]/AXGroup[0]".into());
    fake.walk.lock().expect("nodes")[1].attributes.label = Some("changed".into());
    assert_eq!(
        shoot(&observations, &fake, &scoped),
        Err(Refusal::RefNotFound)
    );
    *fake.walk.lock().expect("nodes") = vec![node("AXWindow", None, None)];
    assert_eq!(
        shoot(&observations, &fake, &scoped),
        Err(Refusal::RefNotFound)
    );
    *fake.walk_fault.lock().expect("fault") = Some(Fault::Permission);
    assert_eq!(
        shoot(&observations, &fake, &scoped),
        Err(Refusal::Permission)
    );
}

#[test]
fn root_element_bound_is_incomplete_without_refs() {
    let fake = Fake::new(large());
    let observations = Observations::default();
    shoot(&observations, &fake, &depth(2)).expect("skeleton");
    let mut scoped = request(None, None);
    scoped.scope.root = Some("AXWindow[0]/AXGroup[0]".into());
    scoped.max_elements = 1;
    let cut = shoot(&observations, &fake, &scoped).expect("bounded root");
    assert_eq!(cut["complete"], false);
    assert_eq!(cut["elements"].as_array().expect("elements").len(), 1);
    assert!(cut["elements"][0]["ref"].is_null());
}

#[test]
fn matching_preserves_same_role_indices_and_complete_sibling_ambiguity() {
    let mut nodes = vec![
        node("AXGroup", Some("Form"), None),
        node("AXButton", Some("Cancel"), Some(0)),
        node("AXButton", Some("Save"), Some(0)),
        node("AXButton", Some("Save"), Some(0)),
        node("AXTextField", None, Some(0)),
    ];
    nodes[2].attributes.focused = true;
    let fake = Fake::new(nodes);
    let observations = Observations::default();
    let mut scoped = request(None, None);
    scoped.scope.matching = Some(Matching {
        role: None,
        label: Some("save".into()),
    });
    let matched = shoot(&observations, &fake, &scoped).expect("match");
    assert_eq!(matched["complete"], true);
    assert_eq!(matched["elements"].as_array().expect("elements").len(), 3);
    assert!(matched["elements"]
        .as_array()
        .expect("elements")
        .iter()
        .all(|e| e["ref"].is_null()));
    assert!(matched.get("focused").is_none());
    fake.walk.lock().expect("nodes")[3].attributes.label = Some("Other".into());
    let unique = shoot(&observations, &fake, &scoped).expect("unique");
    assert_eq!(unique["elements"][1]["ref"], "AXGroup[0]/AXButton[1]");
    assert_eq!(unique["focused"], "AXGroup[0]/AXButton[1]");
    scoped.scope.matching = Some(Matching {
        role: None,
        label: Some("absent".into()),
    });
    let empty = shoot(&observations, &fake, &scoped).expect("empty");
    assert_eq!(empty["elements"], json!([]));
    assert!(empty.get("focused").is_none());
}

#[test]
fn match_output_bound_applies_after_filtering_and_root_hides_prefix_ancestors() {
    let fake = Fake::new(large());
    let observations = Observations::default();
    shoot(&observations, &fake, &depth(2)).expect("skeleton");
    let mut scoped = request(None, None);
    scoped.scope.root = Some("AXWindow[0]/AXGroup[0]".into());
    scoped.scope.matching = Some(Matching {
        role: Some("AXButton".into()),
        label: None,
    });
    let result = shoot(&observations, &fake, &scoped).expect("matched subtree");
    assert_eq!(result["elements"].as_array().expect("elements").len(), 2);
    assert_eq!(result["elements"][0]["role"], "AXGroup");
    assert!(result["elements"][0]["ref"].is_null());
    scoped.since = Some("o2".into());
    let repeated = shoot(&observations, &fake, &scoped).expect("same root and match");
    assert_eq!(repeated["elements"], result["elements"]);
    assert_eq!(
        observations.act(&fake, &act("o3", "AXWindow[0]/AXGroup[0]", Action::Press)),
        Err(Refusal::RefNotFound)
    );
    scoped.since = None;
    scoped.scope.root = None;
    scoped.scope.matching = Some(Matching::default());
    scoped.max_elements = 2;
    let cut = shoot(&observations, &fake, &scoped).expect("match bound");
    assert_eq!(cut["complete"], false);
    assert_eq!(cut["elements"].as_array().expect("elements").len(), 2);
    assert!(cut["elements"][0]["ref"].is_null());
}

#[test]
fn scoped_walk_enforces_visits_deadline_and_malformed_path_refusal() {
    let fake = Fake::new(large());
    let observations = Observations::default();
    let located = observations
        .locate(&fake, request(None, None).target)
        .expect("window");
    let mut bounds = Bounds {
        max_elements: 2000,
        max_visits: 1,
        budget: BUDGET,
    };
    let scope = Scope {
        max_depth: Some(2),
        ..Scope::default()
    };
    let limited = scope.walk(&fake, &located, &bounds).expect("visits");
    assert!(!limited.walk.complete);
    assert_eq!(limited.walk.nodes.len(), 1);
    bounds.budget = Duration::ZERO;
    let timed = scope.walk(&fake, &located, &bounds).expect("budget");
    assert!(!timed.walk.complete);
    assert!(timed.walk.nodes.is_empty());
    let malformed = Scope {
        root: Some("AXGroup[9999999999999999999999999999999]".into()),
        ..Scope::default()
    };
    assert!(matches!(
        malformed.walk(&fake, &located, &bounds),
        Err(Refusal::RefNotFound)
    ));
}

#[test]
fn scoped_identifier_relocation_stays_inside_the_observed_depth() {
    let mut nodes = large();
    nodes[1].attributes.identifier = Some("toolbar".into());
    let fake = Fake::new(nodes);
    let observations = Observations::default();
    shoot(&observations, &fake, &depth(2)).expect("skeleton");
    let mut nodes = fake.walk.lock().expect("nodes");
    nodes[1].attributes.identifier = Some("replacement".into());
    nodes[3].attributes.identifier = Some("toolbar".into());
    nodes[3].attributes.label = Some("Toolbar".into());
    drop(nodes);
    observations
        .act(&fake, &act("o1", "AXWindow[0]/AXGroup[0]", Action::Press))
        .expect("relocate");
    assert_eq!(
        fake.acted.lock().expect("acted")[0].0,
        "AXWindow[0]/AXGroup[1] Toolbar"
    );
    assert_eq!(fake.scoped_reads.lock().expect("reads").len(), 6);
}

#[test]
fn wire_scopes_drive_the_fixture_observer_and_record_a_full_path_action() {
    let directory = tempfile::tempdir().expect("directory");
    let layout = directory.path().join("layout.json");
    let recorder = directory.path().join("recorder.jsonl");
    std::fs::write(
        &layout,
        json!({"windows":[{
            "pid":7,"id":9,"title":"Editor","elements":[{
                "role":"AXGroup","label":"Toolbar","frame":{"x":0,"y":0,"width":16,"height":16},
                "children":[{"role":"AXButton","label":"SAVE As","actions":["AXPress"],
                    "frame":{"x":0,"y":0,"width":4,"height":4}}]
            }]
        }]})
        .to_string(),
    )
    .expect("layout");
    let screen = Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(32, 32, 1.0)),
        1,
    )
    .observing(Box::new(ax::fixture::Scripted {
        layout,
        recorder: recorder.clone(),
    }));
    let shallow: ScreenObserveRequest = oni_protocol::decode(json!({
        "target":{"pid":7,"windowId":9},"screenshot":false,"maxDepth":1
    }))
    .expect("depth request");
    let first = screen.observe(&shallow);
    assert_eq!(first["elements"][0]["children"], 1);
    let scoped: ScreenObserveRequest = oni_protocol::decode(json!({
        "target":{"pid":7,"windowId":9,"epoch":0},"screenshot":false,
        "root":"AXGroup[0]","maxDepth":2,"match":{"role":"AXButton","label":"sAvE"}
    }))
    .expect("scoped request");
    let result = screen.observe(&scoped);
    let decoded: oni_protocol::ScreenObserveResult =
        oni_protocol::decode(result.clone()).expect("wire result");
    assert_eq!(serde_json::to_value(decoded).expect("round trip"), result);
    assert_eq!(result["elements"][0]["ref"], Value::Null);
    assert_eq!(result["elements"][1]["ref"], "AXGroup[0]/AXButton[0]");
    screen
        .act(&act("o2", "AXGroup[0]/AXButton[0]", Action::Press))
        .expect("press");
    let recorded = std::fs::read_to_string(recorder).expect("recorded action");
    assert_eq!(
        serde_json::from_str::<Value>(recorded.trim()).expect("record"),
        json!({"kind":"action","pid":7,"windowId":9,"ref":"AXGroup[0]/AXButton[0]","action":"press"})
    );
}

#[test]
fn private_scoped_observation_remains_empty_and_remembers_its_scope() {
    let fake = Fake::new(large());
    {
        let mut walk = fake.walk.lock().expect("walk");
        walk[2].attributes.focused = true;
        walk[2].attributes.secure = true;
    }
    let observations = Observations::default();
    let private = shoot(&observations, &fake, &depth(2)).expect("private");
    assert_eq!(private["private"], true);
    assert_eq!(private["elements"], json!([]));
    assert!(fake.scoped_reads.lock().expect("reads").is_empty());
    let mut next = depth(1);
    next.since = Some("o1".into());
    assert_eq!(
        shoot(&observations, &fake, &next),
        Err(Refusal::ScopeChanged)
    );
}
