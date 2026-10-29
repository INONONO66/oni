#![cfg(target_os = "macos")]

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_machine_client::{app, screen::Screen};
use oni_protocol::AppLaunchRequest;
use serde_json::json;
use std::{
    fs, io::Read, os::unix::net::UnixListener, process::Command, sync::mpsc, time::Duration,
};

struct Process(u32);
impl Drop for Process {
    fn drop(&mut self) {
        if let Err(error) = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(i32::try_from(self.0).expect("pid")),
            nix::sys::signal::Signal::SIGTERM,
        ) {
            eprintln!("fixture termination failed: {error}");
        }
    }
}

#[test]
#[ignore = "requires Screen Recording and Accessibility grants; live receipt belongs to #1702"]
fn an_occluded_fixture_window_captures_its_own_backing_store() {
    let directory = tempfile::tempdir().expect("tempdir");
    let bundle = directory.path().join("CaptureFixture.app");
    let contents = bundle.join("Contents");
    fs::create_dir_all(contents.join("MacOS")).expect("bundle");
    fs::write(contents.join("Info.plist"), r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>capture-fixture</string><key>CFBundleIdentifier</key><string>org.oni.capture-fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>"#).expect("plist");
    let source = directory.path().join("fixture.swift");
    fs::write(&source, include_str!("fixtures/computer/occlusion.swift")).expect("source");
    assert!(Command::new("/usr/bin/swiftc")
        .arg(&source)
        .arg("-o")
        .arg(contents.join("MacOS/capture-fixture"))
        .status()
        .expect("swiftc")
        .success());
    let socket = directory.path().join("ready.sock");
    let listener = UnixListener::bind(&socket).expect("listener");
    let (ready, received) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("fixture connection");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("timeout");
        let mut byte = [0];
        stream.read_exact(&mut byte).expect("window readiness");
        ready.send(byte).expect("subscriber");
    });
    let screen = Screen::platform();
    let request: AppLaunchRequest = oni_protocol::decode(json!({
        "app":{"path":bundle,"args":[socket]},"activate":false,"freshInstance":true
    }))
    .expect("launch request");
    let launched = app::launch(&screen, &request);
    assert_eq!(launched["status"], "ok", "{launched}");
    let process = Process(u32::try_from(launched["pid"].as_u64().expect("pid")).expect("pid"));
    assert_eq!(
        received
            .recv_timeout(Duration::from_secs(10))
            .expect("both windows ready"),
        [1]
    );
    let windows = xcap::Window::all().expect("windows");
    let find = |title: &str| {
        windows
            .iter()
            .find(|window| {
                window.pid().ok() == Some(process.0)
                    && window.title().ok().as_deref() == Some(title)
            })
            .expect("fixture window")
    };
    let (target, cover) = (find("Oni capture target"), find("Oni capture cover"));
    assert_eq!(
        (
            target.x().expect("x"),
            target.y().expect("y"),
            target.width().expect("width"),
            target.height().expect("height")
        ),
        (
            cover.x().expect("x"),
            cover.y().expect("y"),
            cover.width().expect("width"),
            cover.height().expect("height")
        )
    );
    let capture = screen.capture(&oni_protocol::decode(json!({"target":{"kind":"window","windowId":target.id().expect("id").to_string()},"encoding":{"format":"png"}})).expect("capture request"));
    assert_eq!(capture["status"], "ok", "{capture}");
    let data = STANDARD
        .decode(capture["data"].as_str().expect("data"))
        .expect("base64");
    let image = image::load_from_memory(&data).expect("png").into_rgba8();
    assert!(!oni_machine_client::screen::blank::blank(image.as_raw()));
    let red = image
        .pixels()
        .filter(|pixel| pixel[0] > 200 && pixel[1] < 80 && pixel[2] < 80)
        .count();
    let green = image
        .pixels()
        .filter(|pixel| pixel[1] > 200 && pixel[0] < 80 && pixel[2] < 80)
        .count();
    assert!(
        red > 1000 && green > 1000,
        "the target pattern, not the blue cover, was captured"
    );
}
