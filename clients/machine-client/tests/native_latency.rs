//! Native observation latency harness (#1689 D8). It needs the Screen
//! Recording and Accessibility grants and a window holding a pressable
//! element, so it is ignored by default and runs only in the grant-enabled
//! acceptance run (#1702):
//!
//! ```text
//! ONI_LATENCY_PID=<pid> ONI_LATENCY_WINDOW=<windowId> ONI_LATENCY_REF=<ref> \
//!   cargo test -p oni-machine-client --test native_latency -- --ignored --nocapture
//! ```
//!
//! It prints tree-only observe p50, ref-press p50 and the unchanged-diff
//! wire bytes, and asserts that a press never moves the pointer.
#![cfg(target_os = "macos")]

use std::time::{Duration, Instant};

use oni_machine_client::{input::action, screen::Screen};
use oni_protocol::{InputActionRequest, ScreenObserveRequest};
use serde_json::{json, Value};

const SAMPLES: usize = 21;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct Point {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreate(source: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CGEventGetLocation(event: *const std::ffi::c_void) -> Point;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(object: *const std::ffi::c_void);
}

fn pointer() -> Point {
    // SAFETY: a null-source event is a snapshot of the current pointer; it
    // is released after its location is read.
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        assert!(!event.is_null(), "CGEventCreate returned null");
        let location = CGEventGetLocation(event);
        CFRelease(event);
        location
    }
}

fn variable(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must name the acceptance target"))
}

fn observe(screen: &Screen, params: Value) -> (Value, usize, Duration) {
    let request: ScreenObserveRequest = oni_protocol::decode(params).expect("observe request");
    let started = Instant::now();
    let body = screen.observe(&request);
    let elapsed = started.elapsed();
    assert_eq!(body["status"], "ok", "{body}");
    (body.clone(), body.to_string().len(), elapsed)
}

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    samples[samples.len() / 2]
}

#[test]
#[ignore = "needs the Screen Recording and Accessibility grants (#1702)"]
fn native_observe_and_ref_press_latency() {
    let screen = Screen::platform();
    let pid: u32 = variable("ONI_LATENCY_PID").parse().expect("pid");
    let window: u32 = variable("ONI_LATENCY_WINDOW").parse().expect("window id");
    let reference = variable("ONI_LATENCY_REF");
    let target = json!({ "pid": pid, "windowId": window });

    let observes: Vec<Duration> = (0..SAMPLES)
        .map(|_| observe(&screen, json!({ "target": target, "screenshot": false })).2)
        .collect();
    let (latest, _, _) = observe(&screen, json!({ "target": target, "screenshot": false }));
    let (diff, diff_bytes, _) = observe(
        &screen,
        json!({ "target": target, "screenshot": false, "since": latest["observationId"] }),
    );
    assert!(
        diff.get("diff").is_some(),
        "an unchanged window answers a diff: {diff}"
    );

    let mut observation = diff;
    let mut presses = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let request: InputActionRequest = oni_protocol::decode(json!({
            "requestId": "1-1",
            "observationId": observation["observationId"],
            "target": observation["target"],
            "ref": reference,
            "action": "press",
        }))
        .expect("action request");
        let act = action::parse(&request).expect("parse");
        let before = pointer();
        let started = Instant::now();
        let answer = action::serve_action(&screen, &act);
        presses.push(started.elapsed());
        assert_eq!(answer, json!({ "status": "ok" }));
        assert_eq!(pointer(), before, "a ref press moved the pointer");
        observation = observe(&screen, json!({ "target": target, "screenshot": false })).0;
    }

    println!(
        "observe_p50_ms={:.2} press_p50_ms={:.2} unchanged_diff_bytes={diff_bytes}",
        median(observes).as_secs_f64() * 1000.0,
        median(presses).as_secs_f64() * 1000.0,
    );
}
