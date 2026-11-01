use std::{fs, path::Path};

use oni_machine_client::{
    computer::{self, ComputerError, Recorder},
    input::{action, Button, Driver, Event, Key, Named},
};
use oni_protocol::{
    InputActionRequest, InputKeyRequest, InputPointerRequest, InputTextRequest,
    ScreenCaptureRequest, ScreenListRequest, ScreenObserveRequest,
};
use serde_json::{json, Value};

const LAYOUT: &str = include_str!("fixtures/computer/layout.json");

fn client(directory: &Path, computer: Option<Value>) -> std::path::PathBuf {
    let path = directory.join("client.json");
    let mut config = json!({ "machineId": "m1", "name": "fixture" });
    if let Some(block) = computer {
        config["computer"] = block;
    }
    fs::write(&path, config.to_string()).expect("write client.json");
    path
}

fn refusal(path: &Path) -> ComputerError {
    match computer::open(path) {
        Err(error) => error,
        Ok(opened) => panic!("expected a refusal, opened {}", opened.is_some()),
    }
}

fn lines(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .expect("read recorder")
        .lines()
        .map(|line| serde_json::from_str(line).expect("recorder line"))
        .collect()
}

#[test]
fn absent_block_keeps_the_platform_backends() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = client(directory.path(), None);
    assert!(computer::open(&path).expect("open").is_none());
}

#[cfg(target_os = "linux")]
#[test]
fn invalid_virtual_display_refuses_before_starting_a_process() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = client(
        directory.path(),
        Some(json!({
            "display": { "kind": "unsupported", "width": 320, "height": 200, "dpi": 96 }
        })),
    );
    assert!(matches!(
        refusal(&path),
        ComputerError::Display(oni_machine_client::display::Error::Unavailable)
    ));
}

#[cfg(target_os = "linux")]
#[test]
fn virtual_display_rejects_a_fixture_layout_before_startup() {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = client(
        directory.path(),
        Some(json!({
            "layout": "layout.json", "recorder": "input.jsonl",
            "display": { "kind": "xvfb", "width": 320, "height": 200, "dpi": 96 }
        })),
    );
    assert!(matches!(refusal(&path), ComputerError::Config(message)
        if message == "virtual display cannot use a fixture layout"));
}

#[test]
fn fixture_block_serves_frames_and_records_input() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut layout: Value = serde_json::from_str(LAYOUT).expect("layout");
    layout["windows"]
        .as_array_mut()
        .expect("windows")
        .push(json!({
            "id": 8, "display": 2, "title": "Input", "owner": "fixture",
            "pid": 4242, "x": 320, "y": 0, "width": 160, "height": 100,
            "elements": [{ "role": "AXButton", "focused": true, "frame": {
                "x": 0, "y": 0, "width": 160, "height": 100
            }}]
        }));
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("write layout");
    let path = client(
        directory.path(),
        Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
    );
    let (screen, input) = computer::open(&path).expect("open").expect("fixture block");
    let request: ScreenCaptureRequest = oni_protocol::decode(
        json!({ "target": { "kind": "display", "display": 2 }, "encoding": { "format": "png" } }),
    )
    .expect("capture request");
    let frame = screen.capture(&request);
    assert_eq!(frame["status"], "ok", "{frame}");
    assert_eq!(
        (frame["width"].clone(), frame["height"].clone()),
        (json!(160), json!(100))
    );
    let capture = frame["captureId"].as_str().expect("capture id").to_owned();
    let pointer: InputPointerRequest = oni_protocol::decode(
        json!({ "requestId":"1-1", "delivery": "foreground", "kind": "click", "at":{"captureId": capture, "x": 4, "y": 5}, "button": "right", "count": 1 }),
    )
    .expect("pointer request");
    assert_eq!(input.pointer(&screen, &pointer)["status"], "ok");
    let key: InputKeyRequest = oni_protocol::decode(
        json!({ "requestId":"1-2", "delivery": "foreground", "captureId": capture, "key": "F5", "action": "press", "modifiers": { "shift": true } }),
    )
    .expect("key request");
    assert_eq!(input.key(&screen, &key)["status"], "ok");
    let text: InputTextRequest = oni_protocol::decode(
        json!({ "requestId":"1-3", "delivery": "foreground", "captureId": capture, "text": "hi" }),
    )
    .expect("text request");
    assert_eq!(input.text(&screen, &text)["status"], "ok");
    assert_eq!(
        lines(&directory.path().join("input.jsonl")),
        vec![
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "move", "x": 324, "y": 5 }),
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "button", "button": "right", "down": true }),
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "button", "button": "right", "down": false }),
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "key", "key": "Shift", "down": true }),
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "key", "key": "F5", "down": true }),
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "key", "key": "F5", "down": false }),
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "key", "key": "Shift", "down": false }),
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "text", "text": "hi" }),
        ]
    );
}

#[test]
fn secure_focus_hides_observation_capture_and_input() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut layout: Value = serde_json::from_str(LAYOUT).expect("layout");
    layout["windows"][0]["pid"] = json!(4242);
    layout["windows"][0]["elements"] = json!([
        { "role": "AXSecureTextField", "secure": true, "focused": true,
          "frame": { "x": 2, "y": 3, "width": 40, "height": 12 } }
    ]);
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("write layout");
    let path = client(
        directory.path(),
        Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
    );
    let (screen, input) = computer::open(&path).expect("open").expect("fixture");
    let observation = observe(
        &screen,
        json!({
            "target": { "pid": 4242, "windowId": 7 },
            "screenshot": false
        }),
    );
    assert_eq!(observation["private"], true);
    assert_eq!(observation["elements"], json!([]));
    assert_eq!(observation["complete"], true);
    let capture: ScreenCaptureRequest = oni_protocol::decode(json!({
        "target": { "kind": "window", "windowId": "7" },
        "encoding": { "format": "png" }
    }))
    .expect("capture");
    assert_eq!(
        screen.capture(&capture),
        json!({ "status": "refused", "reason": "private" })
    );
    let display: ScreenCaptureRequest = oni_protocol::decode(json!({
        "target": { "kind": "display", "display": 1 },
        "encoding": { "format": "png" }
    }))
    .expect("display");
    let anchor = screen.capture(&display)["captureId"]
        .as_str()
        .expect("anchor")
        .to_owned();
    let text: InputTextRequest = oni_protocol::decode(
        json!({ "requestId": "1-1", "delivery": "foreground", "captureId": anchor, "text": "secret" }),
    )
    .expect("text");
    assert_eq!(
        input.text(&screen, &text),
        json!({ "status": "refused", "reason": "private" })
    );
    assert!(!directory.path().join("input.jsonl").exists());
    let source: oni_protocol::stream_open_request::StreamOpenRequestSource =
        serde_json::from_value(json!({ "kind": "window", "windowId": "7" }))
            .expect("stream source");
    let mut frame = Vec::new();
    assert_eq!(
        screen
            .frame(&source, 320, &mut frame)
            .expect("private frame"),
        (120, 80)
    );
    assert!(frame.iter().all(|byte| *byte == 0));
    let display_source: oni_protocol::stream_open_request::StreamOpenRequestSource =
        serde_json::from_value(json!({ "kind": "display", "display": 1 }))
            .expect("display stream source");
    assert!(screen
        .stream_private(&display_source)
        .expect("display private"));
    frame.clear();
    assert_eq!(
        screen
            .frame(&display_source, 640, &mut frame)
            .expect("masked display"),
        (640, 400)
    );
    assert!(frame.contains(&0));
    assert!(frame.iter().any(|byte| *byte != 0));
    let outside: oni_protocol::stream_open_request::StreamOpenRequestSource =
        serde_json::from_value(json!({
            "kind": "display", "display": 1,
            "region": { "x": 200, "y": 100, "width": 100, "height": 80 }
        }))
        .expect("outside stream source");
    assert!(!screen.stream_private(&outside).expect("outside private"));
    frame.clear();
    screen
        .frame(&outside, 320, &mut frame)
        .expect("outside frame");
    assert!(frame.iter().any(|byte| *byte != 0));
}

#[test]
fn input_without_observable_windows_is_private() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut layout: Value = serde_json::from_str(LAYOUT).expect("layout");
    layout["windows"] = json!([]);
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("layout");
    let path = client(
        directory.path(),
        Some(json!({"layout":"layout.json","recorder":"input.jsonl"})),
    );
    let (screen, _) = computer::open(&path).expect("open").expect("fixture");
    assert_eq!(screen.input_private(None), Ok(true));
}

#[test]
fn overlapping_pointer_windows_are_private() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut layout: Value = serde_json::from_str(LAYOUT).expect("layout");
    layout["windows"][0]["pid"] = json!(4242);
    layout["windows"]
        .as_array_mut()
        .expect("windows")
        .push(json!({
            "id":8, "display":1, "title":"Overlapping", "owner":"fixture",
            "pid":4243, "x":10, "y":20, "width":120, "height":80
        }));
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("layout");
    let path = client(
        directory.path(),
        Some(json!({"layout":"layout.json","recorder":"input.jsonl"})),
    );
    let (screen, _) = computer::open(&path).expect("open").expect("fixture");
    assert_eq!(screen.input_private(Some((20, 30))), Ok(true));
}

#[test]
fn lost_observer_does_not_stop_display_capture_or_stream_frame() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut layout: Value = serde_json::from_str(LAYOUT).expect("layout");
    layout["windows"][0]["pid"] = json!(4242);
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("layout");
    let path = client(
        directory.path(),
        Some(json!({"layout":"layout.json","recorder":"input.jsonl"})),
    );
    let (screen, _) = computer::open(&path).expect("open").expect("fixture");
    fs::remove_file(directory.path().join("layout.json")).expect("remove layout");
    let request: ScreenCaptureRequest = oni_protocol::decode(json!({
        "target":{"kind":"display","display":1},"encoding":{"format":"png"}
    }))
    .expect("request");
    let captured = screen.capture(&request);
    assert_eq!(captured["status"], "ok");
    assert!(captured.get("accessibilityUnavailable").is_none());
    let source = serde_json::from_value(json!({"kind":"display","display":1})).expect("source");
    let mut frame = Vec::new();
    let (_, private) = screen
        .frame_private(&source, 320, &mut frame)
        .expect("stream frame");
    assert!(!private);
    assert!(frame.iter().any(|byte| *byte != 0));
}

#[test]
fn unknown_focus_refuses_text_without_injection() {
    for focus_error in [false, true] {
        let directory = tempfile::tempdir().expect("tempdir");
        observable(directory.path(), 0);
        let path = client(
            directory.path(),
            Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
        );
        let (screen, input) = computer::open(&path).expect("open").expect("fixture");
        let capture: ScreenCaptureRequest = oni_protocol::decode(json!({
            "target": { "kind": "display", "display": 1 }, "encoding": { "format": "png" }
        }))
        .expect("capture");
        let anchor = screen.capture(&capture)["captureId"]
            .as_str()
            .expect("anchor")
            .to_owned();
        let layout_path = directory.path().join("layout.json");
        let mut layout: Value =
            serde_json::from_slice(&fs::read(&layout_path).expect("layout")).expect("json");
        layout["windows"][0]["elements"][1]["focused"] = json!(focus_error);
        layout["windows"][0]["focusError"] = json!(focus_error);
        fs::write(&layout_path, layout.to_string()).expect("unknown focus");
        let text: InputTextRequest = oni_protocol::decode(
            json!({ "requestId": "1-1", "delivery": "foreground", "captureId": anchor, "text": "secret" }),
        )
        .expect("text");
        assert_eq!(
            input.text(&screen, &text),
            json!({ "status": "refused", "reason": if focus_error { "accessibility_unavailable" } else { "private" } })
        );
        assert!(!directory.path().join("input.jsonl").exists());
    }
}

#[test]
fn un_aimed_text_requires_exactly_one_focused_window() {
    for focus_count in [1, 0, 2] {
        let directory = tempfile::tempdir().expect("tempdir");
        observable(directory.path(), 0);
        let layout_path = directory.path().join("layout.json");
        let mut layout: Value =
            serde_json::from_slice(&fs::read(&layout_path).expect("layout")).expect("json");
        let mut background = layout["windows"][0].clone();
        background["id"] = json!(8);
        background["x"] = json!(160);
        background["elements"][1]["focused"] = json!(focus_count == 2);
        layout["windows"][0]["elements"][1]["focused"] = json!(focus_count > 0);
        layout["windows"]
            .as_array_mut()
            .expect("windows")
            .push(background);
        fs::write(&layout_path, layout.to_string()).expect("two windows");
        let path = client(
            directory.path(),
            Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
        );
        let (screen, input) = computer::open(&path).expect("open").expect("fixture");
        let capture: ScreenCaptureRequest = oni_protocol::decode(json!({
            "target": { "kind": "display", "display": 1 }, "encoding": { "format": "png" }
        }))
        .expect("capture");
        let frame = screen.capture(&capture);
        let text: InputTextRequest = oni_protocol::decode(json!({
            "requestId": "1-1", "delivery": "foreground",
            "captureId": frame["captureId"], "text": "hello"
        }))
        .expect("text");
        let result = input.text(&screen, &text);
        let recorder = directory.path().join("input.jsonl");
        if focus_count == 1 {
            assert_eq!(result, json!({ "status": "ok" }));
            assert_eq!(
                lines(&recorder),
                vec![json!({
                    "delivery": "foreground", "pid": null, "tag": true,
                    "event": "text", "text": "hello"
                })]
            );
        } else {
            assert_eq!(result, json!({ "status": "refused", "reason": "private" }));
            assert!(!recorder.exists());
        }
    }
}

#[test]
fn ref_action_on_a_secure_node_is_refused_private_while_absent_focus_is_not() {
    let directory = tempfile::tempdir().expect("tempdir");
    observable(directory.path(), 0);
    let layout_path = directory.path().join("layout.json");
    let mut layout: Value =
        serde_json::from_slice(&fs::read(&layout_path).expect("layout")).expect("json");
    layout["windows"][0]["elements"][1]["focused"] = json!(false);
    fs::write(&layout_path, layout.to_string()).expect("no focus");
    let path = client(
        directory.path(),
        Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
    );
    let (screen, _) = computer::open(&path).expect("open").expect("fixture");
    let target = json!({ "pid": 4242, "windowId": 7 });
    let observed = observe(&screen, json!({ "target": target, "screenshot": false }));
    assert_eq!(observed["private"], false);
    assert_eq!(observed["elements"][0]["ref"], "AXButton[0]");
    assert_eq!(observed["elements"][1]["ref"], "AXTextField[0]");
    let press = |observation: &Value| {
        json!({
            "observationId": observation["observationId"], "target": observation["target"],
            "ref": "AXButton[0]", "action": "press"
        })
    };
    assert_eq!(act(&screen, press(&observed)), json!({ "status": "ok" }));
    assert_eq!(lines(&directory.path().join("input.jsonl")).len(), 1);

    layout["windows"][0]["elements"][0]["secure"] = json!(true);
    fs::write(&layout_path, layout.to_string()).expect("secure button");
    let secure = observe(&screen, json!({ "target": target, "screenshot": false }));
    assert_eq!(
        act(&screen, press(&secure)),
        json!({ "status": "refused", "reason": "private" })
    );
    assert_eq!(lines(&directory.path().join("input.jsonl")).len(), 1);
}

#[test]
fn ref_click_targets_ordinary_window_despite_unrelated_private_focus() {
    let directory = tempfile::tempdir().expect("tempdir");
    observable(directory.path(), 0);
    let mut layout: Value =
        serde_json::from_slice(&fs::read(directory.path().join("layout.json")).expect("layout"))
            .expect("json");
    layout["windows"]
        .as_array_mut()
        .expect("windows")
        .push(json!({
            "id": 8, "display": 2, "pid": 4243, "title": "Private", "owner": "fixture",
            "x": 320, "y": 0, "width": 40, "height": 40,
            "elements": [{ "role": "AXSecureTextField", "secure": true, "focused": true,
                "frame": { "x": 0, "y": 0, "width": 40, "height": 40 } }]
        }));
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("layout");
    let path = client(
        directory.path(),
        Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
    );
    let (screen, input) = computer::open(&path).expect("open").expect("fixture");
    let observed = observe(
        &screen,
        json!({
            "target": { "pid": 4242, "windowId": 7 }, "screenshot": false
        }),
    );
    let pointer: InputPointerRequest = oni_protocol::decode(json!({
        "requestId": "1-1", "delivery": "foreground", "kind": "click", "button": "left", "count": 1,
        "at": { "observationId": observed["observationId"], "ref": "AXButton[0]" }
    }))
    .expect("pointer");
    assert_eq!(input.pointer(&screen, &pointer), json!({ "status": "ok" }));
    assert_eq!(lines(&directory.path().join("input.jsonl")).len(), 3);
}

#[test]
fn private_observation_replaces_previous_snapshot_and_is_a_diff_baseline() {
    let directory = tempfile::tempdir().expect("tempdir");
    observable(directory.path(), 0);
    let path = client(
        directory.path(),
        Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
    );
    let (screen, _) = computer::open(&path).expect("open").expect("fixture");
    let target = json!({ "pid": 4242, "windowId": 7 });
    let ordinary = observe(&screen, json!({ "target": target, "screenshot": false }));
    let mut layout: Value =
        serde_json::from_slice(&fs::read(directory.path().join("layout.json")).expect("layout"))
            .expect("json");
    layout["windows"][0]["elements"][1]["secure"] = json!(true);
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("private layout");
    let private = observe(&screen, json!({ "target": target, "screenshot": true }));
    assert_eq!(private["private"], true);
    assert!(private.get("screenshot").is_none());
    layout["windows"][0]["elements"][1]["secure"] = json!(false);
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("ordinary layout");
    assert_eq!(
        act(
            &screen,
            json!({
                "observationId": ordinary["observationId"], "target": private["target"],
                "ref": "AXButton[0]", "action": "press"
            })
        )["reason"],
        "stale_observation"
    );
    let after = observe(
        &screen,
        json!({ "target": target, "since": private["observationId"], "screenshot": false }),
    );
    assert_eq!(after["status"], "ok");
    assert!(!after["diff"]["added"].as_array().expect("added").is_empty());
}

#[test]
fn private_window_spanning_displays_masks_both_and_secondary_region() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut layout: Value = serde_json::from_str(LAYOUT).expect("layout");
    layout["windows"][0]["pid"] = json!(4242);
    layout["windows"][0]["x"] = json!(310);
    layout["windows"][0]["y"] = json!(0);
    layout["windows"][0]["width"] = json!(30);
    layout["windows"][0]["elements"] = json!([{
        "role": "AXSecureTextField", "focused": true, "secure": true,
        "frame": { "x": 0, "y": 0, "width": 30, "height": 80 }
    }]);
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("layout");
    let path = client(
        directory.path(),
        Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
    );
    let (screen, _) = computer::open(&path).expect("open").expect("fixture");
    for (source, expected, inside) in [
        (
            json!({ "kind": "display", "display": 1 }),
            (640, 400),
            (625, 5),
        ),
        (
            json!({ "kind": "display", "display": 2 }),
            (160, 100),
            (5, 5),
        ),
        (
            json!({ "kind": "display", "display": 2,
            "region": { "x": 0, "y": 0, "width": 20, "height": 20 } }),
            (20, 20),
            (5, 5),
        ),
    ] {
        let source = serde_json::from_value(source).expect("stream source");
        assert!(screen.stream_private(&source).expect("private fact"));
        let mut frame = Vec::new();
        assert_eq!(
            screen.frame(&source, 640, &mut frame).expect("frame"),
            expected
        );
        let offset = usize::try_from((inside.1 * expected.0 + inside.0) * 4).expect("pixel offset");
        assert_eq!(&frame[offset..offset + 4], &[0; 4]);
    }
}

#[test]
fn fractional_crop_masks_the_original_pixel_intersection() {
    let directory = tempfile::tempdir().expect("tempdir");
    let layout = json!({
        "displays": [{"id":1,"x":0,"y":0,"width":5,"height":5,"scale":1.6,"primary":true}],
        "windows": [{"id":7,"display":1,"title":"Private","owner":"fixture",
            "pid":4242,"x":3,"y":0,"width":1,"height":1,
            "elements":[{"role":"AXSecureTextField","secure":true,"focused":true,
                "frame":{"x":0,"y":0,"width":1,"height":1}}]}]
    });
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("layout");
    let path = client(
        directory.path(),
        Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
    );
    let (screen, _) = computer::open(&path).expect("open").expect("fixture");
    let source = serde_json::from_value(json!({
        "kind":"display","display":1,
        "region":{"x":1,"y":0,"width":3,"height":2}
    }))
    .expect("source");
    let mut frame = Vec::new();
    assert_eq!(
        screen.frame(&source, 320, &mut frame).expect("frame"),
        (6, 4)
    );
    assert_eq!(&frame[3 * 4..4 * 4], &[0; 4]);
    assert_eq!(frame[2 * 4 + 3], 255);
}

#[test]
fn stream_rechecks_focus_between_consecutive_frames() {
    let directory = tempfile::tempdir().expect("tempdir");
    observable(directory.path(), 0);
    let path = client(
        directory.path(),
        Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
    );
    let (screen, _) = computer::open(&path).expect("open").expect("fixture");
    let source =
        serde_json::from_value(json!({ "kind": "window", "windowId": "7" })).expect("source");
    let mut frame = Vec::new();
    let (_, ordinary) = screen
        .frame_private(&source, 320, &mut frame)
        .expect("ordinary");
    assert!(!ordinary);
    assert!(frame.iter().any(|byte| *byte != 0));
    let mut layout: Value =
        serde_json::from_slice(&fs::read(directory.path().join("layout.json")).expect("layout"))
            .expect("json");
    layout["windows"][0]["elements"][1]["secure"] = json!(true);
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("secure");
    let (_, private) = screen
        .frame_private(&source, 320, &mut frame)
        .expect("private");
    assert!(private);
    assert!(frame.iter().all(|byte| *byte == 0));
}

#[test]
fn missing_or_invalid_configuration_refuses_typed() {
    let directory = tempfile::tempdir().expect("tempdir");
    let absent = refusal(&directory.path().join("absent.json"));
    assert!(matches!(absent, ComputerError::Config(_)), "{absent}");
    fs::write(directory.path().join("broken.json"), "{").expect("write broken");
    let broken = refusal(&directory.path().join("broken.json"));
    assert!(matches!(broken, ComputerError::Config(_)), "{broken}");

    let block = |layout: &str| Some(json!({ "layout": layout, "recorder": "input.jsonl" }));
    let missing = refusal(&client(directory.path(), block("nowhere.json")));
    assert!(
        matches!(&missing, ComputerError::LayoutMissing(path) if path.ends_with("nowhere.json"))
    );
    assert!(missing.to_string().starts_with("computer_layout_missing: "));

    fs::create_dir(directory.path().join("folder")).expect("mkdir");
    let unreadable = refusal(&client(directory.path(), block("folder")));
    assert!(
        matches!(unreadable, ComputerError::LayoutInvalid(_)),
        "{unreadable}"
    );

    fs::write(directory.path().join("bad.json"), r#"{"displays":"none"}"#).expect("write bad");
    let invalid = refusal(&client(directory.path(), block("bad.json")));
    assert!(
        invalid.to_string().starts_with("computer_layout_invalid: "),
        "{invalid}"
    );

    fs::write(
        directory.path().join("headless.json"),
        r#"{"displays":[{"id":1,"x":0,"y":0,"width":8,"height":8,"scale":1,"primary":false}]}"#,
    )
    .expect("write headless");
    let headless = refusal(&client(directory.path(), block("headless.json")));
    assert_eq!(
        headless.to_string(),
        "computer_layout_invalid: the layout has no primary display"
    );
}

#[test]
fn recorder_names_every_event_and_refuses_an_unwritable_file() {
    let directory = tempfile::tempdir().expect("tempdir");
    assert_eq!(
        computer::record(&Event::Button {
            button: Button::Left,
            down: true,
            click: 1,
        })["button"],
        "left"
    );
    assert_eq!(
        computer::record(&Event::Button {
            button: Button::Middle,
            down: false,
            click: 1,
        })["button"],
        "middle"
    );
    assert_eq!(
        computer::record(&Event::Scroll {
            horizontal: true,
            delta: -3
        }),
        json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "scroll", "horizontal": true, "delta": -3 })
    );
    assert_eq!(
        computer::record(&Event::Key {
            key: Key::Char('a'),
            down: true
        })["key"],
        "a"
    );
    assert_eq!(
        computer::record(&Event::Key {
            key: Key::Named(Named::Enter),
            down: true
        })["key"],
        "Enter"
    );
    let mut unwritable = Recorder(directory.path().join("missing/input.jsonl"));
    assert!(unwritable.permitted());
    assert!(unwritable.inject(&Event::Text("x".into())).is_err());
}

fn observable(directory: &Path, epoch: u64) {
    let mut layout: Value = serde_json::from_str(LAYOUT).expect("layout");
    let app = json!({ "bundleId": "com.example.editor", "path": "/Applications/Editor.app/Contents/MacOS/Editor" });
    let frame = json!({ "x": 2, "y": 3, "width": 40, "height": 12 });
    layout["windows"][0]["pid"] = json!(4242);
    layout["windows"][0]["app"] = app;
    layout["windows"][0]["epoch"] = json!(epoch);
    layout["windows"][0]["elements"] = json!([
        { "role": "AXButton", "label": "OK", "actions": ["AXPress"], "frame": frame },
        { "role": "AXTextField", "label": "Name", "value": "ada",
          "frame": { "x": 50, "y": 3, "width": 40, "height": 12 }, "focused": true },
    ]);
    fs::write(directory.join("layout.json"), layout.to_string()).expect("write layout");
}

fn observe(screen: &oni_machine_client::screen::Screen, params: Value) -> Value {
    let request: ScreenObserveRequest = oni_protocol::decode(params).expect("observe request");
    screen.observe(&request)
}

fn act(screen: &oni_machine_client::screen::Screen, params: Value) -> Value {
    let mut params = params;
    params["requestId"] = json!("1-1");
    let request: InputActionRequest = oni_protocol::decode(params).expect("action request");
    action::serve_action(screen, &action::parse(&request).expect("parse"))
}

#[test]
fn superseded_action_is_cancelled_before_fixture_dispatch() {
    let directory = tempfile::tempdir().expect("tempdir");
    observable(directory.path(), 0);
    let path = client(
        directory.path(),
        Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
    );
    let (screen, input) = computer::open(&path).expect("open").expect("fixture block");
    let observed = observe(
        &screen,
        json!({ "target": { "pid": 4242, "windowId": 7 }, "screenshot": false }),
    );
    assert_eq!(observed["status"], "ok");
    let ledger = input.ledger();
    ledger.attach(1);
    let entry = ledger.start("1-1").expect("first request");
    ledger.attach(2);
    let request: InputActionRequest = oni_protocol::decode(json!({
        "requestId": "1-1", "observationId": observed["observationId"],
        "target": { "pid": 4242, "windowId": 7, "epoch": 0 },
        "ref": "AXButton[0]", "action": "press"
    }))
    .expect("action request");

    assert_eq!(
        action::serve_action_guarded(
            &screen,
            &action::parse(&request).expect("parse"),
            &entry,
            &ledger
        ),
        json!({"status":"unverifiable","reason":"cancelled","dispatched":false,"hint":"re_observe"})
    );
    assert!(!directory.path().join("input.jsonl").exists());
}

#[test]
fn fixture_windows_observe_diff_and_act_by_ref() {
    let directory = tempfile::tempdir().expect("tempdir");
    observable(directory.path(), 0);
    let path = client(
        directory.path(),
        Some(json!({ "layout": "layout.json", "recorder": "input.jsonl" })),
    );
    let (screen, input) = computer::open(&path).expect("open").expect("fixture block");
    let listed: ScreenListRequest =
        oni_protocol::decode(json!({ "windows": true })).expect("list request");
    let listed = screen.list(&listed);
    let row = &listed["windows"][0];
    assert_eq!(
        (row["pid"].clone(), row["app"].clone()),
        (
            json!(4242),
            json!({ "bundleId": "com.example.editor", "path": "/Applications/Editor.app/Contents/MacOS/Editor" })
        ),
        "a list row names the observation target and its app: {listed}"
    );
    let target = json!({ "pid": row["pid"], "windowId": 7 });
    let full = observe(
        &screen,
        json!({ "target": target, "screenshot": true, "maxElements": 5 }),
    );
    assert_eq!(full["status"], "ok", "{full}");
    assert_eq!(full["lineage"], "w4242-7-0");
    assert_eq!(full["focused"], "AXTextField[0]");
    assert_eq!(full["screenshot"]["format"], "png");
    assert_eq!(full["elements"][1]["value"], "ada");
    let first = full["observationId"].clone();
    let diff = observe(
        &screen,
        json!({ "target": target, "screenshot": false, "since": first }),
    );
    assert_eq!(
        diff["diff"],
        json!({ "since": first, "added": [], "changed": [], "removed": [] })
    );
    let latest = diff["observationId"].clone();
    let pinned = json!({ "pid": 4242, "windowId": 7, "epoch": 0 });
    let press = |observation: &Value| json!({ "observationId": observation, "target": pinned, "ref": "AXButton[0]", "action": "press" });
    assert_eq!(
        act(&screen, press(&first)),
        json!({ "status": "refused", "reason": "stale_observation" })
    );
    assert_eq!(act(&screen, press(&latest)), json!({ "status": "ok" }));
    let set = json!({ "observationId": latest, "target": pinned, "ref": "AXTextField[0]",
        "action": "setValue", "value": "grace" });
    assert_eq!(act(&screen, set), json!({ "status": "ok" }));
    let perform = json!({ "observationId": latest, "target": pinned, "ref": "AXButton[0]",
        "action": "perform", "name": "AXPress" });
    assert_eq!(act(&screen, perform), json!({ "status": "ok" }));
    let valueless = json!({ "observationId": latest, "target": pinned, "ref": "AXButton[0]",
        "action": "setValue", "value": "x" });
    assert_eq!(
        act(&screen, valueless),
        json!({ "status": "refused", "reason": "action_not_supported" })
    );
    assert_eq!(
        lines(&directory.path().join("input.jsonl")),
        vec![
            json!({ "kind": "action", "pid": 4242, "windowId": 7, "ref": "AXButton[0]", "action": "press" }),
            json!({ "kind": "action", "pid": 4242, "windowId": 7, "ref": "AXTextField[0]",
                "action": "setValue", "value": "grace" }),
            json!({ "kind": "action", "pid": 4242, "windowId": 7, "ref": "AXButton[0]",
                "action": "perform", "name": "AXPress" }),
        ]
    );
    let click = |observation: &Value| {
        let request: InputPointerRequest = oni_protocol::decode(json!({ "requestId":"1-1", "delivery": "foreground", "kind": "click",
            "at": { "observationId": observation, "ref": "AXButton[0]" }, "button": "left", "count": 1 }))
        .expect("pointer request");
        input.pointer(&screen, &request)
    };
    assert_eq!(
        click(&first),
        json!({ "status": "refused", "reason": "stale_observation" })
    );
    assert_eq!(click(&latest), json!({ "status": "ok" }));
    assert_eq!(
        lines(&directory.path().join("input.jsonl"))[3..],
        [
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "move", "x": 32, "y": 29, "ref": "AXButton[0]" }),
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "button", "button": "left", "down": true }),
            json!({ "delivery": "foreground", "pid": null, "tag": true, "event": "button", "button": "left", "down": false }),
        ]
    );
    let mut layout: Value = serde_json::from_str(
        &fs::read_to_string(directory.path().join("layout.json")).expect("read layout"),
    )
    .expect("layout");
    for x in [5000_i64, 3_000_000_000] {
        layout["windows"][0]["x"] = json!(x);
        fs::write(directory.path().join("layout.json"), layout.to_string()).expect("write layout");
        assert_eq!(
            click(&latest),
            json!({ "status": "refused", "reason": "invalid_region" }),
            "{x}"
        );
    }

    observable(directory.path(), 1);
    assert_eq!(
        click(&latest),
        json!({ "status": "refused", "reason": "epoch_changed" })
    );
    let recreated = observe(&screen, json!({ "target": pinned, "screenshot": false }));
    assert_eq!(
        recreated,
        json!({ "status": "refused", "reason": "epoch_changed" })
    );
    assert_eq!(
        act(&screen, press(&latest)),
        json!({ "status": "refused", "reason": "epoch_changed" })
    );
    let missing = observe(
        &screen,
        json!({ "target": { "pid": 4242, "windowId": 8 }, "screenshot": false }),
    );
    assert_eq!(
        missing,
        json!({ "status": "refused", "reason": "window_not_found" })
    );

    let mut layout: Value = serde_json::from_str(
        &fs::read_to_string(directory.path().join("layout.json")).expect("read layout"),
    )
    .expect("layout");
    layout["windows"]
        .as_array_mut()
        .expect("windows")
        .push(json!({ "id": 9, "title": "Late", "pid": 4243, "focusError": true }));
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("write layout");
    let late = json!({ "pid": 4243, "windowId": 9 });
    assert_eq!(
        observe(&screen, json!({ "target": late, "screenshot": true })),
        json!({ "status": "refused", "reason": "observe_failed" })
    );
    let unshot = observe(&screen, json!({ "target": late, "screenshot": false }));
    assert_eq!(
        unshot,
        json!({ "status": "refused", "reason": "observe_failed" })
    );
}

#[test]
fn actions_missing_their_argument_are_invalid_params() {
    let base = json!({ "requestId":"1-1", "observationId": "o1", "target": { "pid": 1, "windowId": 2, "epoch": 0 }, "ref": "AXButton[0]" });
    for (verb, extra) in [("setValue", "name"), ("perform", "value")] {
        let mut params = base.clone();
        params["action"] = json!(verb);
        params[extra] = json!("AXPress");
        let request: InputActionRequest = oni_protocol::decode(params).expect("action request");
        assert!(action::parse(&request).is_err(), "{verb}");
    }
    let mut perform = base;
    perform["action"] = json!("perform");
    perform["name"] = json!("AXShowMenu");
    let request: InputActionRequest = oni_protocol::decode(perform).expect("action request");
    assert_eq!(action::parse(&request).expect("parsed").wait_ms, 2000);
    let mut zero_wait = json!({ "requestId":"1-1", "observationId": "o1",
        "target": { "pid": 1, "windowId": 2, "epoch": 0 },
        "ref": "AXButton[0]", "action": "press", "waitMs": 0 });
    let request: InputActionRequest = oni_protocol::decode(zero_wait.clone()).expect("zero wait");
    assert_eq!(action::parse(&request).expect("parsed").wait_ms, 0);
    zero_wait["waitMs"] = json!(10_000);
    let request: InputActionRequest = oni_protocol::decode(zero_wait).expect("maximum wait");
    assert_eq!(action::parse(&request).expect("parsed").wait_ms, 10_000);
}
