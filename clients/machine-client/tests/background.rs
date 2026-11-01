use oni_machine_client::{
    app, computer,
    input::{delivery::Route, recorder::Recorder, Driver, Event, Input},
    screen::observe::Target,
};
use oni_protocol::{
    AppLaunchRequest, InputKeyRequest, InputPointerRequest, InputTextRequest, ScreenCaptureRequest,
};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::mpsc};

fn rig(extra: Value) -> (tempfile::TempDir, oni_machine_client::screen::Screen, Input) {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut window = json!({"id":7,"display":1,"title":"Fixture","owner":"fixture","pid":4242,
        "app":{"bundleId":"org.oni.fixture","path":"/Fixture.app"},"x":0,"y":0,"width":8,"height":8,
        "elements":[{"role":"AXButton","label":"Normal","focused":true,
            "frame":{"x":0,"y":0,"width":8,"height":8}}]});
    for (key, value) in extra.as_object().expect("extra") {
        window[key] = value.clone();
    }
    fs::write(dir.path().join("layout.json"), json!({
        "displays":[{"id":1,"x":0,"y":0,"width":16,"height":16,"scale":1,"primary":true}],
        "windows":[window],"apps":[{"bundleId":"org.oni.fixture","path":"/Fixture.app","pid":4242,"windows":[7]}]
    }).to_string()).expect("layout");
    fs::write(
        dir.path().join("client.json"),
        json!({"computer":{"layout":"layout.json","recorder":"events.jsonl"}}).to_string(),
    )
    .expect("client");
    let (screen, input) = computer::open(&dir.path().join("client.json"))
        .expect("open")
        .expect("fixture");
    (dir, screen, input)
}

fn capture(screen: &oni_machine_client::screen::Screen) -> String {
    let request = oni_protocol::decode(
        json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}}),
    )
    .expect("request");
    screen.capture(&request)["captureId"]
        .as_str()
        .expect("capture")
        .into()
}

#[test]
fn background_pointer_and_missing_targets_refuse_before_delivery() {
    let (_dir, screen, input) = rig(json!({}));
    let capture = capture(&screen);
    let pointer: InputPointerRequest = oni_protocol::decode(
        json!({"requestId":"1-1","delivery":"background","kind":"move","at":{"captureId":capture,"x":1,"y":1}}),
    )
    .expect("pointer");
    let key: InputKeyRequest = oni_protocol::decode(
        json!({"requestId":"1-2","delivery":"background","captureId":capture,"key":"a","action":"press"}),
    )
    .expect("key");
    let text: InputTextRequest = oni_protocol::decode(
        json!({"requestId":"1-3","delivery":"background","captureId":capture,"text":"hi"}),
    )
    .expect("text");
    let refused = json!({"status":"refused","reason":"foreground_required"});
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"refused","reason":"unsupported_action"})
    );
    assert_eq!(input.key(&screen, &key), refused);
    assert_eq!(input.text(&screen, &text), refused);
}

#[test]
fn background_click_and_scroll_post_to_observed_pid_without_moving_cursor() {
    let (_dir, screen, _) = rig(json!({}));
    let recorder = Recorder::default();
    let input = Input::new(recorder.clone());
    let observed: oni_protocol::ScreenObserveRequest = oni_protocol::decode(json!({
        "target":{"pid":4242,"windowId":7},"screenshot":false
    }))
    .expect("observation request");
    let observation = screen.observe(&observed);
    assert_eq!(observation["status"], "ok");
    let at = json!({"observationId":observation["observationId"],"ref":"AXButton[0]"});
    let before = recorder.cursor();
    for request in [
        json!({"requestId":"1-1","delivery":"background","kind":"click","at":at,"button":"left","count":2}),
        json!({"requestId":"1-2","delivery":"background","kind":"scroll","at":at,"deltaX":1,"deltaY":-2}),
    ] {
        let request: InputPointerRequest = oni_protocol::decode(request).expect("pointer");
        assert_eq!(
            input.pointer(&screen, &request),
            json!({"status":"ok","target":{
                "pid":4242,"windowId":7,"source":"window_capture"
            }})
        );
    }
    assert_eq!(recorder.cursor(), before);
    assert_eq!(recorder.routes(), vec![Some(4242); 8]);
    assert_eq!(
        recorder.events()[0],
        oni_machine_client::input::Event::Move {
            x: 4,
            y: 4,
            reference: Some("AXButton[0]".into())
        }
    );
}

#[test]
fn background_display_click_records_the_frontmost_window_and_screen_point() {
    let (dir, screen, input) = rig(json!({}));
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"background","kind":"click",
        "at":{"captureId":capture(&screen),"x":3,"y":5},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &request),
        json!({"status":"ok","target":{
            "pid":4242,"windowId":7,"source":"display_hit_test"
        },"landedOn":{"pid":4242,"app":"org.oni.fixture"}})
    );
    let lines: Vec<Value> = fs::read_to_string(dir.path().join("events.jsonl"))
        .expect("recorded pointer")
        .lines()
        .map(|line| serde_json::from_str(line).expect("event line"))
        .collect();
    assert_eq!(
        lines[0],
        json!({"event":"move","x":3,"y":5,"delivery":"background","pid":4242,"tag":true})
    );
    assert_eq!(lines[1]["pid"], 4242);
    assert_eq!(lines[2]["pid"], 4242);
}

#[test]
fn coordinate_expectation_accepts_the_current_app_and_reports_the_landing() {
    let (dir, screen, input) = rig(json!({}));
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"foreground","kind":"click",
        "at":{"captureId":capture(&screen),"x":3,"y":5,
            "within":{"apps":["org.oni.fixture"]}},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &request),
        json!({"status":"ok","landedOn":{"pid":4242,"app":"org.oni.fixture"}})
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("events.jsonl"))
            .expect("recorded click")
            .lines()
            .count(),
        3
    );
}

#[test]
fn coordinate_expectation_uses_the_window_path_without_a_bundle_id() {
    let (_dir, screen, input) = rig(json!({"app":{"path":"/Fixture.app"}}));
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"foreground","kind":"click",
        "at":{"captureId":capture(&screen),"x":3,"y":5,
            "within":{"apps":["/Fixture.app"]}},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &request),
        json!({"status":"ok","landedOn":{"pid":4242,"app":"/Fixture.app"}})
    );
    let (_dir, screen, input) = rig(json!({"app":{"path":""}}));
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-2","delivery":"foreground","kind":"click",
        "at":{"captureId":capture(&screen),"x":3,"y":5,
            "within":{"apps":["/Fixture.app"]}},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &request),
        json!({"status":"refused","reason":"target_mismatch","landedOn":{"pid":4242}})
    );
}

#[test]
fn overlay_mismatch_refuses_before_the_first_recorded_event() {
    let (dir, screen, input) = rig(json!({}));
    let captured = capture(&screen);
    let path = dir.path().join("layout.json");
    let mut layout: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("layout")).expect("layout JSON");
    let mut overlay = layout["windows"][0].clone();
    overlay["id"] = json!(8);
    overlay["pid"] = json!(4343);
    overlay["app"] = json!({"bundleId":"org.oni.overlay","path":"/Overlay.app"});
    layout["windows"]
        .as_array_mut()
        .expect("windows")
        .insert(0, overlay);
    fs::write(path, layout.to_string()).expect("overlay");
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"foreground","kind":"click",
        "at":{"captureId":captured,"x":3,"y":5,"within":{"pids":[4242]}},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &request),
        json!({"status":"refused","reason":"target_mismatch",
            "landedOn":{"pid":4343,"app":"org.oni.overlay"}})
    );
    assert!(!dir.path().join("events.jsonl").exists());
}

struct FixedTarget(u32, u32);

impl Driver for FixedTarget {
    fn permitted(&self) -> bool {
        true
    }

    fn inject(&mut self, _: &Event) -> Result<(), String> {
        panic!("a refused landing must not inject input")
    }

    fn pid_delivery(&self) -> bool {
        true
    }

    fn post_to_pid(&mut self, _: u32, _: &Event) -> Result<(), String> {
        panic!("a refused landing must not post input")
    }

    fn target_at(
        &self,
        _: &oni_machine_client::screen::Screen,
        _: &oni_machine_client::screen::Display,
        _: i32,
        _: i32,
    ) -> Option<(u32, u32)> {
        Some((self.0, self.1))
    }
}

#[test]
fn pointer_refuses_excluded_and_disappeared_landings_before_dispatch() {
    let (dir, screen, _) = rig(json!({}));
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"foreground","kind":"click",
        "at":{"captureId":capture(&screen),"x":3,"y":5},
        "button":"left","count":1
    }))
    .expect("pointer");
    let excluded = screen.excluding(vec!["org.oni.fixture".into()]);
    assert_eq!(
        Input::new(FixedTarget(4242, 7)).pointer(&excluded, &request),
        json!({"status":"refused","reason":"excluded"})
    );
    let (_dir, screen, _) = rig(json!({}));
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-2","delivery":"foreground","kind":"click",
        "at":{"captureId":capture(&screen),"x":3,"y":5},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        Input::new(FixedTarget(4242, 999)).pointer(&screen, &request),
        json!({"status":"refused","reason":"window_not_found"})
    );
    assert_eq!(
        Input::new(FixedTarget(std::process::id(), 7)).pointer(&screen, &request),
        json!({"status":"refused","reason":"excluded"})
    );
    let absent = oni_machine_client::screen::Screen::new(
        Box::new(oni_machine_client::screen::fixture::Fixture::display(
            16, 16, 1.0,
        )),
        1,
    );
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-3","delivery":"foreground","kind":"click",
        "at":{"captureId":capture(&absent),"x":3,"y":5},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        Input::new(FixedTarget(4242, 7)).pointer(&absent, &request),
        json!({"status":"refused","reason":"private"})
    );
    assert!(!dir.path().join("events.jsonl").exists());
}

struct OverlayAfterMove {
    recorder: Recorder,
    layout: PathBuf,
    after_down: bool,
    before_dispatch: bool,
}

impl OverlayAfterMove {
    fn cover(&self) -> Result<(), String> {
        let mut layout: Value = serde_json::from_str(
            &fs::read_to_string(&self.layout).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("{error}"))?;
        let mut overlay = layout["windows"][0].clone();
        overlay["id"] = json!(8);
        overlay["pid"] = json!(4343);
        overlay["app"] = json!({"bundleId":"org.oni.overlay","path":"/Overlay.app"});
        layout["windows"]
            .as_array_mut()
            .ok_or("missing windows")?
            .insert(0, overlay);
        fs::write(&self.layout, layout.to_string()).map_err(|error| error.to_string())
    }
}

impl Driver for OverlayAfterMove {
    fn permitted(&self) -> bool {
        true
    }

    fn prepare(&mut self, _: Route, _: &[Event]) -> Result<(), String> {
        if self.before_dispatch {
            self.cover()?;
        }
        Ok(())
    }

    fn inject(&mut self, event: &Event) -> Result<(), String> {
        self.recorder.inject(event)?;
        if !self.before_dispatch
            && ((self.after_down && matches!(event, Event::Button { down: true, .. }))
                || (!self.after_down && matches!(event, Event::Move { .. })))
        {
            self.cover()?;
        }
        Ok(())
    }

    fn pid_delivery(&self) -> bool {
        true
    }

    fn pointer_pid_delivery(&self) -> bool {
        true
    }

    fn post_to_pid(&mut self, _: u32, event: &Event) -> Result<(), String> {
        self.inject(event)
    }
}

#[test]
fn overlay_after_first_move_refuses_before_button_down() {
    let (dir, screen, _) = rig(json!({}));
    let recorder = Recorder::default();
    let input = Input::new(OverlayAfterMove {
        recorder: recorder.clone(),
        layout: dir.path().join("layout.json"),
        after_down: false,
        before_dispatch: false,
    });
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"foreground","kind":"click",
        "at":{"captureId":capture(&screen),"x":3,"y":5,"within":{"pids":[4242]}},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &request),
        json!({"status":"refused","reason":"target_mismatch",
            "landedOn":{"pid":4343,"app":"org.oni.overlay"}})
    );
    assert!(matches!(recorder.events().as_slice(), [Event::Move { .. }]));
}

#[test]
fn overlay_after_button_down_releases_the_held_button() {
    let (dir, screen, _) = rig(json!({}));
    let recorder = Recorder::default();
    let input = Input::new(OverlayAfterMove {
        recorder: recorder.clone(),
        layout: dir.path().join("layout.json"),
        after_down: true,
        before_dispatch: false,
    });
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"foreground","kind":"click",
        "at":{"captureId":capture(&screen),"x":3,"y":5,"within":{"pids":[4242]}},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &request),
        json!({"status":"refused","reason":"target_mismatch",
            "landedOn":{"pid":4343,"app":"org.oni.overlay"}})
    );
    assert!(matches!(
        recorder.events().as_slice(),
        [
            Event::Move { .. },
            Event::Button { down: true, .. },
            Event::Button { down: false, .. }
        ]
    ));
}

#[test]
fn background_route_refuses_when_the_window_changes_before_dispatch() {
    let (dir, screen, _) = rig(json!({}));
    let recorder = Recorder::default();
    let input = Input::new(OverlayAfterMove {
        recorder: recorder.clone(),
        layout: dir.path().join("layout.json"),
        after_down: false,
        before_dispatch: true,
    });
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"background","kind":"click",
        "at":{"captureId":capture(&screen),"x":3,"y":5,
            "within":{"pids":[4242,4343]}},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &request),
        json!({"status":"refused","reason":"target_mismatch",
            "landedOn":{"pid":4343,"app":"org.oni.overlay"}})
    );
    assert!(recorder.events().is_empty());
}

#[test]
fn coordinate_expectation_refuses_a_destroyed_window_without_dispatch() {
    let (dir, screen, input) = rig(json!({}));
    let captured = capture(&screen);
    let path = dir.path().join("layout.json");
    let mut layout: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("layout")).expect("layout JSON");
    layout["windows"] = json!([]);
    fs::write(path, layout.to_string()).expect("destroy window");
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"foreground","kind":"button",
        "at":{"captureId":captured,"x":3,"y":5,"within":{"pids":[4242]}},
        "button":"left","state":"down"
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &request),
        json!({"status":"refused","reason":"window_not_found"})
    );
    assert!(!dir.path().join("events.jsonl").exists());
}

#[test]
fn observation_ref_lineage_refuses_after_the_screen_is_forgotten() {
    let (dir, screen, input) = rig(json!({}));
    let request: oni_protocol::ScreenObserveRequest = oni_protocol::decode(json!({
        "target":{"pid":4242,"windowId":7},"screenshot":false
    }))
    .expect("observation request");
    let observed = screen.observe(&request);
    assert_eq!(observed["status"], "ok");
    screen.forget();
    let pointer: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"foreground","kind":"click",
        "at":{"observationId":observed["observationId"],"ref":"AXButton[0]"},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"refused","reason":"stale_observation"})
    );
    assert!(!dir.path().join("events.jsonl").exists());
}

#[test]
fn excluded_owner_refuses_a_coordinate_without_a_within_expectation() {
    let (dir, _, _) = rig(json!({}));
    fs::write(
        dir.path().join("client.json"),
        json!({"computer":{"layout":"layout.json","recorder":"events.jsonl",
            "excludedOwners":["org.oni.fixture"]}})
        .to_string(),
    )
    .expect("excluded client");
    let (screen, input) = computer::open(&dir.path().join("client.json"))
        .expect("open")
        .expect("fixture");
    let captured = capture(&screen);
    let pointer: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"foreground","kind":"scroll",
        "at":{"captureId":captured,"x":3,"y":5},"deltaX":0,"deltaY":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"refused","reason":"excluded"})
    );
    assert!(!dir.path().join("events.jsonl").exists());
}

#[test]
fn own_process_refuses_before_any_coordinate_event() {
    let (dir, screen, input) = rig(json!({"pid":std::process::id()}));
    let pointer: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"foreground","kind":"click",
        "at":{"captureId":capture(&screen),"x":3,"y":5},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"refused","reason":"excluded"})
    );
    assert!(!dir.path().join("events.jsonl").exists());
}

#[test]
fn background_display_point_without_a_window_refuses_before_dispatch() {
    let (dir, screen, input) = rig(json!({}));
    let request: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"background","kind":"click",
        "at":{"captureId":capture(&screen),"x":12,"y":12},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &request),
        json!({"status":"refused","reason":"window_not_found"})
    );
    assert!(!dir.path().join("events.jsonl").exists());
}

#[test]
fn background_display_point_keeps_the_overlap_privacy_gate() {
    let (dir, _, _) = rig(json!({}));
    let path = dir.path().join("layout.json");
    let mut layout: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("layout")).expect("layout JSON");
    let mut other = layout["windows"][0].clone();
    other["id"] = json!(8);
    other["pid"] = json!(4343);
    layout["windows"]
        .as_array_mut()
        .expect("windows")
        .push(other);
    fs::write(path, layout.to_string()).expect("overlapping layout");
    let (screen, input) = computer::open(&dir.path().join("client.json"))
        .expect("open overlap")
        .expect("fixture");
    let anchored = capture(&screen);
    let pointer: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"background","kind":"click",
        "at":{"captureId":anchored,"x":4,"y":4},"button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"refused","reason":"private"})
    );
    assert!(!dir.path().join("events.jsonl").exists());
}

#[test]
fn background_window_capture_keeps_its_owner_when_another_window_overlaps() {
    let (dir, screen, input) = rig(json!({}));
    let request: ScreenCaptureRequest = oni_protocol::decode(json!({
        "target":{"kind":"window","windowId":"7"},"encoding":{"format":"png"}
    }))
    .expect("window capture request");
    let capture = screen.capture(&request);
    assert_eq!(capture["status"], "ok");
    let path = dir.path().join("layout.json");
    let mut layout: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("layout")).expect("layout JSON");
    layout["windows"]
        .as_array_mut()
        .expect("windows")
        .push(json!({
            "id":8,"display":1,"title":"Overlapping secure","owner":"fixture",
            "pid":4343,"x":0,"y":0,"width":8,"height":8,
            "elements":[{"role":"AXSecureTextField","focused":true,"secure":true,
                "frame":{"x":0,"y":0,"width":8,"height":8}}]
        }));
    fs::write(path, layout.to_string()).expect("overlapping layout");
    let pointer: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"background","kind":"click",
        "at":{"captureId":capture["captureId"],"x":4,"y":4},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"ok","target":{
            "pid":4242,"windowId":7,"source":"window_capture"
        },"landedOn":{"pid":4242,"app":"org.oni.fixture"}})
    );
}

#[test]
fn background_window_capture_refuses_a_newly_secure_target() {
    let (dir, screen, input) = rig(json!({}));
    let request: ScreenCaptureRequest = oni_protocol::decode(json!({
        "target":{"kind":"window","windowId":"7"},"encoding":{"format":"png"}
    }))
    .expect("window capture request");
    let capture = screen.capture(&request);
    assert_eq!(capture["status"], "ok");
    let path = dir.path().join("layout.json");
    let mut layout: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("layout")).expect("layout JSON");
    layout["windows"][0]["elements"][0]["role"] = json!("AXSecureTextField");
    layout["windows"][0]["elements"][0]["secure"] = json!(true);
    fs::write(path, layout.to_string()).expect("secure layout");
    let pointer: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"background","kind":"click",
        "at":{"captureId":capture["captureId"],"x":4,"y":4},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"refused","reason":"private"})
    );
    assert!(!dir.path().join("events.jsonl").exists());
}

#[test]
fn observed_ref_survives_a_newer_capture_of_the_same_window() {
    let (_dir, screen, input) = rig(json!({}));
    let observation: oni_protocol::ScreenObserveRequest = oni_protocol::decode(json!({
        "target":{"pid":4242,"windowId":7},"screenshot":false
    }))
    .expect("observation request");
    let observed = screen.observe(&observation);
    let capture: ScreenCaptureRequest = oni_protocol::decode(json!({
        "target":{"kind":"window","windowId":"7"},"encoding":{"format":"png"}
    }))
    .expect("window capture request");
    let first = screen.capture(&capture);
    let newer = screen.capture(&capture);
    assert_ne!(first["captureId"], newer["captureId"]);
    let pointer: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"background","kind":"click",
        "at":{"observationId":observed["observationId"],"ref":"AXButton[0]"},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"ok","target":{
            "pid":4242,"windowId":7,"source":"window_capture"
        }})
    );
}

#[test]
fn background_window_capture_refuses_a_window_removed_after_capture() {
    let (dir, screen, input) = rig(json!({}));
    let request: ScreenCaptureRequest = oni_protocol::decode(json!({
        "target":{"kind":"window","windowId":"7"},"encoding":{"format":"png"}
    }))
    .expect("window capture request");
    let capture = screen.capture(&request);
    let path = dir.path().join("layout.json");
    let mut layout: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("layout")).expect("layout JSON");
    layout["windows"] = json!([]);
    fs::write(path, layout.to_string()).expect("remove window");
    let pointer: InputPointerRequest = oni_protocol::decode(json!({
        "requestId":"1-1","delivery":"background","kind":"click",
        "at":{"captureId":capture["captureId"],"x":4,"y":4},
        "button":"left","count":1
    }))
    .expect("pointer");
    assert_eq!(
        input.pointer(&screen, &pointer),
        json!({"status":"refused","reason":"window_not_found"})
    );
    assert!(!dir.path().join("events.jsonl").exists());
}

#[test]
fn background_keys_release_to_the_same_pid_on_failure_and_settle() {
    let (_dir, screen, _) = rig(json!({}));
    let recorder = Recorder::default();
    let input = Input::new(recorder.clone());
    let capture = capture(&screen);
    let key = |action| {
        oni_protocol::decode(
            json!({"requestId":"1-1","delivery":"background","captureId":capture,"key":"Shift","action":action,
        "target":{"pid":4242,"windowId":7,"epoch":0}}),
        )
        .expect("key")
    };
    assert_eq!(input.key(&screen, &key("down")), json!({"status":"ok"}));
    input.settle();
    assert_eq!(recorder.routes(), vec![Some(4242), Some(4242)]);
    recorder.fail(&[1]);
    assert_eq!(input.key(&screen, &key("press"))["reason"], "input_failed");
    assert_eq!(recorder.routes(), vec![Some(4242); 4]);
    let stale: InputTextRequest = oni_protocol::decode(json!({"requestId":"1-2","delivery":"background","captureId":capture,"text":"x","target":{"pid":4242,"windowId":7,"epoch":1}})).expect("text");
    assert_eq!(
        input.text(&screen, &stale),
        json!({"status":"refused","reason":"epoch_changed"})
    );
}

#[test]
fn lifecycle_uses_fixture_launcher_and_epoch_fence() {
    let (dir, screen, input) = rig(json!({}));
    let request: AppLaunchRequest =
        oni_protocol::decode(json!({"app":{"bundleId":"org.oni.fixture"},"activate":false}))
            .expect("request");
    let target = Target {
        pid: 4242,
        window_id: 7,
        epoch: Some(0),
    };
    assert_eq!(
        app::launch(&screen, &request),
        json!({"status":"ok","pid":4242,"windows":[{"pid":4242,"windowId":7,"epoch":0}]})
    );
    let text: InputTextRequest = oni_protocol::decode(json!({"requestId":"1-1","delivery":"background","captureId":capture(&screen),"text":"background","target":{"pid":4242,"windowId":7,"epoch":0}})).expect("text");
    assert_eq!(input.text(&screen, &text), json!({"status":"ok"}));
    assert_eq!(
        app::window(&screen, target, false),
        json!({"status":"ok","closed":true})
    );
    assert_eq!(
        app::window(&screen, target, true),
        json!({"status":"ok","parked":true})
    );
    assert_eq!(
        app::quit(&screen, 4242),
        json!({"status":"ok","exited":true})
    );
    assert_eq!(
        app::window(
            &screen,
            Target {
                epoch: Some(1),
                ..target
            },
            false
        ),
        json!({"status":"refused","reason":"epoch_changed"})
    );
    assert_eq!(
        app::quit(&screen, 4243),
        json!({"status":"refused","reason":"process_not_found"})
    );
    let lines: Vec<Value> = fs::read_to_string(dir.path().join("events.jsonl"))
        .expect("events")
        .lines()
        .map(|line| serde_json::from_str(line).expect("line"))
        .collect();
    assert_eq!(
        lines[1],
        json!({"event":"text","text":"background","delivery":"background","pid":4242,"tag":true})
    );
    assert_eq!(lines.len(), 5);
}

#[test]
fn capture_refuses_minimized_blank_and_excluded_windows() {
    let request: ScreenCaptureRequest = oni_protocol::decode(
        json!({"target":{"kind":"window","windowId":"7"},"encoding":{"format":"png"}}),
    )
    .expect("request");
    for (extra, reason) in [
        (json!({"minimized":true}), "window_minimized"),
        (json!({"blank":true}), "capture_blank"),
        (json!({"pid":std::process::id()}), "own_window"),
    ] {
        let (_dir, screen, _input) = rig(extra);
        assert_eq!(
            screen.capture(&request),
            json!({"status":"refused","reason":reason})
        );
    }
    let (_dir, screen, _input) = rig(json!({}));
    let screen = screen.excluding(vec!["org.oni.fixture".into()]);
    assert_eq!(
        screen.capture(&request),
        json!({"status":"refused","reason":"own_window"})
    );
    let launch =
        oni_protocol::decode(json!({"app":{"bundleId":"org.oni.fixture"},"activate":false}))
            .expect("request");
    assert_eq!(
        app::launch(&screen, &launch),
        json!({"status":"refused","reason":"excluded"})
    );
    assert_eq!(
        app::quit(&screen, 4242),
        json!({"status":"refused","reason":"excluded"})
    );
    assert_eq!(
        app::window(
            &screen,
            Target {
                pid: 4242,
                window_id: 7,
                epoch: Some(0)
            },
            true
        ),
        json!({"status":"refused","reason":"excluded"})
    );
}

#[test]
fn fixture_launcher_reports_missing_apps_and_completion_disconnect() {
    use app::Launcher;
    let (dir, _screen, _) = rig(json!({}));
    let launcher = app::fixture::Scripted {
        layout: dir.path().join("layout.json"),
        recorder: dir.path().join("events.jsonl"),
    };
    let (tx, rx) = mpsc::channel();
    let absent = oni_protocol::decode(json!({"app":{"bundleId":"missing"},"activate":false}))
        .expect("request");
    assert_eq!(
        launcher.resolve(&absent).map(|_| ()),
        Err(app::Fault::NotFound)
    );
    drop(rx);
    let path = oni_protocol::decode(json!({"app":{"path":"/Fixture.app"},"activate":false}))
        .expect("request");
    assert!(matches!(
        launcher.start(&path, &launcher.resolve(&path).expect("resolved"), tx),
        Err(app::Fault::Failed(_))
    ));
}

#[test]
fn launch_exclusion_checks_resolved_alias_and_own_pid_before_start() {
    let (dir, screen, _) = rig(json!({}));
    let path: AppLaunchRequest =
        oni_protocol::decode(json!({"app":{"path":"/Fixture.app"},"activate":false}))
            .expect("path");
    let bundle: AppLaunchRequest =
        oni_protocol::decode(json!({"app":{"bundleId":"org.oni.fixture"},"activate":false}))
            .expect("bundle");
    assert_eq!(
        app::launch(&screen.excluding(vec!["org.oni.fixture".into()]), &path)["reason"],
        "excluded"
    );
    let (own_dir, _, _) = rig(json!({}));
    let layout = own_dir.path().join("layout.json");
    let mut fixture: Value =
        serde_json::from_slice(&fs::read(&layout).expect("layout")).expect("json");
    fixture["apps"][0]["pid"] = json!(std::process::id());
    fs::write(&layout, fixture.to_string()).expect("layout");
    let (own_screen, _) = computer::open(&own_dir.path().join("client.json"))
        .expect("open")
        .expect("fixture");
    assert_eq!(app::launch(&own_screen, &bundle)["reason"], "excluded");
    let (_path_dir, path_screen, _) = rig(json!({}));
    assert_eq!(
        app::launch(&path_screen.excluding(vec!["/Fixture.app".into()]), &bundle)["reason"],
        "excluded"
    );
    assert!(!dir.path().join("events.jsonl").exists());
    assert!(!own_dir.path().join("events.jsonl").exists());
}

#[test]
fn fixture_launcher_refuses_io_failures_and_missing_processes() {
    use app::Launcher;
    let (dir, _, _) = rig(json!({}));
    let mut launcher = app::fixture::Scripted {
        layout: dir.path().join("layout.json"),
        recorder: dir.path().join("events.jsonl"),
    };
    assert_eq!(launcher.quit(999), Err(app::Fault::ProcessNotFound));
    let request = oni_protocol::decode(json!({"app":{"path":"/Fixture.app"},"activate":false}))
        .expect("request");
    let (tx, rx) = mpsc::channel();
    let resolved = launcher.resolve(&request).expect("resolved");
    assert_eq!(launcher.start(&request, &resolved, tx), Ok(()));
    assert_eq!(rx.recv().expect("completion"), Ok(4242));
    launcher.recorder = dir.path().join("missing/events.jsonl");
    let (tx, _rx) = mpsc::channel();
    assert!(matches!(
        launcher.start(&request, &resolved, tx),
        Err(app::Fault::Failed(_))
    ));
    assert!(matches!(launcher.quit(4242), Err(app::Fault::Failed(_))));
    fs::write(&launcher.layout, json!({"apps":[{"pid":4242}]}).to_string()).expect("layout");
    assert_eq!(
        launcher.identity(4242).expect("identity").path,
        "/fixture/4242"
    );
    fs::write(
        &launcher.layout,
        json!({"apps":[{"bundleId":"test.app","pid":4242}]}).to_string(),
    )
    .expect("layout");
    let no_path: AppLaunchRequest =
        oni_protocol::decode(json!({"app":{"bundleId":"test.app"},"activate":false}))
            .expect("request");
    let resolved = launcher.resolve(&no_path).expect("resolved fallback");
    assert_eq!(resolved.identity.path, "/fixture/4242");
    assert_eq!(resolved.bundle_path, "/fixture/4242");
    let (tx, rx) = mpsc::channel();
    launcher.recorder = dir.path().join("events.jsonl");
    assert_eq!(launcher.start(&no_path, &resolved, tx), Ok(()));
    assert_eq!(rx.recv().expect("completion"), Ok(4242));
    let (tx, _rx) = mpsc::channel();
    let unresolved = app::Resolved {
        running_pid: None,
        ..resolved
    };
    assert_eq!(
        launcher.start(&no_path, &unresolved, tx),
        Err(app::Fault::NotFound)
    );
    fs::write(&launcher.layout, "{").expect("invalid layout");
    assert!(matches!(
        launcher.identity(4242),
        Err(app::Fault::Failed(_))
    ));
    assert!(matches!(
        launcher.resolve(&no_path),
        Err(app::Fault::Failed(_))
    ));
    fs::remove_file(&launcher.layout).expect("remove layout");
    assert!(matches!(launcher.quit(4242), Err(app::Fault::Failed(_))));
}

#[test]
fn failed_detach_release_never_switches_to_foreground() {
    let (_dir, screen, _) = rig(json!({}));
    let recorder = Recorder::default();
    let input = Input::new(recorder.clone());
    let key: InputKeyRequest = oni_protocol::decode(json!({"requestId":"1-1","delivery":"background","captureId":capture(&screen),"key":"Shift","action":"down","target":{"pid":4242,"windowId":7,"epoch":0}})).expect("request");
    assert_eq!(input.key(&screen, &key), json!({"status":"ok"}));
    recorder.fail(&[0]);
    input.settle();
    assert_eq!(recorder.routes(), vec![Some(4242)]);
}

#[path = "support/client_config.rs"]
mod client_config;

#[tokio::test]
async fn lifecycle_wire_methods_require_the_grant_and_return_exact_receipts() {
    use oni_machine_client::{
        attach::{Negotiated, Session},
        handlers::Service,
        pty::ops::Pty,
    };
    let (dir, screen, input) = rig(json!({}));
    let pty = Pty::new("/definitely/missing/tmux", None, "background".into()).await;
    let service = Service::open_computer(
        &client_config::client_config(dir.path(), None),
        pty,
        screen,
        input,
    )
    .expect("service");
    let hooks = service.hooks(std::time::Duration::from_secs(60));
    let target = json!({"pid":4242,"windowId":7,"epoch":0});
    let operations = [
        (
            "machine.app.launch",
            json!({"app":{"bundleId":"org.oni.fixture"},"activate":false}),
            json!({"status":"ok","pid":4242,"windows":[target]}),
        ),
        (
            "machine.window.close",
            json!({"target":target}),
            json!({"status":"ok","closed":true}),
        ),
        (
            "machine.window.park",
            json!({"target":target}),
            json!({"status":"ok","parked":true}),
        ),
        (
            "machine.app.quit",
            json!({"pid":4242}),
            json!({"status":"ok","exited":true}),
        ),
    ];
    for (method, request, _) in &operations {
        assert_eq!(
            (hooks.service)((*method).into(), Some(request.clone()))
                .await
                .expect("reply"),
            json!({"status":"refused","reason":"machine_not_attached"})
        );
    }
    for permitted in [false, true] {
        service.attached(&Negotiated {
            generation: std::num::NonZeroU64::MIN,
            capabilities: if permitted {
                vec!["computer.use".into()]
            } else {
                vec![]
            },
            exports: vec![],
        });
        for (method, request, expected) in &operations {
            let expected = if permitted {
                expected.clone()
            } else {
                json!({"status":"refused","reason":"permission_denied"})
            };
            assert_eq!(
                (hooks.service)((*method).into(), Some(request.clone()))
                    .await
                    .expect("reply"),
                expected
            );
        }
    }
}

#[test]
fn native_config_accepts_owner_exclusions_but_rejects_partial_fixtures() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("client.json");
    fs::write(
        &path,
        json!({"computer":{"excludedOwners":["org.oni.fixture"]}}).to_string(),
    )
    .expect("config");
    assert!(computer::open(&path).expect("native config").is_some());
    for partial in [
        json!({"layout":"layout.json"}),
        json!({"recorder":"events.jsonl"}),
    ] {
        fs::write(&path, json!({"computer":partial}).to_string()).expect("config");
        assert!(matches!(
            computer::open(&path),
            Err(computer::ComputerError::Config(_))
        ));
    }
}

#[test]
fn fixture_window_lifecycle_reports_missing_windows_and_recorder_failures() {
    use oni_machine_client::screen::ax::{fixture::Scripted, ActFault, Observer};
    let (dir, _, _) = rig(json!({}));
    let mut observer = Scripted {
        layout: dir.path().join("layout.json"),
        recorder: dir.path().join("events.jsonl"),
    };
    let mut window = observer.windows().expect("windows").remove(0);
    assert_eq!(observer.lifecycle(&window, false), Ok(()));
    assert_eq!(observer.lifecycle(&window, true), Ok(()));
    window.window_id = 999;
    assert_eq!(observer.lifecycle(&window, false), Err(ActFault::NotFound));
    window.window_id = 7;
    observer.recorder = dir.path().join("missing/events.jsonl");
    assert!(matches!(
        observer.lifecycle(&window, false),
        Err(ActFault::Failed(_))
    ));
}

#[test]
fn background_plans_refuse_a_foreground_only_driver() {
    use oni_machine_client::input::{Driver, Event};
    struct ForegroundOnly;
    impl Driver for ForegroundOnly {
        fn permitted(&self) -> bool {
            true
        }
        fn pid_delivery(&self) -> bool {
            false
        }
        fn inject(&mut self, _: &Event) -> Result<(), String> {
            panic!("refused plan dispatched")
        }
        fn post_to_pid(&mut self, _: u32, _: &Event) -> Result<(), String> {
            panic!("refused plan dispatched")
        }
    }
    let (_dir, screen, _) = rig(json!({}));
    let input = Input::new(ForegroundOnly);
    let request: InputTextRequest = oni_protocol::decode(json!({"requestId":"1-1","delivery":"background","captureId":capture(&screen),"text":"x","target":{"pid":4242,"windowId":7}})).expect("request");
    assert_eq!(
        input.text(&screen, &request),
        json!({"status":"refused","reason":"foreground_required"})
    );
}

#[tokio::test]
async fn a_ref_action_reports_completed_dispatch_after_the_native_fixture_records_it() {
    use oni_machine_client::{
        attach::{Negotiated, Session},
        handlers::Service,
        pty::ops::Pty,
    };
    let (dir, screen, input) = rig(json!({"elements":[{
        "role":"AXButton","label":"OK","actions":["AXPress"],
        "frame":{"x":2,"y":3,"width":4,"height":4}
    }]}));
    let pty = Pty::new("/definitely/missing/tmux", None, "action".into()).await;
    let service = Service::open_computer(
        &client_config::client_config(dir.path(), None),
        pty,
        screen,
        input,
    )
    .expect("service");
    service.attached(&Negotiated {
        generation: std::num::NonZeroU64::MIN,
        capabilities: vec!["computer.use".into()],
        exports: vec![],
    });
    let hooks = service.hooks(std::time::Duration::from_secs(60));
    let call = |method: &str, params: Value| (hooks.service)(method.into(), Some(params));
    let observed = call(
        "machine.screen.observe",
        json!({
            "target":{"pid":4242,"windowId":7},"screenshot":false
        }),
    )
    .await
    .expect("observation");
    assert_eq!(observed["status"], "ok");
    let action = json!({
        "requestId":"1-1","observationId":observed["observationId"],
        "target":observed["target"],"ref":"AXButton[0]","action":"press"
    });
    assert_eq!(
        call("machine.input.action", action).await.expect("action"),
        json!({"status":"ok"})
    );
    assert_eq!(
        call("machine.input.status", json!({"requestId":"1-1"}))
            .await
            .expect("status"),
        json!({"status":"ok","requestId":"1-1","dispatched":true,"state":"completed"})
    );
}

#[test]
fn background_recorder_and_accessibility_reads_preserve_io_errors() {
    use oni_machine_client::{
        input::{Driver, Event},
        screen::{
            ax::{fixture::Scripted, ActFault, Action, Observer, Segment},
            Fault,
        },
    };
    let (dir, _, _) = rig(json!({}));
    let mut recorder = computer::Recorder(dir.path().join("missing/events.jsonl"));
    assert!(recorder
        .post_to_pid(4242, &Event::Text("x".into()))
        .is_err());
    let observer = Scripted {
        layout: dir.path().join("layout.json"),
        recorder: dir.path().join("missing/events.jsonl"),
    };
    let window = observer.windows().expect("windows").remove(0);
    fs::write(&observer.layout, json!({"windows":[{"id":7,"title":"Test","pid":4242,"elements":[{"role":"AXButton","actions":["AXPress"],"frame":{"x":0,"y":0,"width":1,"height":1}}]}]}).to_string()).expect("layout");
    assert!(matches!(
        observer.act(
            &window,
            &[Segment {
                role: "AXButton".into(),
                index: 0
            }],
            &|_| true,
            &Action::Press
        ),
        Err(ActFault::Failed(_))
    ));
    fs::write(&observer.layout, "{").expect("invalid layout");
    assert!(matches!(observer.windows(), Err(Fault::Failed(_))));
    fs::remove_file(&observer.layout).expect("remove layout");
    assert!(matches!(observer.windows(), Err(Fault::Failed(_))));
}
