use std::sync::{Arc, Mutex};

use oni_machine_client::{
    input::{
        key,
        recorder::Recorder,
        Button::{Left, Middle, Right},
        Event::{self, Button, Key, Move, Scroll, Text},
        Input, Key as K, Named,
    },
    screen::{Display, Fault, Screen, Source, Window},
};
use oni_protocol::{
    InputKeyRequest, InputPointerRequest, InputTextRequest, InputWriteRequest,
    ScreenCaptureRequest, ScreenCaptureResult,
};
use serde_json::{json, Value};

#[derive(Default)]
struct Layout {
    displays: Vec<Display>,
    denied: bool,
    failure: Option<String>,
}

/// A display layout tests rearrange between capture and input.
#[derive(Clone, Default)]
struct Desk(Arc<Mutex<Layout>>);

impl Desk {
    fn layout(&self) -> std::sync::MutexGuard<'_, Layout> {
        self.0.lock().expect("layout")
    }
}

impl Source for Desk {
    fn ready(&self) -> Result<(), Fault> {
        if self.layout().denied {
            return Err(Fault::Permission);
        }
        Ok(())
    }

    fn displays(&self) -> Result<Vec<Display>, Fault> {
        let layout = self.layout();
        match &layout.failure {
            Some(failure) => Err(Fault::Failed(failure.clone())),
            None => Ok(layout.displays.clone()),
        }
    }

    fn windows(&self) -> Result<Vec<Window>, Fault> {
        Ok(vec![])
    }

    fn capture_display(&self, _: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        pixels.clear();
        pixels.extend_from_slice(&[0, 0, 0, 255]);
        Ok((1, 1))
    }

    fn capture_window(&self, _: u32, _: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        Err(Fault::WindowNotFound)
    }
}

fn display(id: u32, x: i32, width: u32, height: u32) -> Display {
    Display {
        id,
        x,
        y: 10,
        width,
        height,
        scale: 1.0,
        primary: id == 1,
    }
}

struct Rig {
    desk: Desk,
    screen: Screen,
    recorder: Recorder,
    input: Input,
}

/// Display 1 (primary) is 100x50 at (0, 10); display 2 is 80x40 at (100, 10).
fn rig() -> Rig {
    let desk = Desk::default();
    desk.layout().displays = vec![display(1, 0, 100, 50), display(2, 100, 80, 40)];
    let recorder = Recorder::default();
    Rig {
        screen: Screen::new(Box::new(desk.clone()), 2),
        desk,
        input: Input::new(recorder.clone()),
        recorder,
    }
}

fn decode<T: oni_protocol::WireRoot>(value: Value) -> T {
    oni_protocol::decode(value).expect("valid request")
}

impl Rig {
    fn capture(&self, display: u64) -> String {
        let request: ScreenCaptureRequest = decode(
            json!({"target":{"kind":"display","display":display},"encoding":{"format":"png"}}),
        );
        match decode(self.screen.capture(&request)) {
            ScreenCaptureResult::Ok { capture_id, .. } => capture_id.to_string(),
            refused => panic!("capture refused: {refused:?}"),
        }
    }

    fn pointer(&self, request: Value) -> Value {
        let request: InputPointerRequest = decode(request);
        self.input.pointer(&self.screen, &request)
    }

    fn key(&self, request: Value) -> Value {
        let request: InputKeyRequest = decode(request);
        self.input.key(&self.screen, &request)
    }

    fn text(&self, capture: &str, text: &str) -> Value {
        let request: InputTextRequest = decode(json!({"captureId":capture,"text":text}));
        self.input.text(&self.screen, &request)
    }

    fn write(&self, capture: &str, actions: Value) -> Value {
        let request: InputWriteRequest = decode(json!({"captureId":capture,"actions":actions}));
        self.input.write(&self.screen, &request)
    }

    /// Asserts `answer` refused `reason` and that nothing was injected.
    fn refused(&self, answer: &Value, reason: &str) {
        assert_eq!(answer["status"], "refused", "{answer}");
        assert_eq!(answer["reason"], reason, "{answer}");
        assert_eq!(self.recorder.events(), [], "{answer}");
    }
}

fn ok() -> Value {
    json!({"status":"ok"})
}

fn click(capture: &str, x: i64, y: i64) -> Value {
    json!({"kind":"click","captureId":capture,"x":x,"y":y,"button":"left","count":1})
}

#[test]
fn key_names_parse_characters_function_keys_and_named_keys() {
    assert_eq!(key("a"), Some(K::Char('a')));
    assert_eq!(key("é"), Some(K::Char('é')));
    assert_eq!(key("\u{7}"), None);
    assert_eq!(key("Enter"), Some(K::Named(Named::Enter)));
    assert_eq!(key("return"), Some(K::Named(Named::Enter)));
    assert_eq!(key("PAGEDOWN"), Some(K::Named(Named::PageDown)));
    assert_eq!(key("F1"), Some(K::Named(Named::F(1))));
    assert_eq!(key("f12"), Some(K::Named(Named::F(12))));
    for unknown in ["F0", "F13", "Fx", "Hyper", "Ctrl"] {
        assert_eq!(key(unknown), None, "{unknown}");
    }
}

#[test]
fn pointer_actions_translate_display_points_to_global_points() {
    let rig = rig();
    let capture = rig.capture(2);
    let double = json!({"kind":"click","captureId":capture,"x":5,"y":6,"button":"right","count":2});
    assert_eq!(rig.pointer(double), ok());
    let hold =
        json!({"kind":"button","captureId":capture,"x":79,"y":39,"button":"middle","state":"down"});
    assert_eq!(rig.pointer(hold), ok());
    let lift =
        json!({"kind":"button","captureId":capture,"x":0,"y":0,"button":"left","state":"up"});
    assert_eq!(rig.pointer(lift), ok());
    let scroll =
        json!({"kind":"scroll","captureId":capture,"x":1,"y":2,"deltaX":3,"deltaY":-10000});
    assert_eq!(rig.pointer(scroll), ok());
    let still = json!({"kind":"scroll","captureId":capture,"x":1,"y":2,"deltaX":0,"deltaY":0});
    assert_eq!(rig.pointer(still), ok());
    let hover = json!({"kind":"move","captureId":capture,"x":2,"y":3});
    assert_eq!(rig.pointer(hover), ok());
    let right = |down| Button {
        button: Right,
        down,
    };
    assert_eq!(
        rig.recorder.events(),
        [
            Move { x: 105, y: 16 },
            right(true),
            right(false),
            right(true),
            right(false),
            Move { x: 179, y: 49 },
            Button {
                button: Middle,
                down: true
            },
            Move { x: 100, y: 10 },
            Button {
                button: Left,
                down: false
            },
            Move { x: 101, y: 12 },
            Scroll {
                horizontal: true,
                delta: 3
            },
            Scroll {
                horizontal: false,
                delta: -10000
            },
            Move { x: 101, y: 12 },
            Move { x: 102, y: 13 },
        ]
    );
}

#[test]
fn points_outside_the_anchored_display_refuse_invalid_region() {
    let rig = rig();
    let capture = rig.capture(2);
    for (x, y) in [(80, 0), (0, 40), (16_384, 16_384)] {
        rig.refused(&rig.pointer(click(&capture, x, y)), "invalid_region");
    }
    let primary = rig.capture(1);
    for (x, y) in [(100, 0), (0, 50), (1_000_000, 0)] {
        let answer = rig.write(
            &primary,
            json!([{"move":{"x":0,"y":0}},{"move":{"x":x,"y":y}}]),
        );
        rig.refused(&answer, "invalid_region");
    }
}

#[test]
fn only_the_latest_capture_of_an_unchanged_display_anchors_input() {
    let rig = rig();
    let first = rig.capture(1);
    let latest = rig.capture(1);
    rig.refused(&rig.pointer(click(&first, 1, 1)), "stale_capture");
    rig.refused(&rig.text("cap-999", "x"), "stale_capture");
    rig.desk.layout().displays[0].width = 99;
    rig.refused(&rig.pointer(click(&latest, 1, 1)), "stale_capture");
    rig.desk.layout().displays[0].width = 100;
    assert_eq!(rig.pointer(click(&latest, 1, 1)), ok());
    rig.screen.forget();
    let before = rig.recorder.events();
    let answer = rig.pointer(click(&latest, 1, 1));
    assert_eq!(answer["reason"], "stale_capture");
    assert_eq!(rig.recorder.events(), before);
}

#[test]
fn a_vanished_or_unreadable_screen_refuses_before_any_injection() {
    let rig = rig();
    let capture = rig.capture(1);
    rig.desk.layout().displays.clear();
    rig.refused(&rig.pointer(click(&capture, 1, 1)), "input_not_available");
    rig.desk.layout().displays = vec![display(1, 0, 100, 50)];
    rig.desk.layout().denied = true;
    rig.refused(&rig.pointer(click(&capture, 1, 1)), "permission_denied");
    rig.desk.layout().denied = false;
    rig.desk.layout().failure = Some("display server went away".into());
    let answer = rig.pointer(click(&capture, 1, 1));
    rig.refused(&answer, "input_failed");
    assert!(answer["message"]
        .as_str()
        .expect("message")
        .contains("display server went away"));
    let recorder = Recorder::default();
    let headless = Input::new(recorder.clone());
    let answer = headless.text(
        &Screen::absent(),
        &decode(json!({"captureId":capture,"text":"x"})),
    );
    assert_eq!(answer["reason"], "input_not_available");
    assert_eq!(recorder.events(), []);
}

#[test]
fn a_withdrawn_or_absent_driver_injects_nothing() {
    let rig = rig();
    let capture = rig.capture(1);
    assert!(rig.input.available());
    rig.recorder.deny(true);
    rig.refused(&rig.pointer(click(&capture, 1, 1)), "permission_denied");
    let denied = Recorder::default();
    denied.deny(true);
    assert!(!Input::new(denied).available());
    let absent = Input::absent();
    assert!(!absent.available());
    absent.settle();
    rig.input.settle();
    let answer = absent.key(
        &rig.screen,
        &decode(json!({"captureId":capture,"key":"a","action":"press"})),
    );
    assert_eq!(
        answer,
        json!({"status":"refused","reason":"input_not_available"})
    );
}

#[test]
fn keys_press_hold_and_release_with_modifiers_in_order() {
    let rig = rig();
    let capture = rig.capture(1);
    let press = json!({"captureId":capture,"key":"t","action":"press",
        "modifiers":{"shift":true,"control":false,"meta":true}});
    assert_eq!(rig.key(press), ok());
    let down = json!({"captureId":capture,"key":"Shift","action":"down","modifiers":{}});
    assert_eq!(rig.key(down), ok());
    let up = json!({"captureId":capture,"key":"F5","action":"up","modifiers":{"alt":true}});
    assert_eq!(rig.key(up), ok());
    let named = |named, down| Key {
        key: K::Named(named),
        down,
    };
    assert_eq!(
        rig.recorder.events(),
        [
            named(Named::Shift, true),
            named(Named::Meta, true),
            Key {
                key: K::Char('t'),
                down: true
            },
            Key {
                key: K::Char('t'),
                down: false
            },
            named(Named::Meta, false),
            named(Named::Shift, false),
            named(Named::Shift, true),
            named(Named::F(5), false),
            named(Named::Alt, false),
        ]
    );
}

#[test]
fn unknown_keys_and_unsafe_text_refuse_unsupported_action() {
    let rig = rig();
    let capture = rig.capture(1);
    let answer = rig.key(json!({"captureId":capture,"key":"Hyper","action":"press"}));
    rig.refused(&answer, "unsupported_action");
    assert_eq!(answer["message"], "unknown key: Hyper");
    let answer = rig.text(&capture, "ok\u{1b}[2J");
    rig.refused(&answer, "unsupported_action");
    assert_eq!(answer["message"], "text contains control character U+001B");
    assert_eq!(rig.text(&capture, "line\n\tnext ✓"), ok());
    assert_eq!(rig.text(&capture, &"x".repeat(10_000)), ok());
    assert_eq!(
        rig.recorder.events(),
        [Text("line\n\tnext ✓".into()), Text("x".repeat(10_000))]
    );
}

#[test]
fn a_legacy_batch_is_validated_whole_before_its_first_action() {
    let rig = rig();
    let capture = rig.capture(1);
    let first = json!({"click":{"x":1,"y":1}});
    let half = "y".repeat(5_001);
    let cases = [
        (
            json!([first, {"key":{"name":"Bogus"}}]),
            "unsupported_action",
        ),
        (
            json!([first, {"key":{"name":"Shift+"}}]),
            "unsupported_action",
        ),
        (json!([first, {"key":{"name":"a+b"}}]), "unsupported_action"),
        (
            json!([first, {"key":{"name":"Hyper+b"}}]),
            "unsupported_action",
        ),
        (json!([first, {"click":{"x":100,"y":1}}]), "invalid_region"),
        (
            json!([first, {"scroll":{"deltaY":10_001}}]),
            "unsupported_action",
        ),
        (
            json!([first, {"scroll":{"deltaX":-9_007_199_254_740_991_i64}}]),
            "unsupported_action",
        ),
        (
            json!([{"type":{"text":half}}, {"type":{"text":half}}]),
            "unsupported_action",
        ),
    ];
    for (actions, reason) in cases {
        rig.refused(&rig.write(&capture, actions), reason);
    }
}

#[test]
fn a_legacy_batch_runs_on_the_main_display_only() {
    let rig = rig();
    let side = rig.capture(2);
    let answer = rig.write(&side, json!([{"move":{"x":1,"y":1}}]));
    rig.refused(&answer, "unsupported_action");
    assert!(answer["message"]
        .as_str()
        .expect("message")
        .contains("main-display only"));
    let main = rig.capture(1);
    let actions = json!([
        {"click":{"x":3,"y":4}},
        {"click":{"x":3,"y":4,"button":"middle"}},
        {"move":{"x":99,"y":49}},
        {"type":{"text":"hi"}},
        {"key":{"name":"Control+Shift+t"}},
        {"scroll":{"deltaX":-2}},
        {"scroll":{}},
    ]);
    assert_eq!(rig.write(&main, actions), ok());
    let named = |named, down| Key {
        key: K::Named(named),
        down,
    };
    let at = Move { x: 3, y: 14 };
    let button = |button, down| Button { button, down };
    assert_eq!(
        rig.recorder.events(),
        [
            at.clone(),
            button(Left, true),
            button(Left, false),
            at,
            button(Middle, true),
            button(Middle, false),
            Move { x: 99, y: 59 },
            Text("hi".into()),
            named(Named::Control, true),
            named(Named::Shift, true),
            Key {
                key: K::Char('t'),
                down: true
            },
            Key {
                key: K::Char('t'),
                down: false
            },
            named(Named::Shift, false),
            named(Named::Control, false),
            Scroll {
                horizontal: true,
                delta: -2
            },
        ]
    );
}

#[test]
fn a_driver_failure_releases_what_the_request_pressed() {
    let rig = rig();
    let capture = rig.capture(1);
    let chord = json!({"captureId":capture,"key":"a","action":"press","modifiers":{"shift":true}});
    rig.recorder.fail(&[1]);
    let answer = rig.key(chord.clone());
    assert_eq!(answer["reason"], "input_failed");
    assert_eq!(
        answer["message"],
        "input driver failed: scripted failure at attempt 1"
    );
    let shift = |down| Key {
        key: K::Named(Named::Shift),
        down,
    };
    assert_eq!(rig.recorder.events(), [shift(true), shift(false)]);

    rig.recorder.fail(&[1, 2]);
    let answer = rig.key(chord);
    assert_eq!(
        answer["message"],
        "input driver failed: scripted failure at attempt 4; 1 held inputs not released"
    );
    assert_eq!(rig.recorder.events().len(), 3);

    rig.recorder.fail(&[3]);
    let answer = rig.write(
        &capture,
        json!([{"click":{"x":1,"y":1}},{"type":{"text":"z"}}]),
    );
    assert_eq!(answer["reason"], "input_failed");
    let tail: Vec<Event> = rig.recorder.events().split_off(3);
    assert_eq!(
        tail,
        [
            Move { x: 1, y: 11 },
            Button {
                button: Left,
                down: true
            },
            Button {
                button: Left,
                down: false
            },
        ]
    );
}

#[cfg(target_os = "linux")]
#[test]
fn the_platform_driver_is_absent_without_a_display_server() {
    if std::env::var_os("DISPLAY").is_none() {
        assert!(!Input::platform().available());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn the_platform_driver_reflects_the_accessibility_grant() {
    use oni_machine_client::input::Driver;
    let platform = Input::platform();
    let mapped = oni_machine_client::input::native::Native(fake::Fake::default());
    assert_eq!(platform.available(), mapped.permitted());
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod fake {
    use std::sync::{Arc, Mutex};

    use enigo::{Axis, Coordinate, Direction, InputError, InputResult, Keyboard, Mouse};

    #[derive(Clone, Debug, PartialEq)]
    pub enum Call {
        Button(enigo::Button, Direction),
        Move(i32, i32, Coordinate),
        Scroll(i32, Axis),
        Key(enigo::Key, Direction),
        Text(String),
    }

    #[derive(Clone, Default)]
    pub struct Fake {
        pub calls: Arc<Mutex<Vec<Call>>>,
        pub failing: bool,
    }

    impl Fake {
        fn record(&self, call: Call) -> InputResult<()> {
            if self.failing {
                return Err(InputError::Simulate("refused by the fake"));
            }
            self.calls.lock().expect("calls").push(call);
            Ok(())
        }
    }

    impl Mouse for Fake {
        fn button(&mut self, button: enigo::Button, direction: Direction) -> InputResult<()> {
            self.record(Call::Button(button, direction))
        }

        fn move_mouse(&mut self, x: i32, y: i32, coordinate: Coordinate) -> InputResult<()> {
            self.record(Call::Move(x, y, coordinate))
        }

        fn scroll(&mut self, length: i32, axis: Axis) -> InputResult<()> {
            self.record(Call::Scroll(length, axis))
        }

        fn main_display(&self) -> InputResult<(i32, i32)> {
            Err(InputError::Simulate("not used"))
        }

        fn location(&self) -> InputResult<(i32, i32)> {
            Err(InputError::Simulate("not used"))
        }
    }

    impl Keyboard for Fake {
        fn fast_text(&mut self, text: &str) -> InputResult<Option<()>> {
            self.record(Call::Text(text.to_owned())).map(Some)
        }

        fn key(&mut self, key: enigo::Key, direction: Direction) -> InputResult<()> {
            self.record(Call::Key(key, direction))
        }

        fn raw(&mut self, _: u16, _: Direction) -> InputResult<()> {
            Err(InputError::Simulate("not used"))
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn the_native_driver_maps_every_event_onto_enigo() {
    use enigo::{Axis, Coordinate, Direction};
    use fake::{Call, Fake};
    use oni_machine_client::input::{native, Driver};

    let fake = Fake::default();
    let mut driver = native::Native(fake.clone());
    let events = [
        Move { x: -5, y: 7 },
        Button {
            button: Left,
            down: true,
        },
        Button {
            button: Right,
            down: false,
        },
        Button {
            button: Middle,
            down: true,
        },
        Scroll {
            horizontal: true,
            delta: 2,
        },
        Scroll {
            horizontal: false,
            delta: -3,
        },
        Key {
            key: K::Char('q'),
            down: true,
        },
        Key {
            key: K::Named(Named::Enter),
            down: false,
        },
        Text("hé".into()),
    ];
    for event in &events {
        driver.inject(event).expect("fake accepts");
    }
    assert_eq!(
        *fake.calls.lock().expect("calls"),
        [
            Call::Move(-5, 7, Coordinate::Abs),
            Call::Button(enigo::Button::Left, Direction::Press),
            Call::Button(enigo::Button::Right, Direction::Release),
            Call::Button(enigo::Button::Middle, Direction::Press),
            Call::Scroll(2, Axis::Horizontal),
            Call::Scroll(-3, Axis::Vertical),
            Call::Key(enigo::Key::Unicode('q'), Direction::Press),
            Call::Key(enigo::Key::Return, Direction::Release),
            Call::Text("hé".into()),
        ]
    );
    let mut refusing = native::Native(Fake {
        failing: true,
        ..Fake::default()
    });
    assert_eq!(
        refusing.inject(&Text("x".into())),
        Err("simulating input failed: (refused by the fake)".to_owned())
    );
    #[cfg(target_os = "linux")]
    assert!(refusing.permitted());
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn every_named_key_maps_onto_a_distinct_enigo_key() {
    use oni_machine_client::input::native;
    let named = [
        Named::Enter,
        Named::Tab,
        Named::Escape,
        Named::Backspace,
        Named::Delete,
        Named::Space,
        Named::ArrowUp,
        Named::ArrowDown,
        Named::ArrowLeft,
        Named::ArrowRight,
        Named::Home,
        Named::End,
        Named::PageUp,
        Named::PageDown,
        Named::CapsLock,
        Named::Shift,
        Named::Control,
        Named::Alt,
        Named::Meta,
    ];
    let mut mapped: Vec<enigo::Key> = named
        .into_iter()
        .chain((1..=12).map(Named::F))
        .map(|named| native::key(K::Named(named)).expect("every named key is mapped"))
        .collect();
    let total = mapped.len();
    mapped.sort_by_key(|key| format!("{key:?}"));
    mapped.dedup();
    assert_eq!(mapped.len(), total);
    assert_eq!(native::key(K::Named(Named::F(0))), Some(enigo::Key::F1));
    assert_eq!(native::key(K::Named(Named::F(99))), Some(enigo::Key::F12));
}

#[test]
fn held_keys_and_buttons_survive_requests_until_settled() {
    let rig = rig();
    let capture = rig.capture(1);
    let shift = |down| Key {
        key: K::Named(Named::Shift),
        down,
    };
    let left = |down| Button { button: Left, down };
    let down = json!({"captureId":capture,"key":"Shift","action":"down"});
    assert_eq!(rig.key(down), ok());
    let press =
        json!({"kind":"button","captureId":capture,"x":1,"y":1,"button":"left","state":"down"});
    assert_eq!(rig.pointer(press), ok());
    let held = rig.recorder.events();
    rig.input.settle();
    let released: Vec<Event> = rig.recorder.events().split_off(held.len());
    assert_eq!(released, [left(false), shift(false)], "released in reverse");
    rig.input.settle();
    assert_eq!(
        rig.recorder.events().len(),
        held.len() + 2,
        "nothing is released twice"
    );

    let down = json!({"captureId":capture,"key":"Shift","action":"down"});
    assert_eq!(rig.key(down), ok());
    let up = json!({"captureId":capture,"key":"Shift","action":"up"});
    assert_eq!(rig.key(up), ok());
    let before = rig.recorder.events().len();
    rig.input.settle();
    assert_eq!(
        rig.recorder.events().len(),
        before,
        "a released key stays released"
    );
    assert_eq!(
        rig.recorder.events()[before - 2..],
        [shift(true), shift(false)]
    );
}
