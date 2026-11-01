use std::{
    fs,
    time::{Duration, Instant},
};

use serde_json::json;

use super::*;

#[test]
fn subscribed_timeline_keeps_order_and_window_destruction() {
    let directory = tempfile::tempdir().expect("temp layout");
    let layout = directory.path().join("layout.json");
    fs::write(
        &layout,
        json!({"windows": [{
            "id": 7, "pid": 42, "title": "Test",
            "timeline": [
                {"atMs": 0, "kind": "value_changed"},
                {"atMs": 40, "kind": "layout_changed"},
                {"atMs": 80, "kind": "destroyed"}
            ]
        }]})
        .to_string(),
    )
    .expect("write layout");
    let notifications = ScriptedNotifications { layout };
    let start = Instant::now();
    let observer = Arc::new(Scripted {
        layout: notifications.layout.clone(),
        recorder: PathBuf::new(),
    });
    let mut feed = notifications
        .subscribe(42, 7, start, start + Duration::from_secs(1), observer)
        .expect("armed");
    let deadline = Instant::now() + Duration::from_secs(3600);
    assert_eq!(
        feed.receive_until(deadline).map(|(_, event)| event),
        Some(Notification::Changed)
    );
    assert_eq!(
        feed.receive_until(deadline).map(|(_, event)| event),
        Some(Notification::Changed)
    );
    assert_eq!(
        feed.receive_until(deadline).map(|(_, event)| event),
        Some(Notification::Destroyed)
    );
    assert_eq!(feed.receive_until(deadline), None);
    assert_eq!(feed.now(), deadline);
    assert_eq!(
        feed.commit_if_current(Box::new(|| json!({"committed": true}))),
        Some(json!({"committed": true}))
    );
    assert_eq!(
        feed.sample(deadline + Duration::from_secs(1))
            .expect("sample")
            .windows
            .len(),
        1
    );
}

#[test]
fn missing_fixture_window_and_layout_refuse_distinctly() {
    let directory = tempfile::tempdir().expect("temp layout");
    let layout = directory.path().join("layout.json");
    let notifications = ScriptedNotifications {
        layout: layout.clone(),
    };
    let start = Instant::now();
    let observer: Arc<dyn Observer> = Arc::new(Scripted {
        layout: layout.clone(),
        recorder: PathBuf::new(),
    });
    assert!(matches!(
        notifications.subscribe(42, 7, start, start, Arc::clone(&observer)),
        Err(Unsupported::NoObserver)
    ));
    fs::write(
        &layout,
        json!({"windows": [{"id": 8, "pid": 42, "title": "Other"}]}).to_string(),
    )
    .expect("write layout");
    assert!(matches!(
        notifications.subscribe(42, 7, start, start, observer),
        Err(Unsupported::WindowNotFound)
    ));
}
#[test]
fn transient_menu_and_sheet_are_listed_observed_acted_and_destroyed() {
    let directory = tempfile::tempdir().expect("fixture");
    let layout = directory.path().join("layout.json");
    let recorder = directory.path().join("actions.jsonl");
    fs::write(
        &layout,
        json!({"windows": [
            {"id": 7, "pid": 42, "title": "Editor"},
            {"id": 81, "pid": 42, "title": "File", "kind": "menu",
             "x": 4, "y": 5, "width": 20, "height": 15,
             "elements": [{"role": "AXMenuItem", "label": "Open", "actions": ["AXPress"],
               "frame": {"x": 1, "y": 2, "width": 10, "height": 4}}],
             "timeline": [{"atMs": 0, "kind": "destroyed"}]},
        {"id": 82, "pid": 42, "title": "Save", "kind": "sheet", "parent": 7,
         "x": 6, "y": 8, "width": 30, "height": 20},
        {"id": 83, "pid": 42, "title": "Options", "kind": "popover", "parent": 7,
         "x": 8, "y": 9, "width": 20, "height": 15},
        {"id": 84, "pid": 42, "title": "Warning", "kind": "alert",
         "x": 9, "y": 10, "width": 20, "height": 15}
        ]})
        .to_string(),
    )
    .expect("layout");
    let source = crate::screen::fixture::Fixture {
        windows: vec![crate::screen::Window {
            id: 7,
            display: 1,
            title: "Editor".into(),
            owner: "fixture".into(),
            pid: Some(42),
            app: None,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        }],
        ..crate::screen::fixture::Fixture::display(100, 100, 1.0)
    };
    let screen = crate::screen::Screen::new(Box::new(source), 1)
        .observing(Box::new(Scripted {
            layout: layout.clone(),
            recorder: recorder.clone(),
        }))
        .notifying(Box::new(ScriptedNotifications { layout }));
    let listed = screen.list(&oni_protocol::decode(json!({"windows": true})).expect("list"));
    assert_eq!(listed["status"], "ok");
    assert_eq!(listed["windows"][1]["kind"], "menu");
    assert_eq!(listed["windows"][2]["kind"], "sheet");
    assert_eq!(listed["windows"][3]["kind"], "popover");
    assert_eq!(
        listed["windows"][3]["parent"],
        json!({"pid": 42, "windowId": 7, "epoch": 0})
    );
    assert_eq!(listed["windows"][4]["kind"], "alert");
    assert!(listed["windows"][4].get("parent").is_none());
    assert_eq!(
        listed["windows"][2]["parent"],
        json!({"pid": 42, "windowId": 7, "epoch": 0})
    );
    let target = json!({"pid": 42, "windowId": 81, "epoch": 0});
    let observed = screen.observe(
        &oni_protocol::decode(json!({
            "target": target, "screenshot": false
        }))
        .expect("observe"),
    );
    assert_eq!(observed["elements"][0]["ref"], "AXMenuItem[0]");
    screen
        .act(&observe::Act {
            target: observe::Target {
                pid: 42,
                window_id: 81,
                epoch: Some(0),
            },
            observation: observed["observationId"].as_str().expect("id").into(),
            reference: "AXMenuItem[0]".into(),
            action: Action::Press,
            wait_ms: 0,
        })
        .expect("press");
    assert_eq!(
        fs::read_to_string(recorder)
            .expect("recorded")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("action"))
            .collect::<Vec<_>>(),
        [json!({"kind":"action","pid":42,"windowId":81,"ref":"AXMenuItem[0]","action":"press"})]
    );
    let settled = screen.settle(
        &oni_protocol::decode(json!({
            "target": target, "quietMs": 50, "timeoutMs": 100
        }))
        .expect("settle"),
    );
    assert_eq!(settled, json!({"status": "destroyed"}));
}

#[test]
fn a_surface_closed_before_settle_answers_destroyed_without_a_notification() {
    let directory = tempfile::tempdir().expect("fixture");
    let layout = directory.path().join("layout.json");
    fs::write(
        &layout,
        json!({"windows": [{
            "id": 81, "pid": 42, "title": "File", "kind": "menu",
            "x": 1, "y": 1, "width": 10, "height": 10
        }]})
        .to_string(),
    )
    .expect("open menu");
    let screen = crate::screen::Screen::new(
        Box::new(crate::screen::fixture::Fixture::display(100, 100, 1.0)),
        1,
    )
    .observing(Box::new(Scripted {
        layout: layout.clone(),
        recorder: directory.path().join("actions.jsonl"),
    }))
    .notifying(Box::new(ScriptedNotifications {
        layout: layout.clone(),
    }));
    let listed = screen.list(&oni_protocol::decode(json!({"windows": true})).expect("list"));
    assert_eq!(listed["windows"][0]["kind"], "menu");
    fs::write(&layout, json!({"windows": []}).to_string()).expect("close menu");
    assert_eq!(
        screen.settle(
            &oni_protocol::decode(json!({
                "target": {"pid": 42, "windowId": 81, "epoch": 0},
                "quietMs": 50, "timeoutMs": 100
            }))
            .expect("settle")
        ),
        json!({"status": "destroyed"})
    );
}
#[test]
fn fixture_hit_test_distinguishes_outside_overlay_and_missing_element() {
    let directory = tempfile::tempdir().expect("temp layout");
    let layout = directory.path().join("layout.json");
    fs::write(
        &layout,
        json!({"windows": [
            {"id": 8, "pid": 8, "title": "Overlay", "width": 10, "height": 10},
            {"id": 9, "pid": 7, "title": "Editor", "x": 20, "width": 10, "height": 10,
             "elements": [{"role": "AXButton", "frame": {"x": 1, "y": 1, "width": 2, "height": 2}}]}
        ]})
        .to_string(),
    )
    .expect("layout");
    let fixture = Scripted {
        layout,
        recorder: directory.path().join("recorder.jsonl"),
    };
    let window = fixture.windows().expect("windows").pop().expect("editor");
    let path = super::super::segments("AXButton[0]").expect("valid path");
    let missing = super::super::segments("AXButton[1]").expect("valid path");
    assert_eq!(
        fixture.hit_test(&window, &path, (50, 50)),
        Ok(Hit::Occluded)
    );
    assert_eq!(fixture.hit_test(&window, &path, (2, 2)), Ok(Hit::Occluded));
    assert_eq!(
        fixture.hit_test(&window, &missing, (22, 2)),
        Err(Fault::WindowNotFound)
    );
    assert_eq!(fixture.hit_test(&window, &path, (22, 2)), Ok(Hit::Target));
}
