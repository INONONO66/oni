use std::{fs, path::Path};

use oni_machine_client::{
    computer::{self, ComputerError, Recorder},
    input::{Button, Driver, Event, Key, Named},
};
use oni_protocol::{InputKeyRequest, InputPointerRequest, InputTextRequest, ScreenCaptureRequest};
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
        json!({ "kind": "click", "captureId": capture, "x": 4, "y": 5, "button": "right", "count": 1 }),
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
