use std::{
    num::NonZeroU64,
    os::unix::fs::PermissionsExt,
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
    config::{ClientConfig, Export},
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
    ClientConfig {
        machine_id: "laptop".into(),
        name: "Laptop".into(),
        host: "127.0.0.1:7643".into(),
        tags: vec![],
        exports: if exports {
            vec![Export {
                name: "notes".into(),
                path: root.to_str().expect("utf8 root").into(),
            }]
        } else {
            vec![]
        },
        memory_budget_mb: 96,
        unix: None,
    }
}

fn refusal(reason: &str) -> Value {
    json!({"status":"refused","reason":reason})
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
        ["fs.read", "fs.write", "shell.exec", "pty.session"]
    );
    assert_eq!(available(true, true), SUPPORTED.map(str::to_owned));
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
    assert_eq!(bare.service.capabilities(), ["shell.exec"]);
    let exported = Fixture::without_tmux(true).await;
    assert_eq!(
        exported.service.capabilities(),
        ["fs.read", "fs.write", "shell.exec"]
    );
    let missing = settings(true, Path::new("/definitely/missing/export"));
    assert!(Service::open(&missing, Pty::new(MISSING_TMUX, None, "g".into()).await).is_err());
}

#[tokio::test]
async fn unoffered_methods_answer_typed_refusals_even_when_granted() {
    let fixture = Fixture::without_tmux(true).await;
    fixture.grant(
        &["kernel.py", "screen.read", "input.write", "pty.session"],
        &["notes"],
    );
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
            transfers: 3
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
    let output = tokio::process::Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .env("TERM", "xterm")
        .output()
        .await
        .expect("tmux cleanup");
    assert!(
        output.status.success()
            || String::from_utf8_lossy(&output.stderr).contains("no server running"),
        "tmux cleanup: {output:?}"
    );
}

#[tokio::test]
async fn terminal_driver_failures_become_error_frames() {
    let bin = tempfile::tempdir().expect("bin");
    let tmux = bin.path().join("tmux");
    std::fs::write(&tmux, "#!/bin/sh\n[ \"$1\" = -V ] && exit 0\nexit 1\n").expect("script");
    std::fs::set_permissions(&tmux, std::fs::Permissions::from_mode(0o755)).expect("chmod");
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
