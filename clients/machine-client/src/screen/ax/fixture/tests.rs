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
