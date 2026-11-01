#[path = "support/client_config.rs"]
mod client_config;
#[path = "support/ordinary_focus.rs"]
mod ordinary_focus;
#[path = "support/script.rs"]
mod script;
#[path = "support/tmux.rs"]
mod tmux_server;

use std::{
    num::NonZeroU64,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use oni_machine_client::{
    attach::{Hooks, Negotiated, Session},
    budget::{Pressure, Retained},
    config::ClientConfig,
    handlers::{available, Service, SUPPORTED},
    pty::ops::Pty,
};
use serde_json::{json, Value};
use tempfile::TempDir;

const MISSING_TMUX: &str = "/definitely/missing/tmux";

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: TempDir,
    service: Arc<Service>,
    hooks: Hooks,
}

impl Fixture {
    async fn new(exports: bool, pty: Pty) -> Self {
        let root = tempfile::tempdir().expect("export root");
        let service = Service::open(&settings(exports, root.path()), pty).expect("service");
        let hooks = service.hooks(Duration::from_secs(60));
        Self {
            root,
            service,
            hooks,
        }
    }

    async fn without_tmux(exports: bool) -> Self {
        Self::new(exports, Pty::new(MISSING_TMUX, None, "g".into()).await).await
    }

    fn grant(&self, capabilities: &[&str], exports: &[&str]) {
        self.service.attached(&Negotiated {
            generation: NonZeroU64::MIN,
            capabilities: capabilities.iter().map(|&id| id.to_owned()).collect(),
            exports: exports.iter().map(|&name| name.to_owned()).collect(),
        });
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        (self.hooks.service)(method.to_owned(), Some(params)).await
    }

    async fn ok(&self, method: &str, params: Value) -> Value {
        self.call(method, params).await.expect(method)
    }

    fn cwd(&self) -> String {
        self.root.path().to_str().expect("utf8 root").to_owned()
    }
}

fn settings(exports: bool, root: &Path) -> ClientConfig {
    client_config::client_config(root, exports.then_some("notes"))
}

fn refusal(reason: &str) -> Value {
    json!({"status":"refused","reason":reason})
}

fn ordinary_screen() -> oni_machine_client::screen::Screen {
    let mut source = oni_machine_client::screen::fixture::Fixture::display(32, 16, 1.0);
    source.windows.push(oni_machine_client::screen::Window {
        id: 1,
        display: 1,
        title: "Fixture".into(),
        owner: "fixture".into(),
        pid: Some(1),
        app: None,
        x: 0,
        y: 0,
        width: 32,
        height: 16,
    });
    ordinary_focus::screen(source, 2, &[1])
}

#[tokio::test]
async fn connected_ungranted_computer_requests_never_query_accessibility() {
    use oni_machine_client::{
        input::{recorder::Recorder, Input},
        screen::{
            ax::{ActFault, Action, Admit, Bounds, Observer, Segment, Walk, WindowIdentity},
            private::Focused,
            Fault, Screen,
        },
        transport::client::{handler, Client},
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Counting(Arc<AtomicUsize>);
    impl Observer for Counting {
        fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }
        fn focused(&self, _: &WindowIdentity) -> Result<Option<Focused>, Fault> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }
        fn walk(&self, _: &WindowIdentity, _: &Bounds) -> Result<Walk, Fault> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(Fault::Permission)
        }
        fn act(
            &self,
            _: &WindowIdentity,
            _: &[Segment],
            _: Admit<'_>,
            _: &Action,
        ) -> Result<(), ActFault> {
            Err(ActFault::Permission)
        }
    }

    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new(MISSING_TMUX, None, "g".into()).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let screen = Screen::new(
        Box::new(oni_machine_client::screen::fixture::Fixture::display(
            32, 16, 1.0,
        )),
        1,
    )
    .observing(Box::new(Counting(calls.clone())));
    let service = Service::open_computer(
        &settings(false, root.path()),
        pty,
        screen,
        Input::new(Recorder::default()),
    )
    .expect("service");
    let (peer, _host) = tokio::io::duplex(1024);
    let client = Client::from_stream(
        peer,
        handler(|_, _| async { Err("unexpected request".to_owned()) }),
    );
    service.connected(client.caller());
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["shell.exec".into()],
        exports: Vec::new(),
    });
    let hooks = service.hooks(Duration::from_secs(60));
    let refused = (hooks.service)(
        "machine.screen.capture".into(),
        Some(json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}})),
    )
    .await
    .expect("capture refusal");
    assert_eq!(refused, refusal("screen_not_available"));
    let input = (hooks.service)(
        "machine.input.text".into(),
        Some(
            json!({"requestId":"1-1","delivery":"foreground","captureId":"cap-1","text":"secret"}),
        ),
    )
    .await
    .expect("input refusal");
    assert_eq!(input, refusal("input_not_available"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

fn begin(id: &str, mode: &str, export: &str) -> Value {
    json!({"op":"begin","transferId":id,"mode":mode,"export":export,"path":"one"})
}

const PTY_METHODS: [&str; 6] = [
    "machine.pty_open",
    "machine.pty_write",
    "machine.pty_read",
    "machine.pty_resize",
    "machine.pty_close",
    "machine.pty_list",
];

#[test]
fn offered_capabilities_follow_exports_and_the_tmux_probe() {
    assert_eq!(
        SUPPORTED,
        [
            "fs.read",
            "fs.write",
            "shell.exec",
            "pty.session",
            "agent.session",
            "screen.read",
            "computer.use",
            "input.write",
            "kernel.py"
        ]
    );
    assert_eq!(
        available(true, true),
        ["fs.read", "fs.write", "shell.exec", "pty.session"]
    );
    assert_eq!(
        available(true, false),
        ["fs.read", "fs.write", "shell.exec"]
    );
    assert_eq!(available(false, true), ["shell.exec", "pty.session"]);
    assert_eq!(available(false, false), ["shell.exec"]);
}

#[tokio::test]
async fn service_offers_only_what_is_available() {
    let bare = Fixture::without_tmux(false).await;
    let python = oni_machine_client::code::Code::available();
    let expected = if python {
        vec!["shell.exec", "kernel.py"]
    } else {
        vec!["shell.exec"]
    };
    assert_eq!(bare.service.capabilities(), expected);
    let exported = Fixture::without_tmux(true).await;
    let mut expected = vec!["fs.read", "fs.write", "shell.exec"];
    if python {
        expected.push("kernel.py");
    }
    assert_eq!(exported.service.capabilities(), expected);
    let missing = settings(true, Path::new("/definitely/missing/export"));
    assert!(Service::open(&missing, Pty::new(MISSING_TMUX, None, "g".into()).await).is_err());
}

#[tokio::test]
async fn unoffered_methods_answer_typed_refusals_even_when_granted() {
    let fixture = Fixture::without_tmux(true).await;
    fixture.grant(&["screen.read", "input.write", "pty.session"], &["notes"]);
    let cell = json!({"cellId":"c1","code":"1 + 1","timeoutMs":1000});
    let input = json!({"captureId":"cap-1","actions":[{"type":{"text":"hi"}}]});
    let cases = [
        ("machine.run_code", cell, refusal("kernel_not_available")),
        (
            "machine.peek_code",
            json!({"cellId":"c1"}),
            refusal("kernel_not_available"),
        ),
        (
            "machine.cancel_code",
            json!({"cellId":"c1"}),
            json!({"cancelled":false}),
        ),
        (
            "machine.screen_read",
            json!({}),
            refusal("screen_not_available"),
        ),
        ("machine.input_write", input, refusal("input_not_available")),
    ];
    for (method, params, answer) in cases {
        assert_eq!(fixture.ok(method, params).await, answer, "{method}");
        assert!(
            fixture.call(method, json!({"bogus":1})).await.is_err(),
            "{method}"
        );
    }
    for method in PTY_METHODS {
        assert_eq!(
            fixture
                .ok(method, json!({"name":"s","cwd":fixture.cwd()}))
                .await,
            refusal("pty_not_available"),
            "{method}"
        );
    }
}

#[tokio::test]
async fn ping_answers_without_an_execution_grant() {
    let fixture = Fixture::without_tmux(false).await;
    assert_eq!(
        fixture.ok("machine.ping", json!({})).await,
        json!({"status":"alive"})
    );
}

#[tokio::test]
async fn host_served_and_unknown_methods_are_invalid() {
    let fixture = Fixture::without_tmux(false).await;
    for method in [
        "machine.attach",
        "machine.report",
        "machine.call_tool",
        "machine.pty_output",
        "machine.nope",
    ] {
        assert_eq!(
            fixture.call(method, json!({})).await,
            Err(format!("invalid method: {method}"))
        );
    }
}

#[tokio::test]
async fn offered_methods_refuse_until_attached_and_after_detach() {
    let fixture = Fixture::without_tmux(true).await;
    let read = json!({"op":"read","export":"notes","path":"one"});
    let exec = json!({"cmd":"true","cwd":fixture.cwd()});
    let not_attached = json!({"status":"refused","reason":"machine_not_attached","message":"machine is not attached"});
    for _ in 0..2 {
        assert_eq!(
            fixture.ok("machine.fs_op", read.clone()).await,
            json!({"status":"refused","reason":"fs_not_available","message":"fs.read is not available"})
        );
        assert_eq!(
            fixture
                .ok("machine.fs_stream", begin("t", "read", "notes"))
                .await,
            not_attached
        );
        assert_eq!(
            fixture.ok("machine.exec", exec.clone()).await,
            refusal("exec_not_available")
        );
        fixture.grant(&["fs.read", "shell.exec"], &["notes"]);
        assert_eq!(
            fixture.ok("machine.exec", exec.clone()).await["status"],
            "completed"
        );
        fixture.service.detached();
    }
    assert!(fixture.call("machine.fs_op", json!({})).await.is_err());
    assert!(fixture.call("machine.fs_stream", json!({})).await.is_err());
    assert!(fixture.call("machine.exec", json!({})).await.is_err());
    assert!(fixture.call("machine.pty_open", json!({})).await.is_err());
}

#[tokio::test]
async fn filesystem_methods_gate_capability_then_granted_configured_export() {
    let fixture = Fixture::without_tmux(true).await;
    std::fs::write(fixture.root.path().join("one"), b"hello").expect("seed");
    fixture.grant(&["fs.read"], &["notes", "ghost"]);
    let read = |export: &str| json!({"op":"read","export":export,"path":"one"});
    assert_eq!(
        fixture.ok("machine.fs_op", read("notes")).await["status"],
        "completed"
    );
    for op in ["list", "stat"] {
        let path = if op == "list" { "" } else { "one" };
        let answer = fixture
            .ok(
                "machine.fs_op",
                json!({"op":op,"export":"notes","path":path}),
            )
            .await;
        assert_eq!(answer["status"], "completed", "{op}");
    }
    assert_eq!(
        fixture
            .ok(
                "machine.fs_op",
                json!({"op":"write","export":"notes","path":"two","data":""})
            )
            .await,
        json!({"status":"refused","reason":"fs_not_available","message":"fs.write is not available"})
    );
    for export in ["ghost", "other"] {
        assert_eq!(
            fixture.ok("machine.fs_op", read(export)).await,
            json!({"status":"refused","reason":"export_not_available","message":format!("export is not available: {export}")})
        );
        assert_eq!(
            fixture
                .ok("machine.fs_stream", begin("t", "read", export))
                .await["reason"],
            "export_not_available"
        );
    }

    assert_eq!(
        fixture
            .ok("machine.fs_stream", begin("w", "write", "notes"))
            .await["reason"],
        "fs_not_available"
    );
    assert_eq!(
        fixture
            .ok("machine.fs_stream", begin("r", "read", "notes"))
            .await["status"],
        "begun"
    );
    let next = json!({"op":"read","transferId":"r","seq":0});
    assert_eq!(
        fixture.ok("machine.fs_stream", next.clone()).await["last"],
        true
    );

    for id in ["r2", "r3"] {
        assert_eq!(
            fixture
                .ok("machine.fs_stream", begin(id, "read", "notes"))
                .await["status"],
            "begun"
        );
    }
    assert_eq!(
        fixture.hooks.pressure.retained(),
        Retained {
            pty_bytes: 0,
            transfers: 3,
            frame_bytes: 0,
            stream_bytes: 0
        }
    );
    fixture.hooks.pressure.shed();
    assert_eq!(fixture.service.retained(), Retained::default());
    let aborted = fixture.ok("machine.fs_stream", next).await;
    assert_eq!(aborted["status"], "refused", "{aborted}");

    fixture.grant(&["fs.read", "fs.write"], &["notes"]);
    assert_eq!(
        fixture
            .ok("machine.fs_stream", begin("r", "read", "notes"))
            .await["status"],
        "begun"
    );
    fixture.service.detached();
    fixture.grant(&["fs.read"], &["notes"]);
    assert_eq!(
        fixture
            .ok(
                "machine.fs_stream",
                json!({"op":"read","transferId":"r","seq":0})
            )
            .await["status"],
        "refused"
    );
}

#[tokio::test]
async fn exec_runs_only_inside_granted_exports() {
    let fixture = Fixture::without_tmux(true).await;
    let request = json!({"cmd":"printf hi","cwd":fixture.cwd()});
    fixture.grant(&["shell.exec"], &[]);
    assert_eq!(
        fixture.ok("machine.exec", request.clone()).await,
        refusal("path_escapes_export")
    );
    fixture.grant(&["shell.exec"], &["notes"]);
    let answer = fixture.ok("machine.exec", request).await;
    assert_eq!(answer["status"], "completed", "{answer}");
}

#[tokio::test]
async fn terminal_methods_map_to_the_tmux_driver() {
    let socket = format!(
        "oni-p3-handlers-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    let pty = Pty::new("tmux", Some(socket.clone()), "g".into()).await;
    let fixture = Fixture::new(true, pty).await;
    assert!(fixture
        .service
        .capabilities()
        .contains(&"pty.session".to_owned()));
    let open = json!({"name":"sample","cwd":fixture.cwd()});

    fixture.grant(&["fs.read"], &["notes"]);
    for method in PTY_METHODS {
        assert_eq!(
            fixture.ok(method, open.clone()).await,
            refusal("pty_not_available"),
            "{method}"
        );
    }

    fixture.grant(&["pty.session"], &[]);
    assert_eq!(
        fixture.ok("machine.pty_open", open.clone()).await["reason"],
        "path_escapes_export"
    );
    fixture.grant(&["pty.session"], &["notes"]);
    let opened = fixture.ok("machine.pty_open", open).await;
    assert_eq!(opened["cursor"], "p1:g:0", "{opened}");
    let data = "ZWNobyBoaQo=";
    fixture
        .ok("machine.pty_write", json!({"name":"sample","data":data}))
        .await;
    let echoed = fixture
        .ok("machine.pty_read", json!({"name":"sample","waitMs":5000}))
        .await;
    let shown = echoed["data"].as_str().expect("output").len();
    assert!(shown > 0, "{echoed}");
    assert!(fixture.hooks.pressure.retained().pty_bytes > 0);
    let cases = [
        (
            "machine.pty_write",
            json!({"name":"sample","data":data}),
            "status",
            json!("ok"),
        ),
        (
            "machine.pty_read",
            json!({"name":"sample"}),
            "status",
            json!("ok"),
        ),
        (
            "machine.pty_read",
            json!({"name":"sample","source":"screen"}),
            "status",
            json!("ok"),
        ),
        (
            "machine.pty_resize",
            json!({"name":"sample","cols":80,"rows":24}),
            "status",
            json!("ok"),
        ),
        (
            "machine.pty_list",
            json!({}),
            "sessions",
            json!([{"name":"sample","status":"live"}]),
        ),
        (
            "machine.pty_close",
            json!({"name":"sample"}),
            "status",
            json!("ok"),
        ),
    ];
    for (method, params, field, expected) in cases {
        let answer = fixture.ok(method, params).await;
        if method == "machine.pty_list" {
            assert_eq!(answer[field][0]["name"], expected[0]["name"], "{answer}");
            assert_eq!(
                answer[field][0]["status"], expected[0]["status"],
                "{answer}"
            );
        } else {
            assert_eq!(answer[field], expected, "{method}: {answer}");
        }
        assert!(
            fixture.call(method, json!({"bogus":1})).await.is_err(),
            "{method}"
        );
    }
    tmux_server::kill_server(&socket).await;
}

#[tokio::test]
async fn terminal_driver_failures_become_error_frames() {
    let bin = tempfile::tempdir().expect("bin");
    let tmux = script::script(
        bin.path(),
        "tmux",
        "#!/bin/sh\n[ \"$1\" = -V ] && exit 0\nexit 1\n",
    );
    let pty = Pty::new(tmux.to_str().expect("utf8"), None, "g".into()).await;
    let fixture = Fixture::new(true, pty).await;
    fixture.grant(&["pty.session"], &["notes"]);
    let answer = fixture
        .call(
            "machine.pty_open",
            json!({"name":"sample","cwd":fixture.cwd()}),
        )
        .await;
    assert!(answer.is_err(), "{answer:?}");
    let screen = json!({"name":"sample","source":1});
    assert!(fixture.call("machine.pty_read", screen).await.is_err());
}

#[tokio::test]
async fn screen_methods_gate_attachment_then_capability_and_free_frames_on_teardown() {
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new(MISSING_TMUX, None, "g".into()).await;
    let screen = ordinary_screen();
    let service = Service::open_with(&settings(false, root.path()), pty, screen).expect("service");
    let mut expected = vec!["shell.exec", "screen.read", "computer.use"];
    if oni_machine_client::code::Code::available() {
        expected.push("kernel.py");
    }
    assert_eq!(service.capabilities(), expected);
    let hooks = service.hooks(Duration::from_secs(60));
    let call = |method: &str, params: Value| (hooks.service)(method.to_owned(), Some(params));
    let capture = json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}});
    let methods = [
        ("machine.screen.list", json!({"windows":true})),
        ("machine.screen.capture", capture),
        ("machine.screen_read", json!({})),
    ];
    let not_attached = refusal("machine_not_attached");
    for (method, params) in &methods {
        assert_eq!(
            call(method, params.clone()).await.expect(method),
            not_attached
        );
        assert!(call(method, json!({"bogus":1})).await.is_err(), "{method}");
    }
    let grant = |capabilities: &[&str]| {
        service.attached(&Negotiated {
            generation: NonZeroU64::MIN,
            capabilities: capabilities.iter().map(|&id| id.to_owned()).collect(),
            exports: vec![],
        });
    };
    grant(&["shell.exec"]);
    for (method, params) in &methods {
        let answer = call(method, params.clone()).await.expect(method);
        assert_eq!(answer, refusal("screen_not_available"), "{method}");
    }
    grant(&["screen.read", "computer.use"]);
    for (method, params) in &methods {
        let answer = call(method, params.clone()).await.expect(method);
        assert_eq!(answer["status"], "ok", "{method}: {answer}");
    }
    assert!(hooks.pressure.retained().frame_bytes >= 32 * 16 * 4);
    hooks.pressure.shed();
    assert_eq!(hooks.pressure.retained().frame_bytes, 0);
    call(methods[2].0, json!({})).await.expect("read");
    assert!(hooks.pressure.retained().frame_bytes > 0);
    service.detached();
    assert_eq!(hooks.pressure.retained().frame_bytes, 0);
}

#[tokio::test]
async fn unpermitted_native_source_is_offered_but_refuses_capture() {
    use oni_machine_client::{
        input::{recorder::Recorder, Input},
        screen::{fixture::Fixture as Frames, Screen},
    };
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new(MISSING_TMUX, None, "g".into()).await;
    let source = Frames {
        denied: true,
        ..Frames::display(32, 16, 1.0)
    };
    let recorder = Recorder::default();
    recorder.deny(true);
    let service = Service::open_computer(
        &settings(false, root.path()),
        pty,
        Screen::new(Box::new(source), 2),
        Input::new(recorder.clone()),
    )
    .expect("service");
    assert!(service.capabilities().contains(&"screen.read".to_owned()));
    assert!(service.capabilities().contains(&"computer.use".to_owned()));
    assert!(service.capabilities().contains(&"input.write".to_owned()));
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: ["screen.read", "computer.use", "input.write"]
            .map(str::to_owned)
            .to_vec(),
        exports: vec![],
    });
    let hooks = service.hooks(Duration::from_secs(60));
    let reported = hooks.screen.capability(hooks.input.ready());
    assert!(!reported.grants.capture);
    assert!(!reported.grants.input);
    assert!(reported
        .blockers
        .iter()
        .any(|blocker| blocker.kind == "screen_recording_denied"));
    for (method, params) in [
        ("machine.screen.list", json!({})),
        (
            "machine.screen.capture",
            json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}}),
        ),
        ("machine.screen_read", json!({})),
    ] {
        let answer = (hooks.service)(method.to_owned(), Some(params))
            .await
            .expect(method);
        assert_eq!(answer, refusal("permission_denied"), "{method}");
    }
    let input = json!({"captureId":"cap-1","actions":[{"type":{"text":"hi"}}]});
    let answer = (hooks.service)("machine.input_write".to_owned(), Some(input))
        .await
        .expect("input");
    assert_eq!(answer, refusal("permission_denied"));
    assert_eq!(recorder.events(), []);
}

struct Panicking;

impl oni_machine_client::screen::Source for Panicking {
    fn ready(&self) -> Result<(), oni_machine_client::screen::Fault> {
        Ok(())
    }

    fn displays(
        &self,
    ) -> Result<Vec<oni_machine_client::screen::Display>, oni_machine_client::screen::Fault> {
        Ok(oni_machine_client::screen::fixture::Fixture::display(4, 4, 1.0).displays)
    }

    fn windows(
        &self,
    ) -> Result<Vec<oni_machine_client::screen::Window>, oni_machine_client::screen::Fault> {
        Ok(vec![])
    }

    fn capture_display(
        &self,
        _: u32,
        _: &mut Vec<u8>,
    ) -> Result<(u32, u32), oni_machine_client::screen::Fault> {
        panic!("backend panicked")
    }

    fn capture_window(
        &self,
        _: u32,
        _: &mut Vec<u8>,
    ) -> Result<(u32, u32), oni_machine_client::screen::Fault> {
        panic!("backend panicked")
    }
}

#[tokio::test]
async fn a_panicking_capture_backend_becomes_an_error_frame_and_frees_its_slot() {
    use oni_machine_client::screen::Screen;
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new(MISSING_TMUX, None, "g".into()).await;
    let screen = Screen::new(Box::new(Panicking), 1);
    let service = Service::open_with(&settings(false, root.path()), pty, screen).expect("service");
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["screen.read".into()],
        exports: vec![],
    });
    let hooks = service.hooks(Duration::from_secs(60));
    for _ in 0..2 {
        let answer = (hooks.service)("machine.screen_read".to_owned(), Some(json!({}))).await;
        assert!(answer.is_err(), "{answer:?}");
    }
    assert_eq!(hooks.pressure.retained().frame_bytes, 0);
}

#[tokio::test]
async fn input_methods_gate_attachment_grant_and_anchor_before_injecting() {
    use oni_machine_client::input::{recorder::Recorder, Input};
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new(MISSING_TMUX, None, "g".into()).await;
    let recorder = Recorder::default();
    let screen = ordinary_screen();
    let input = Input::new(recorder.clone());
    let service =
        Service::open_computer(&settings(false, root.path()), pty, screen, input).expect("service");
    let mut expected = vec!["shell.exec", "screen.read", "computer.use", "input.write"];
    if oni_machine_client::code::Code::available() {
        expected.push("kernel.py");
    }
    assert_eq!(service.capabilities(), expected);
    let hooks = service.hooks(Duration::from_secs(60));
    let call = |method: &str, params: Value| (hooks.service)(method.to_owned(), Some(params));
    let grant = |capabilities: &[&str]| {
        service.attached(&Negotiated {
            generation: NonZeroU64::MIN,
            capabilities: capabilities.iter().map(|&id| id.to_owned()).collect(),
            exports: vec![],
        });
    };
    let requests = |capture: &str| {
        [
            (
                "machine.input.pointer",
                json!({"requestId":"1-1","delivery":"foreground","kind":"click","at":{"captureId":capture,"x":31,"y":15},"button":"left","count":1}),
            ),
            (
                "machine.input.key",
                json!({"requestId":"1-2","delivery":"foreground","captureId":capture,"key":"Enter","action":"press"}),
            ),
            (
                "machine.input.text",
                json!({"requestId":"1-3","delivery":"foreground","captureId":capture,"text":"hi"}),
            ),
            (
                "machine.input_write",
                json!({"captureId":capture,"actions":[{"move":{"x":0,"y":0}}]}),
            ),
        ]
    };
    for (method, params) in requests("cap-1") {
        let answer = call(method, params).await.expect(method);
        assert_eq!(answer, refusal("machine_not_attached"), "{method}");
        assert!(call(method, json!({"bogus":1})).await.is_err(), "{method}");
    }
    grant(&["shell.exec", "screen.read"]);
    for (method, params) in requests("cap-1") {
        let answer = call(method, params).await.expect(method);
        assert_eq!(answer, refusal("input_not_available"), "{method}");
    }
    grant(&["screen.read", "computer.use", "input.write"]);
    let capture = json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}});
    let shot = call("machine.screen.capture", capture.clone())
        .await
        .expect("capture");
    let anchor = shot["captureId"].as_str().expect("capture id").to_owned();
    for (method, params) in requests(&anchor) {
        let answer = call(method, params).await.expect(method);
        assert_eq!(answer, json!({"status":"ok"}), "{method}");
    }
    let injected = recorder.events().len();
    assert_eq!(injected, 7);
    assert_eq!(
        call("machine.input.status", json!({"requestId":"1-1"}))
            .await
            .expect("status"),
        json!({"status":"ok","requestId":"1-1","dispatched":true,"state":"completed"})
    );
    assert_eq!(
        call("machine.input.status", json!({"requestId":"1-999"}))
            .await
            .expect("unknown status"),
        refusal("request_unknown")
    );
    let button = json!({"requestId":"1-5","delivery":"foreground","kind":"button",
        "at":{"captureId":anchor,"x":1,"y":1},"button":"left","state":"up"});
    assert_eq!(
        call("machine.input.pointer", button).await.expect("button"),
        json!({"status":"ok"})
    );
    let scroll = json!({"requestId":"1-6","delivery":"foreground","kind":"scroll",
        "at":{"captureId":anchor,"x":1,"y":1},"deltaX":0,"deltaY":1});
    assert_eq!(
        call("machine.input.pointer", scroll).await.expect("scroll"),
        json!({"status":"ok"})
    );
    assert_eq!(
        call(
            "machine.computer.close",
            json!({"generation":2,"through":1})
        )
        .await
        .expect("close"),
        json!({"status":"closed"})
    );
    assert!(call("machine.computer.close", json!({"bogus":1}))
        .await
        .is_err());
    let injected = recorder.events().len();
    let (method, params) = requests(&anchor).into_iter().next().expect("pointer");
    assert_eq!(
        call(method, params).await.expect("duplicate"),
        refusal("request_busy")
    );
    for (method, params) in requests(&anchor).into_iter().skip(1).take(2) {
        assert_eq!(
            call(method, params).await.expect("duplicate"),
            refusal("request_busy")
        );
    }
    assert_eq!(recorder.events().len(), injected);
    let out = json!({"requestId":"1-4","delivery":"foreground","kind":"move","at":{"captureId":anchor,"x":32,"y":0}});
    let answer = call("machine.input.pointer", out).await.expect("pointer");
    assert_eq!(answer, refusal("invalid_region"));

    grant(&["screen.read"]);
    for (method, params) in requests(&anchor) {
        let answer = call(method, params).await.expect(method);
        assert_eq!(answer, refusal("input_not_available"), "{method}");
    }
    service.detached();
    grant(&["screen.read", "computer.use", "input.write"]);
    for (index, (method, mut params)) in requests(&anchor).into_iter().enumerate() {
        if method != "machine.input_write" {
            params["requestId"] = json!(format!("1-{}", index + 10));
        }
        let answer = call(method, params).await.expect(method);
        assert_eq!(answer, refusal("stale_capture"), "{method}");
    }
    assert_eq!(recorder.events().len(), injected);
}

#[tokio::test]
async fn input_write_is_not_offered_without_an_input_driver() {
    use oni_machine_client::screen::{fixture::Fixture as Frames, Screen};
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new(MISSING_TMUX, None, "g".into()).await;
    let screen = Screen::new(Box::new(Frames::display(8, 8, 1.0)), 1);
    let service = Service::open_with(&settings(false, root.path()), pty, screen).expect("service");
    let mut expected = vec!["shell.exec", "screen.read", "computer.use"];
    if oni_machine_client::code::Code::available() {
        expected.push("kernel.py");
    }
    assert_eq!(service.capabilities(), expected);
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["computer.use".into(), "input.write".into()],
        exports: vec![],
    });
    let hooks = service.hooks(Duration::from_secs(60));
    let text = json!({"requestId":"1-1","delivery":"foreground","captureId":"cap-1","text":"x"});
    let answer = (hooks.service)("machine.input.text".to_owned(), Some(text)).await;
    assert_eq!(answer, Ok(refusal("input_not_available")));
    let write = json!({"captureId":"cap-1","actions":[{"type":{"text":"x"}}]});
    let answer = (hooks.service)("machine.input_write".to_owned(), Some(write)).await;
    assert_eq!(answer, Ok(refusal("input_not_available")));
}

#[tokio::test]
async fn a_panicking_input_driver_fails_the_call_without_taking_the_client_down() {
    use oni_machine_client::input::{Driver, Event, Input};
    struct Panics;
    impl Driver for Panics {
        fn pid_delivery(&self) -> bool {
            true
        }
        fn post_to_pid(&mut self, _: u32, event: &Event) -> Result<(), String> {
            self.inject(event)
        }
        fn permitted(&self) -> bool {
            true
        }
        fn inject(&mut self, _event: &Event) -> Result<(), String> {
            panic!("driver fault")
        }
    }
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new(MISSING_TMUX, None, "p".into()).await;
    let screen = ordinary_screen();
    let service = Service::open_computer(
        &settings(false, root.path()),
        pty,
        screen,
        Input::new(Panics),
    )
    .expect("service");
    let hooks = service.hooks(Duration::from_secs(60));
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["screen.read".into(), "computer.use".into()],
        exports: vec![],
    });
    let capture = json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}});
    let shot = (hooks.service)("machine.screen.capture".to_owned(), Some(capture))
        .await
        .expect("capture");
    let anchor = shot["captureId"].as_str().expect("capture id").to_owned();
    let text = json!({"requestId":"1-1","delivery":"foreground","captureId":anchor,"text":"x"});
    let failed = (hooks.service)("machine.input.text".to_owned(), Some(text.clone())).await;
    assert!(failed.expect_err("worker panic").contains("panic"));
    assert_eq!(
        (hooks.service)(
            "machine.input.status".to_owned(),
            Some(json!({"requestId":"1-1"}))
        )
        .await
        .expect("terminal status"),
        json!({"status":"ok","requestId":"1-1","dispatched":true,"state":"completed"})
    );
    let mut next = text;
    next["requestId"] = json!("1-2");
    let again = (hooks.service)("machine.input.text".to_owned(), Some(next)).await;
    assert!(again.expect_err("still faulting").contains("panic"));
}

#[tokio::test]
async fn held_input_is_released_on_detach_and_on_a_withdrawn_grant() {
    use oni_machine_client::input::{recorder::Recorder, Event, Input, Key, Named};
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new(MISSING_TMUX, None, "g".into()).await;
    let recorder = Recorder::default();
    let screen = ordinary_screen();
    let service = Service::open_computer(
        &settings(false, root.path()),
        pty,
        screen,
        Input::new(recorder.clone()),
    )
    .expect("service");
    let hooks = service.hooks(Duration::from_secs(60));
    let call = |method: &str, params: Value| (hooks.service)(method.to_owned(), Some(params));
    let grant = |capabilities: &[&str]| {
        service.attached(&Negotiated {
            generation: NonZeroU64::MIN,
            capabilities: capabilities.iter().map(|&id| id.to_owned()).collect(),
            exports: vec![],
        });
    };
    let shift = |down| Event::Key {
        key: Key::Named(Named::Shift),
        down,
    };
    let hold = |request_id: &'static str| async move {
        let capture = json!({"target":{"kind":"display","display":1},"encoding":{"format":"png"}});
        let shot = call("machine.screen.capture", capture)
            .await
            .expect("capture");
        let anchor = shot["captureId"].as_str().expect("capture id").to_owned();
        let down = json!({"requestId":request_id,"delivery":"foreground","captureId":anchor,"key":"Shift","action":"down"});
        let answer = call("machine.input.key", down).await.expect("key");
        assert_eq!(answer, json!({"status":"ok"}));
    };
    grant(&["screen.read", "computer.use"]);
    hold("1-1").await;
    service.detached();
    assert_eq!(
        recorder.events(),
        [shift(true), shift(false)],
        "detach releases"
    );
    grant(&["screen.read", "computer.use"]);
    assert_eq!(
        recorder.events().len(),
        2,
        "a reconnect inherits nothing held"
    );
    hold("1-2").await;
    grant(&["screen.read"]);
    assert_eq!(
        recorder.events(),
        [shift(true), shift(false), shift(true), shift(false)],
        "a withdrawn computer.use releases"
    );
}

#[tokio::test]
async fn observation_methods_gate_like_screen_and_settle_uses_capture_without_an_observer() {
    use oni_machine_client::{
        input::{recorder::Recorder, Input},
        screen::{fixture::Fixture as Frames, Screen},
    };
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new(MISSING_TMUX, None, "g".into()).await;
    let screen = Screen::new(Box::new(Frames::display(32, 16, 1.0)), 2);
    let service = Service::open_computer(
        &settings(false, root.path()),
        pty,
        screen,
        Input::new(Recorder::default()),
    )
    .expect("service");
    let hooks = service.hooks(Duration::from_secs(60));
    let call = |method: &str, params: Value| (hooks.service)(method.to_owned(), Some(params));
    let observe = json!({"target":{"pid":1,"windowId":2},"screenshot":false});
    let action = json!({"requestId":"1-1","observationId":"o1","target":{"pid":1,"windowId":2,"epoch":0},"ref":"AXButton[0]","action":"press"});
    let settle = json!({"target":{"pid":1,"windowId":2,"epoch":0},"quietMs":50,"timeoutMs":100});
    assert_eq!(
        call("machine.screen.settle", settle.clone())
            .await
            .expect("unattached"),
        refusal("machine_not_attached")
    );
    assert!(call("machine.screen.settle", json!({"target":{}}))
        .await
        .is_err());
    let methods = [
        ("machine.screen.observe", observe, "observe_not_available"),
        ("machine.input.action", action, "input_not_available"),
    ];
    for (method, params, _) in &methods {
        let answer = call(method, params.clone()).await.expect(method);
        assert_eq!(answer, refusal("machine_not_attached"), "{method}");
        assert!(call(method, json!({"bogus":1})).await.is_err(), "{method}");
    }
    for capabilities in [
        vec!["shell.exec"],
        vec!["screen.read", "computer.use", "input.write"],
    ] {
        service.attached(&Negotiated {
            generation: NonZeroU64::MIN,
            capabilities: capabilities.iter().map(|&id| id.to_owned()).collect(),
            exports: vec![],
        });
        for (method, params, reason) in &methods {
            let answer = call(method, params.clone()).await.expect(method);
            assert_eq!(answer, refusal(reason), "{method}");
        }
        let expected = if capabilities.contains(&"computer.use") {
            refusal("window_not_found")
        } else {
            refusal("permission_denied")
        };
        assert_eq!(
            call("machine.screen.settle", settle.clone())
                .await
                .expect("settle"),
            expected
        );
    }
    let unnamed = json!({"requestId":"1-2","observationId":"o1","target":{"pid":1,"windowId":2,"epoch":0},"ref":"AXButton[0]","action":"perform"});
    assert!(call("machine.input.action", unnamed).await.is_err());
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["screen.read".into()],
        exports: vec![],
    });
    assert_eq!(
        call("machine.input.status", json!({"requestId":"1-1"}))
            .await
            .expect("unavailable status"),
        refusal("request_unknown")
    );
    service.attached(&Negotiated {
        generation: NonZeroU64::new(2).expect("generation"),
        capabilities: vec!["computer.use".into()],
        exports: vec![],
    });
    let stale = json!({"requestId":"1-3","observationId":"o1","target":{"pid":1,"windowId":2,"epoch":0},"ref":"AXButton[0]","action":"press"});
    assert_eq!(
        call("machine.input.action", stale.clone())
            .await
            .expect("stale action"),
        json!({"status":"unverifiable","reason":"cancelled","dispatched":false,"hint":"re_observe"})
    );
    assert_eq!(
        call("machine.input.action", stale)
            .await
            .expect("duplicate action"),
        refusal("request_busy")
    );
}
