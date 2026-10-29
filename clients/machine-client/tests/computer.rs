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

#[test]
fn fixture_block_serves_frames_and_records_input() {
    let directory = tempfile::tempdir().expect("tempdir");
    fs::write(directory.path().join("layout.json"), LAYOUT).expect("write layout");
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
        json!({ "kind": "click", "at":{"captureId": capture, "x": 4, "y": 5}, "button": "right", "count": 1 }),
    )
    .expect("pointer request");
    assert_eq!(input.pointer(&screen, &pointer)["status"], "ok");
    let key: InputKeyRequest = oni_protocol::decode(
        json!({ "captureId": capture, "key": "F5", "action": "press", "modifiers": { "shift": true } }),
    )
    .expect("key request");
    assert_eq!(input.key(&screen, &key)["status"], "ok");
    let text: InputTextRequest =
        oni_protocol::decode(json!({ "captureId": capture, "text": "hi" })).expect("text request");
    assert_eq!(input.text(&screen, &text)["status"], "ok");
    assert_eq!(
        lines(&directory.path().join("input.jsonl")),
        vec![
            json!({ "event": "move", "x": 324, "y": 5 }),
            json!({ "event": "button", "button": "right", "down": true }),
            json!({ "event": "button", "button": "right", "down": false }),
            json!({ "event": "key", "key": "Shift", "down": true }),
            json!({ "event": "key", "key": "F5", "down": true }),
            json!({ "event": "key", "key": "F5", "down": false }),
            json!({ "event": "key", "key": "Shift", "down": false }),
            json!({ "event": "text", "text": "hi" }),
        ]
    );
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
            down: true
        })["button"],
        "left"
    );
    assert_eq!(
        computer::record(&Event::Button {
            button: Button::Middle,
            down: false
        })["button"],
        "middle"
    );
    assert_eq!(
        computer::record(&Event::Scroll {
            horizontal: true,
            delta: -3
        }),
        json!({ "event": "scroll", "horizontal": true, "delta": -3 })
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
        { "role": "AXTextField", "label": "Name", "value": "ada", "frame": frame, "focused": true },
    ]);
    fs::write(directory.join("layout.json"), layout.to_string()).expect("write layout");
}

fn observe(screen: &oni_machine_client::screen::Screen, params: Value) -> Value {
    let request: ScreenObserveRequest = oni_protocol::decode(params).expect("observe request");
    screen.observe(&request)
}

fn act(screen: &oni_machine_client::screen::Screen, params: Value) -> Value {
    let request: InputActionRequest = oni_protocol::decode(params).expect("action request");
    action::serve_action(screen, &action::parse(&request).expect("parse"))
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
        let request: InputPointerRequest = oni_protocol::decode(json!({ "kind": "click",
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
            json!({ "event": "move", "x": 32, "y": 29, "ref": "AXButton[0]" }),
            json!({ "event": "button", "button": "left", "down": true }),
            json!({ "event": "button", "button": "left", "down": false }),
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
        .push(json!({ "id": 9, "title": "Late", "pid": 4243 }));
    fs::write(directory.path().join("layout.json"), layout.to_string()).expect("write layout");
    let late = json!({ "pid": 4243, "windowId": 9 });
    assert_eq!(
        observe(&screen, json!({ "target": late, "screenshot": true })),
        json!({ "status": "refused", "reason": "window_not_found" })
    );
    let unshot = observe(&screen, json!({ "target": late, "screenshot": false }));
    assert_eq!(
        unshot["window"]["app"],
        json!({ "bundleId": null, "path": "/fixture/4243" })
    );
}

#[test]
fn actions_missing_their_argument_are_invalid_params() {
    let base = json!({ "observationId": "o1", "target": { "pid": 1, "windowId": 2, "epoch": 0 }, "ref": "AXButton[0]" });
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
    assert!(action::parse(&request).is_ok());
}
