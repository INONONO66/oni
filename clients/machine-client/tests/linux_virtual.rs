#![cfg(target_os = "linux")]

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_machine_client::{
    app::{linux::Native as LinuxLauncher, Fault as LaunchFault, Launcher},
    attach::{Negotiated, Session},
    computer,
    display::xvfb::{self, Config},
    handlers::Service,
    input::Input,
    pty::ops::Pty,
    screen::{probe, Screen},
};
use serde_json::json;
use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use x11rb::{
    connection::Connection,
    protocol::xproto::{
        AtomEnum, ChangeWindowAttributesAux, ConnectionExt, CreateGCAux, CreateWindowAux,
        EventMask, InputFocus, PropMode, Rectangle, WindowClass,
    },
    wrapper::ConnectionExt as _,
};

#[path = "support/client_config.rs"]
mod client_config;
#[path = "support/native_focus.rs"]
mod native_focus;

static DISPLAY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn native_window(
    connection: &x11rb::rust_connection::RustConnection,
    index: usize,
    size: (u16, u16),
) -> (u32, u32) {
    let root = &connection.setup().roots[index];
    let window = connection.generate_id().expect("window id");
    connection
        .create_window(
            root.root_depth,
            window,
            root.root,
            0,
            0,
            size.0,
            size.1,
            0,
            WindowClass::INPUT_OUTPUT,
            root.root_visual,
            &CreateWindowAux::new()
                .background_pixel(0xff0000)
                .event_mask(EventMask::KEY_PRESS | EventMask::KEY_RELEASE),
        )
        .expect("create window");
    connection.map_window(window).expect("map window");
    connection
        .set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)
        .expect("focus fixture")
        .check()
        .expect("focus barrier");
    let atom = |name: &[u8]| {
        connection
            .intern_atom(false, name)
            .expect("atom")
            .reply()
            .expect("atom reply")
            .atom
    };
    connection
        .change_property32(
            PropMode::REPLACE,
            root.root,
            atom(b"_NET_CLIENT_LIST"),
            AtomEnum::WINDOW,
            &[window],
        )
        .expect("window list")
        .check()
        .expect("list barrier");
    let pid = u32::try_from(nix::unistd::getppid().as_raw()).expect("parent pid");
    connection
        .change_property32(
            PropMode::REPLACE,
            window,
            atom(b"_NET_WM_PID"),
            AtomEnum::CARDINAL,
            &[pid],
        )
        .expect("owner")
        .check()
        .expect("owner barrier");
    connection
        .change_property8(
            PropMode::REPLACE,
            window,
            atom(b"_NET_WM_NAME"),
            atom(b"UTF8_STRING"),
            b"native fixture",
        )
        .expect("title")
        .check()
        .expect("title barrier");
    (window, pid)
}

fn blocked_app(directory: &Path) -> oni_protocol::AppLaunchRequest {
    let fifo = directory.join("blocked");
    assert!(Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo")
        .success());
    oni_protocol::decode(serde_json::json!({
        "app": { "path": "/bin/sh", "args": ["-c", "read line < \"$1\"", "sh", fifo] },
        "activate": false
    }))
    .expect("Linux app launch request")
}

#[test]
fn launched_child_quit_reaps_the_owned_process() {
    let directory = tempfile::tempdir().expect("fixture");
    let launcher = LinuxLauncher::new(None);
    let request = blocked_app(directory.path());
    let resolved = launcher.resolve(&request).expect("executable");
    let (sender, receiver) = mpsc::channel();
    launcher.start(&request, &resolved, sender).expect("launch");
    let first = receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("launch receipt")
        .expect("pid");
    let (sender, receiver) = mpsc::channel();
    launcher
        .start(&request, &resolved, sender)
        .expect("second launch");
    let second = receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("receipt")
        .expect("pid");
    for pid in [first, second] {
        assert_eq!(
            launcher.identity(pid).expect("child identity"),
            resolved.identity
        );
        assert_eq!(launcher.quit(pid), Ok(true));
    }
}

#[test]
fn dropped_launch_reply_kills_and_reaps_the_child() {
    let directory = tempfile::tempdir().expect("fixture");
    let launcher = LinuxLauncher::new(None);
    let request = blocked_app(directory.path());
    let resolved = launcher.resolve(&request).expect("executable");
    let (sender, receiver) = mpsc::channel();
    drop(receiver);
    assert_eq!(
        launcher.start(&request, &resolved, sender),
        Err(LaunchFault::Failed("launch completion disconnected".into()))
    );
}

#[tokio::test]
async fn public_virtual_computer_serves_opaque_pixels_input_and_window_refusals() {
    let _guard = DISPLAY_LOCK.lock().await;
    let directory = tempfile::tempdir().expect("computer");
    let config = directory.path().join("client.json");
    std::fs::write(
        &config,
        json!({"computer":{"display":{"kind":"xvfb","width":32,"height":24,"dpi":96,
        "windowManager":{"path":"/missing-manager"}}}})
        .to_string(),
    )
    .expect("config");
    let (screen, input) = computer::open(&config)
        .expect("computer startup")
        .expect("native pair");
    let id = screen
        .virtual_display()
        .expect("owned display")
        .0
        .to_owned();
    let (connection, index) = x11rb::connect(Some(&id)).expect("window connection");
    let root = &connection.setup().roots[index];
    connection
        .change_window_attributes(
            root.root,
            &ChangeWindowAttributesAux::new().background_pixel(0xff0000),
        )
        .expect("red background")
        .check()
        .expect("background");
    connection
        .clear_area(false, root.root, 0, 0, 32, 24)
        .expect("paint root")
        .check()
        .expect("painted");
    let (window, pid) = native_window(&connection, index, (8, 8));
    let gc = connection.generate_id().expect("gc");
    connection
        .create_gc(gc, window, &CreateGCAux::new().foreground(0x0000ff))
        .expect("gc");
    connection
        .poly_fill_rectangle(
            window,
            gc,
            &[Rectangle {
                x: 0,
                y: 0,
                width: 4,
                height: 4,
            }],
        )
        .expect("two-color window")
        .check()
        .expect("paint barrier");
    assert!(screen
        .input_private(None)
        .expect("native focus fails closed"));
    let screen = native_focus::screen(screen, &id);
    assert!(input.available());
    let fact = screen.capability(input.available());
    assert_eq!(fact.verdict, "partial", "{fact:?}");
    assert_eq!(fact.display.kind, "virtual");
    assert_eq!(fact.display.id.as_deref(), Some(id.as_str()));
    assert!(fact.display.isolated);
    assert_eq!(
        (
            fact.grants.capture,
            fact.grants.accessibility,
            fact.grants.input
        ),
        (true, false, true)
    );
    let service = Service::open_computer(
        &client_config::client_config(directory.path(), None),
        Pty::new("/missing-tmux", None, "linux-native".into()).await,
        screen,
        input,
    )
    .expect("service");
    service.attached(&Negotiated {
        generation: std::num::NonZeroU64::MIN,
        capabilities: vec!["computer.use".into()],
        exports: vec![],
    });
    let hooks = service.hooks(Duration::from_secs(60));
    let listed = (hooks.service)("machine.screen.list".into(), Some(json!({"windows":true})))
        .await
        .expect("list");
    assert_eq!(listed["windows"][0]["title"], "native fixture");
    for (index, target) in [
        json!({"kind":"display","display":1}),
        json!({"kind":"window","windowId":window.to_string()}),
    ]
    .into_iter()
    .enumerate()
    {
        let frame = (hooks.service)(
            "machine.screen.capture".into(),
            Some(json!({"target":target,"encoding":{"format":"png"}})),
        )
        .await
        .expect("capture");
        assert_eq!(frame["status"], "ok", "{frame}");
        oni_protocol::decode::<oni_protocol::ScreenCaptureResult>(frame.clone())
            .expect("wire image");
        let bytes = STANDARD
            .decode(frame["data"].as_str().expect("png data"))
            .expect("base64");
        let pixels = image::load_from_memory(&bytes)
            .expect("decoded PNG")
            .to_rgba8();
        assert!(pixels
            .pixels()
            .all(|pixel| pixel.0 == [255, 0, 0, 255] || pixel.0 == [0, 0, 255, 255]));
        assert!(pixels.pixels().any(|pixel| pixel.0 == [255, 0, 0, 255]));
        let pointer = (hooks.service)(
            "machine.input.pointer".into(),
            Some(
                json!({"requestId":format!("1-{}", index * 4 + 1),"delivery":"foreground",
            "kind":"move","at":{"captureId":frame["captureId"],"x":2,"y":3}}),
            ),
        )
        .await
        .expect("input");
        assert_eq!(pointer["status"], "ok", "{pointer}");
        let position = connection
            .query_pointer(root.root)
            .expect("pointer query")
            .reply()
            .expect("pointer receipt");
        assert_eq!((position.root_x, position.root_y), (2, 3));
        let key = (hooks.service)(
            "machine.input.key".into(),
            Some(
                json!({"requestId":format!("1-{}", index * 4 + 2),"delivery":"foreground",
            "captureId":frame["captureId"],"key":"F5","action":"press"}),
            ),
        )
        .await
        .expect("key");
        assert_eq!(key["status"], "ok", "{key}");
        assert_eq!(
            key_symbols(&connection),
            vec![(true, 0xffc2), (false, 0xffc2)]
        );
        let text = (hooks.service)(
            "machine.input.text".into(),
            Some(
                json!({"requestId":format!("1-{}", index * 4 + 3),"delivery":"foreground",
            "captureId":frame["captureId"],"text":"Aé"}),
            ),
        )
        .await
        .expect("text");
        assert_eq!(text["status"], "ok", "{text}");
        assert_eq!(
            key_symbols(&connection),
            vec![
                (true, u32::from('A')),
                (false, u32::from('A')),
                (true, u32::from('é')),
                (false, u32::from('é')),
            ]
        );
        let click = (hooks.service)("machine.input.pointer".into(), Some(json!({"requestId":format!("1-{}", index * 4 + 4),"delivery":"foreground",
            "kind":"click","at":{"captureId":frame["captureId"],"x":2,"y":3},"button":"left","count":1})))
            .await.expect("click");
        assert_eq!(click["status"], "ok", "{click}");
    }
    let text_frame = (hooks.service)(
        "machine.screen.capture".into(),
        Some(json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}})),
    )
    .await
    .expect("text anchor");
    let distinct: String = (0x10000..0x1012c)
        .map(|point| char::from_u32(point).expect("Unicode scalar"))
        .collect();
    let exhausted = (hooks.service)(
        "machine.input.text".into(),
        Some(json!({"requestId":"1-9","delivery":"foreground",
            "captureId":text_frame["captureId"],"text":distinct})),
    )
    .await
    .expect("exhausted text response");
    assert_eq!(exhausted["status"], "refused");
    assert_eq!(exhausted["reason"], "input_failed");
    assert_eq!(
        exhausted["message"],
        "input driver failed: X11 has no unused keycodes"
    );
    oni_protocol::decode::<oni_protocol::InputWriteResult>(exhausted).expect("typed text refusal");
    assert!(key_symbols(&connection).is_empty());
    let observed = (hooks.service)(
        "machine.screen.observe".into(),
        Some(json!({"target":{"pid":pid,"windowId":window},
        "screenshot":false})),
    )
    .await
    .expect("observe");
    assert_eq!(observed["reason"], "observe_not_available");
    assert!(!hooks.screen.capability(true).grants.accessibility);
    let refused = (hooks.service)(
        "machine.window.close".into(),
        Some(json!({"target":{"pid":pid,"windowId":window,"epoch":0}})),
    )
    .await
    .expect("close");
    assert_eq!(refused["blocker"], "platform");
    let invalid = (hooks.service)(
        "machine.screen.capture".into(),
        Some(json!({"target":{"kind":"display","display":2},"encoding":{"format":"png"}})),
    )
    .await
    .expect("bad display");
    assert_eq!(invalid["reason"], "display_not_found");
    let launch = (hooks.service)(
        "machine.app.launch".into(),
        Some(json!({"app":{"bundleId":"invalid.example"},
        "activate":false})),
    )
    .await
    .expect("launch refusal");
    oni_protocol::decode::<oni_protocol::AppLaunchResult>(launch.clone())
        .expect("typed Linux launch refusal");
    assert_eq!(launch["blocker"], "platform");
    drop(connection);
    service.detached();
    drop(hooks);
    drop(service);
    assert!(!Path::new(&format!("/tmp/.X11-unix/X{}", id.trim_start_matches(':'))).exists());
}

struct Server {
    child: Child,
    id: String,
}
impl Drop for Server {
    fn drop(&mut self) {
        if self.child.try_wait().expect("server status").is_some() {
            return;
        }
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(i32::try_from(self.child.id()).expect("pid")),
            nix::sys::signal::Signal::SIGTERM,
        )
        .expect("stop test Xvfb");
        self.child.wait().expect("reap test Xvfb");
    }
}

fn key_symbols(connection: &x11rb::rust_connection::RustConnection) -> Vec<(bool, u32)> {
    connection
        .get_input_focus()
        .expect("event barrier")
        .reply()
        .expect("barrier reply");
    let mut symbols = Vec::new();
    while let Some(event) = connection.poll_for_event().expect("queued event") {
        let (down, key) = match event {
            x11rb::protocol::Event::KeyPress(key) => (true, key),
            x11rb::protocol::Event::KeyRelease(key) => (false, key),
            _ => continue,
        };
        let mapping = connection
            .get_keyboard_mapping(key.detail, 1)
            .expect("delivered key mapping")
            .reply()
            .expect("mapping reply");
        symbols.push((down, mapping.keysyms[0]));
    }
    symbols
}

#[test]
fn xtest_keeps_queued_symbols_stable_and_refuses_exhaustion_before_delivery() {
    use oni_machine_client::input::{native, Driver, Event, Key};
    let _guard = DISPLAY_LOCK.blocking_lock();
    let server = server(&[]);
    let (connection, index) = x11rb::connect(Some(&server.id)).expect("event receiver");
    let setup = connection.setup();
    let first = setup.min_keycode;
    let count = setup.max_keycode - first + 1;
    let original = connection
        .get_keyboard_mapping(first, count)
        .expect("keymap")
        .reply()
        .expect("original keymap");
    let root = setup.roots[index].root;
    let source = oni_machine_client::screen::x11::Native::open(Some(&server.id)).expect("source");
    assert_eq!(
        oni_machine_client::screen::Source::capture_display(&source, 1, &mut Vec::new()),
        Err(oni_machine_client::screen::Fault::DisplayNotFound)
    );
    connection
        .change_window_attributes(
            root,
            &ChangeWindowAttributesAux::new()
                .event_mask(EventMask::KEY_PRESS | EventMask::KEY_RELEASE),
        )
        .expect("subscribe keys")
        .check()
        .expect("subscription barrier");
    connection
        .set_input_focus(InputFocus::POINTER_ROOT, root, x11rb::CURRENT_TIME)
        .expect("root focus")
        .check()
        .expect("focus barrier");
    connection
        .change_keyboard_control(
            &x11rb::protocol::xproto::ChangeKeyboardControlAux::new()
                .auto_repeat_mode(x11rb::protocol::xproto::AutoRepeatMode::OFF),
        )
        .expect("disable fixture autorepeat")
        .check()
        .expect("autorepeat barrier");
    let mut driver = native::open_on(Some(&server.id)).expect("XTEST");
    assert!(driver.permitted());
    assert!(!driver.pid_delivery());
    assert_eq!(
        driver.post_to_pid(42, &Event::Text("x".into())),
        Err("pid delivery is unavailable".into())
    );
    let held = Key::Char('界');
    let held_symbol = xkeysym::Keysym::from_char('界').raw();
    driver
        .inject(&Event::Key {
            key: held,
            down: true,
        })
        .expect("hold dynamic symbol");
    assert_eq!(key_symbols(&connection), vec![(true, held_symbol)]);
    driver
        .inject(&Event::Text("界".into()))
        .expect("type held symbol");
    assert_eq!(
        key_symbols(&connection),
        vec![(true, held_symbol), (false, held_symbol)]
    );
    let held_keys = connection
        .query_keymap()
        .expect("held key query")
        .reply()
        .expect("held key receipt");
    assert_eq!(
        held_keys
            .keys
            .iter()
            .map(|byte| byte.count_ones())
            .sum::<u32>(),
        1
    );
    // One request exceeds the entire keycode space in length. Consume only
    // after a later request, so no per-character acknowledgment hides reuse.
    let burst = "Aé界".repeat(100);
    driver.inject(&Event::Text(burst.clone())).expect("burst");
    driver
        .inject(&Event::Text("語".into()))
        .expect("later text");
    let expected: Vec<_> = burst
        .chars()
        .chain("語".chars())
        .flat_map(|character| {
            let symbol = xkeysym::Keysym::from_char(character).raw();
            [(true, symbol), (false, symbol)]
        })
        .collect();
    assert_eq!(key_symbols(&connection), expected);
    let distinct: String = (0x10000..0x1012c)
        .map(|point| char::from_u32(point).expect("printable Unicode"))
        .collect();
    let before_refusal = connection
        .get_keyboard_mapping(first, count)
        .expect("current map")
        .reply()
        .expect("current map reply");
    assert_eq!(
        driver.inject(&Event::Text(distinct)),
        Err("X11 has no unused keycodes".into())
    );
    let after_refusal = connection
        .get_keyboard_mapping(first, count)
        .expect("map after refusal")
        .reply()
        .expect("map reply");
    assert_eq!(after_refusal.keysyms, before_refusal.keysyms);
    assert!(connection
        .poll_for_event()
        .expect("no rejected events")
        .is_none());
    driver
        .inject(&Event::Text("文".into()))
        .expect("capacity retained after refusal");
    let symbol = xkeysym::Keysym::from_char('文').raw();
    assert_eq!(
        key_symbols(&connection),
        vec![(true, symbol), (false, symbol)]
    );
    driver
        .inject(&Event::Key {
            key: held,
            down: false,
        })
        .expect("release held key");
    assert_eq!(key_symbols(&connection), vec![(false, held_symbol)]);
    drop(driver);
    let restored = connection
        .get_keyboard_mapping(first, count)
        .expect("restored keymap")
        .reply()
        .expect("restoration barrier");
    assert_eq!(restored.keysyms, original.keysyms);
}

#[test]
fn xtest_delivers_pointer_buttons_and_both_scroll_axes() {
    use oni_machine_client::input::{native, Button, Driver, Event};
    let _guard = DISPLAY_LOCK.blocking_lock();
    let server = server(&[]);
    let (connection, index) = x11rb::connect(Some(&server.id)).expect("event receiver");
    let root = connection.setup().roots[index].root;
    connection
        .change_window_attributes(
            root,
            &ChangeWindowAttributesAux::new()
                .event_mask(EventMask::BUTTON_PRESS | EventMask::BUTTON_RELEASE),
        )
        .expect("subscribe buttons")
        .check()
        .expect("subscription barrier");
    let mut driver = native::open_on(Some(&server.id)).expect("XTEST");
    driver
        .inject(&Event::Move {
            x: 7,
            y: 9,
            reference: None,
        })
        .expect("move");
    let pointer = connection
        .query_pointer(root)
        .expect("query")
        .reply()
        .expect("position");
    assert_eq!((pointer.root_x, pointer.root_y), (7, 9));
    for button in [Button::Left, Button::Middle, Button::Right] {
        for down in [true, false] {
            driver
                .inject(&Event::Button {
                    button,
                    down,
                    click: 1,
                })
                .expect("button");
        }
    }
    for (horizontal, delta) in [(false, -1), (false, 1), (true, -1), (true, 1)] {
        driver
            .inject(&Event::Scroll { horizontal, delta })
            .expect("scroll");
    }
    connection
        .get_input_focus()
        .expect("events")
        .reply()
        .expect("event barrier");
    let mut buttons = Vec::new();
    while let Some(event) = connection.poll_for_event().expect("queued event") {
        match event {
            x11rb::protocol::Event::ButtonPress(event) => buttons.push((true, event.detail)),
            x11rb::protocol::Event::ButtonRelease(event) => buttons.push((false, event.detail)),
            _ => {}
        }
    }
    assert_eq!(
        buttons,
        (1..=7)
            .flat_map(|button| [(true, button), (false, button)])
            .collect::<Vec<_>>()
    );
    for (x, y) in [(i32::MAX, 0), (0, i32::MAX)] {
        assert_eq!(
            driver.inject(&Event::Move {
                x,
                y,
                reference: None
            }),
            Err(i16::try_from(i32::MAX)
                .expect_err("coordinate overflow")
                .to_string())
        );
    }
    assert!(native::open_on(Some("host:0")).is_err());
    driver
        .inject(&Event::Text("界".into()))
        .expect("dynamic mapping before exit");
    server_exit(server);
    assert!(!driver.permitted());
    assert!(driver
        .inject(&Event::Move {
            x: 1,
            y: 1,
            reference: None
        })
        .is_err());
    assert!(driver.inject(&Event::Text("語".into())).is_err());
    assert!(driver.inject(&Event::Text("語".into())).is_err());
}

fn server_exit(mut server: Server) {
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(server.child.id()).expect("pid")),
        nix::sys::signal::Signal::SIGTERM,
    )
    .expect("terminate server");
    server.child.wait().expect("server exit barrier");
}

#[test]
fn reports_keep_the_serving_binding_after_server_exit_and_replacement() {
    let _guard = DISPLAY_LOCK.blocking_lock();
    let original = server(&[]);
    let other = server(&[]);
    let id = original.id.clone();
    let screen = Screen::platform_on(Some(&id));
    let input = Input::platform_on(Some(&id));
    let ready = screen.capability(input.ready());
    assert_eq!(ready.display.id.as_deref(), Some(id.as_str()));
    assert!(ready.grants.capture && ready.grants.input);
    server_exit(original);
    assert!(Screen::platform_on(Some(&other.id))
        .probe()
        .expect("other source")
        .is_ok());
    let exited = screen.capability(input.ready());
    assert_eq!(exited.display.id.as_deref(), Some(id.as_str()));
    assert!(!exited.grants.capture && !exited.grants.input);
    let replacement = server(&[&id]);
    assert_eq!(replacement.id, id);
    let current = Screen::platform_on(Some(&replacement.id));
    assert!(current.probe().expect("replacement source").is_ok());
    let retained = screen.capability(input.ready());
    assert_eq!(retained.display.id.as_deref(), Some(id.as_str()));
    assert_eq!(retained.verdict, "unavailable");
    assert!(!retained.grants.capture && !retained.grants.input);
    assert!(retained
        .blockers
        .iter()
        .any(|blocker| blocker.kind == "no_x_display"));
}
fn server(arguments: &[&str]) -> Server {
    let mut child = Command::new("Xvfb")
        .args([
            "-displayfd",
            "1",
            "-screen",
            "0",
            "32x24x24",
            "-nolisten",
            "tcp",
            "-noreset",
        ])
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("Xvfb");
    let output = child.stdout.take().expect("displayfd");
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut id = String::new();
        BufReader::new(output)
            .read_line(&mut id)
            .expect("displayfd receipt");
        send.send(id).expect("displayfd delivery");
    });
    let mut server = Server {
        child,
        id: String::new(),
    };
    server.id = format!(
        ":{}",
        receive
            .recv_timeout(Duration::from_secs(3))
            .expect("ready")
            .trim()
    );
    server
}
fn authority(path: &Path, display: &str) {
    let mut bytes = u16::MAX.to_be_bytes().to_vec();
    for field in [
        b"".as_slice(),
        display.trim_start_matches(':').as_bytes(),
        b"MIT-MAGIC-COOKIE-1",
        b"0123456789abcdef",
    ] {
        bytes.extend(
            u16::try_from(field.len())
                .expect("field length")
                .to_be_bytes(),
        );
        bytes.extend(field);
    }
    std::fs::write(path, bytes).expect("authority");
}

#[test]
fn platform_selection_rejects_nonzero_screen_and_preserves_wayland_partial() {
    if let Ok(mode) = std::env::var("ONI_NATIVE_PROBE_CASE") {
        let screen = Screen::platform();
        let input = Input::platform();
        if mode == "selected" {
            let selected =
                probe::linux_display(&probe::linux::System, None).expect("selected display");
            assert!(screen.available() && input.available());
            assert_eq!(selected, std::env::var("DISPLAY").expect("fixture binding"));
            let (shared, input) = computer::platform();
            assert!(shared.available() && input.available());
            let frame = shared.capture(
                &oni_protocol::decode(
                    json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}}),
                )
                .expect("capture request"),
            );
            assert_eq!(frame["status"], "ok");
        } else {
            assert!(!screen.available() && !input.available());
            let verdict = screen.capability(false);
            if mode == "wayland" {
                assert_eq!(verdict.verdict, "partial");
                assert!(verdict
                    .blockers
                    .iter()
                    .any(|blocker| blocker.kind == "wayland_only_no_x"));
            }
            let result = screen.capture(
                &oni_protocol::decode(
                    json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}}),
                )
                .expect("capture"),
            );
            assert_eq!(result["reason"], "screen_not_available");
            let result = input.pointer(
                &screen,
                &oni_protocol::decode(
                    json!({"requestId":"1-1","delivery":"foreground","kind":"move",
                "at":{"captureId":"absent","x":0,"y":0}}),
                )
                .expect("pointer"),
            );
            assert_eq!(result["reason"], "input_not_available");
        }
        return;
    }
    let _guard = DISPLAY_LOCK.blocking_lock();
    let directory = tempfile::tempdir().expect("session");
    let hidden_auth = directory.path().join("hidden-auth");
    authority(&hidden_auth, ":not-selected");
    let hidden = server(&["-auth", hidden_auth.to_str().expect("path")]);
    let actual = server(&["-screen", "1", "32x24x24"]);
    let refused = Screen::platform_on(Some(&hidden.id));
    assert!(!refused.available());
    assert!(refused
        .capability(false)
        .blockers
        .iter()
        .any(|blocker| blocker.kind == "x_auth_refused"));
    assert!(!Input::platform_on(Some(&hidden.id)).available());
    assert!(matches!(
        probe::LinuxEnv::x11(&probe::linux::System, "host:0"),
        probe::X11::Unreachable
    ));
    assert!(Screen::platform_on(Some(&actual.id)).available());
    assert!(probe::LinuxEnv::candidates(&probe::linux::System).contains(&actual.id));
    let wayland = std::os::unix::net::UnixListener::bind(directory.path().join("wayland-test"))
        .expect("Wayland socket");
    for mode in ["selected", "nonzero", "wayland"] {
        let mut command = Command::new(std::env::current_exe().expect("test binary"));
        command
            .args([
                "--exact",
                "platform_selection_rejects_nonzero_screen_and_preserves_wayland_partial",
                "--nocapture",
            ])
            .env("ONI_NATIVE_PROBE_CASE", mode)
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("XDG_SESSION_TYPE")
            .env("XAUTHORITY", "")
            .env("XDG_RUNTIME_DIR", directory.path());
        if mode == "selected" {
            command.env("DISPLAY", &actual.id);
        }
        if mode == "nonzero" {
            command.env("DISPLAY", format!("{}.1", actual.id));
        }
        if mode == "wayland" {
            command.env("WAYLAND_DISPLAY", "wayland-test");
        }
        let output = command.output().expect("native probe");
        assert!(
            output.status.success(),
            "{mode}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    drop((wayland, actual, hidden));
}

#[test]
fn protected_server_capture_input_and_launch_share_authority() {
    let _guard = DISPLAY_LOCK.blocking_lock();
    let directory = tempfile::tempdir().expect("auth fixture");
    let auth = directory.path().join("server-auth");
    authority(&auth, ":0");
    let server = server(&["-auth", auth.to_str().expect("path")]);
    authority(&auth, &server.id);
    let socket = std::os::unix::net::UnixStream::connect(format!(
        "/tmp/.X11-unix/X{}",
        server.id.trim_start_matches(':')
    ))
    .expect("fixture connection");
    let stream = x11rb::rust_connection::DefaultStream::from_unix_stream(socket)
        .expect("fixture stream")
        .0;
    let connection = x11rb::rust_connection::RustConnection::connect_to_stream_with_auth_info(
        stream,
        0,
        b"MIT-MAGIC-COOKIE-1".to_vec(),
        b"0123456789abcdef".to_vec(),
    )
    .expect("authenticated fixture");
    native_window(&connection, 0, (32, 24));
    let screen = native_focus::screen(Screen::platform_on(Some(&server.id)), &server.id);
    let input = Input::platform_on(Some(&server.id));
    assert!(screen.available() && input.available());
    let frame = screen.capture(
        &oni_protocol::decode(
            json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}}),
        )
        .expect("capture"),
    );
    assert_eq!(frame["status"], "ok");
    let result = input.pointer(
        &screen,
        &oni_protocol::decode(
            json!({"requestId":"1-1","delivery":"foreground","kind":"move",
        "at":{"captureId":frame["captureId"],"x":7,"y":8}}),
        )
        .expect("pointer"),
    );
    assert_eq!(result["status"], "ok");
    let receipt = directory.path().join("receipt");
    assert!(Command::new("mkfifo")
        .arg(&receipt)
        .status()
        .expect("fifo")
        .success());
    let output = receipt.clone();
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        send.send(std::fs::read_to_string(output).expect("launch environment"))
            .expect("receipt")
    });
    let launcher = LinuxLauncher::selected(
        Some(server.id.clone()),
        Some(auth.to_string_lossy().into_owned()),
        false,
    );
    let request = oni_protocol::decode(json!({"app":{"path":"/bin/sh","args":["-c","printf '%s|%s' \"$DISPLAY\" \"$XAUTHORITY\" > \"$1\"","sh",receipt]},
        "activate":false,"env":{"DISPLAY":":human","XAUTHORITY":"/human/auth"}})).expect("launch");
    let resolved = launcher.resolve(&request).expect("resolve");
    let (reply, pid) = mpsc::channel();
    launcher.start(&request, &resolved, reply).expect("start");
    pid.recv_timeout(Duration::from_secs(2))
        .expect("launch receipt")
        .expect("pid");
    assert_eq!(
        receive
            .recv_timeout(Duration::from_secs(2))
            .expect("environment"),
        format!("{}|{}", server.id, auth.display())
    );
}

#[test]
fn absent_window_manager_reports_partial_with_its_own_blocker() {
    let _guard = DISPLAY_LOCK.blocking_lock();
    let owned = xvfb::open(&Config {
        kind: "xvfb".into(),
        width: 32,
        height: 24,
        dpi: 96,
        window_manager: Some(oni_machine_client::display::Manager {
            path: "/missing-window-manager".into(),
            args: Vec::new(),
        }),
    })
    .expect("virtual display without a window manager");
    assert!(owned.window_manager_missing());
    let id = owned.id.clone();
    let screen = Screen::platform_on(Some(&id)).virtualizing(owned);
    let fact = screen.capability(Input::platform_on(Some(&id)).available());
    assert_eq!(fact.verdict, "partial", "{fact:?}");
    assert!(fact.display.isolated);
    assert!(fact
        .blockers
        .iter()
        .any(|blocker| blocker.kind == "window_manager_missing"));
}
