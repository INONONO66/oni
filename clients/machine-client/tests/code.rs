#[path = "support/client_config.rs"]
mod client_config;

use std::{
    io::Write, num::NonZeroU64, os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc,
    time::Duration,
};

use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
use oni_machine_client::{
    attach::{Negotiated, Session},
    code::{Code, CodeError},
    handlers::Service,
    pty::ops::Pty,
    transport::{
        client::{handler, Client},
        framing::{write_frame, Framed},
    },
};
use oni_protocol::{decode, CellRequest};
use serde_json::{json, Value};
use tokio::io::{split, DuplexStream, WriteHalf};

fn connection() -> (Client, Framed, WriteHalf<DuplexStream>) {
    let (client, host) = tokio::io::duplex(1 << 20);
    let (reader, writer) = split(host);
    let client = Client::from_stream(
        client,
        handler(|_, _| async { Err("unexpected inbound request".to_owned()) }),
    );
    (client, Framed::new(reader), writer)
}

fn request(cell_id: &str, code: &str) -> CellRequest {
    decode(json!({"cellId":cell_id,"code":code,"timeoutMs":5000})).expect("valid cell request")
}

async fn service() -> (Arc<Service>, Client, tempfile::TempDir) {
    let root = tempfile::tempdir().expect("export root");
    let pty = Pty::new("/definitely/missing/tmux", None, "code".into()).await;
    let service =
        Service::open(&client_config::client_config(root.path(), None), pty).expect("service");
    assert!(
        service.capabilities().contains(&"kernel.py".to_owned()),
        "python3 must be on PATH"
    );
    let (client, _, _) = connection();
    service.connected(client.caller());
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["kernel.py".to_owned()],
        exports: vec![],
    });
    (service, client, root)
}

async fn serve(service: &Arc<Service>, method: &str, params: Value) -> Value {
    (service.hooks(Duration::from_secs(30)).service)(method.to_owned(), Some(params))
        .await
        .expect("wire answer")
}

#[tokio::test]
async fn cell_run_returns_stdout_and_value() {
    let (service, _client, _root) = service().await;
    let answer = serve(
        &service,
        "machine.run_code",
        json!({
            "cellId":"happy","code":"print('hello')\n2 + 3","timeoutMs":5000
        }),
    )
    .await;
    assert_eq!(answer["status"], "completed", "{answer}");
    assert_eq!(answer["output"]["stdout"], "hello\n");
    assert_eq!(answer["value"], "5");
    service.detached();
}

#[tokio::test]
async fn cell_tool_call_round_trips_through_host() {
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new("/definitely/missing/tmux", None, "code".into()).await;
    let service =
        Service::open(&client_config::client_config(root.path(), None), pty).expect("service");
    let (client, mut reader, mut writer) = connection();
    service.connected(client.caller());
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["kernel.py".into()],
        exports: vec![],
    });

    let code = serve(
        &service,
        "machine.run_code",
        json!({
            "cellId":"tool","code":"tool.demo(value=7)","timeoutMs":5000
        }),
    );
    let host = async {
        let call = reader.next().await.expect("host frame").expect("host call");
        assert_eq!(call["method"], "machine.call_tool");
        assert_eq!(
            call["params"],
            json!({"cellId":"tool","name":"demo","arguments":{"value":7}})
        );
        write_frame(
            &mut writer,
            &json!({
                "v":2,"type":"response","id":call["id"],
                "result":{"status":"completed","value":42}
            }),
        )
        .await
        .expect("reply");
    };
    let (answer, ()) = tokio::join!(code, host);
    assert_eq!(answer["status"], "completed", "{answer}");
    assert_eq!(answer["value"], "42");
    service.detached();
}

#[tokio::test]
async fn host_tool_refusal_is_catchable_inside_the_cell() {
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new("/definitely/missing/tmux", None, "code".into()).await;
    let service =
        Service::open(&client_config::client_config(root.path(), None), pty).expect("service");
    let (client, mut reader, mut writer) = connection();
    service.connected(client.caller());
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["kernel.py".into()],
        exports: vec![],
    });
    let code = serve(
        &service,
        "machine.run_code",
        json!({
            "cellId":"refused","code":"try:\n    tool.demo()\nexcept ToolError:\n    print('caught')",
            "timeoutMs":5000
        }),
    );
    let host = async {
        let call = reader.next().await.expect("host frame").expect("host call");
        assert_eq!(call["method"], "machine.call_tool");
        write_frame(
            &mut writer,
            &json!({
                "v":2,"type":"response","id":call["id"],
                "error":{"code":-32000,"message":"denied"}
            }),
        )
        .await
        .expect("refusal");
    };
    let (answer, ()) = tokio::join!(code, host);
    assert_eq!(answer["status"], "completed", "{answer}");
    assert_eq!(answer["output"]["stdout"], "caught\n");
    service.detached();
}

#[tokio::test]
async fn unknown_peek_and_stop_are_total() {
    let (service, _client, _root) = service().await;
    assert_eq!(
        serve(&service, "machine.peek_code", json!({"cellId":"missing"})).await,
        json!({"running":false,"output":{"stdout":"","stderr":""}})
    );
    assert_eq!(
        serve(&service, "machine.cancel_code", json!({"cellId":"missing"})).await,
        json!({"cancelled":false})
    );
    service.detached();
}

#[tokio::test]
async fn stop_while_cell_waits_for_tool_returns_cancelled() {
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new("/definitely/missing/tmux", None, "code".into()).await;
    let service =
        Service::open(&client_config::client_config(root.path(), None), pty).expect("service");
    let (client, mut reader, _writer) = connection();
    service.connected(client.caller());
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["kernel.py".into()],
        exports: vec![],
    });
    let code = serve(
        &service,
        "machine.run_code",
        json!({
            "cellId":"stop","code":"print('before')\ntool.wait()","timeoutMs":5000
        }),
    );
    let stop = async {
        let call = reader.next().await.expect("host frame").expect("host call");
        assert_eq!(call["method"], "machine.call_tool");
        let peek = serve(&service, "machine.peek_code", json!({"cellId":"stop"})).await;
        assert_eq!(peek["running"], true);
        assert_eq!(peek["output"]["stdout"], "before\n");
        assert_eq!(
            serve(&service, "machine.cancel_code", json!({"cellId":"stop"})).await["cancelled"],
            true
        );
    };
    let (answer, ()) = tokio::join!(code, stop);
    assert_eq!(answer["status"], "cancelled", "{answer}");
    assert_eq!(answer["output"]["stdout"], "before\n");
    service.detached();
}

#[tokio::test]
async fn tenant_state_persists_only_within_the_same_tenant() {
    let (service, _client, _root) = service().await;
    let first = serve(
        &service,
        "machine.run_code",
        json!({
            "cellId":"a1","tenant":"a","code":"secret = 17","timeoutMs":5000
        }),
    )
    .await;
    assert_eq!(first["status"], "completed");
    let same = serve(
        &service,
        "machine.run_code",
        json!({
            "cellId":"a2","tenant":"a","code":"secret","timeoutMs":5000
        }),
    )
    .await;
    assert_eq!(same["value"], "17");
    let other = serve(
        &service,
        "machine.run_code",
        json!({
            "cellId":"b1","tenant":"b","code":"globals().get('secret', 'missing')","timeoutMs":5000
        }),
    )
    .await;
    assert_eq!(other["value"], "'missing'");
    service.detached();
}

#[tokio::test]
async fn output_is_bounded_at_utf8_boundary() {
    let (service, _client, _root) = service().await;
    let answer = serve(
        &service,
        "machine.run_code",
        json!({
            "cellId":"cap","code":"print('😀' * 20000)","timeoutMs":5000
        }),
    )
    .await;
    assert_eq!(answer["status"], "completed", "{answer}");
    assert_eq!(
        answer["output"]["truncated"]["stdout"]["originalBytes"],
        80001
    );
    assert!(answer["output"]["stdout"]
        .as_str()
        .expect("stdout")
        .starts_with("😀"));
    assert!(answer["output"]["stdout"].as_str().expect("stdout").len() <= 65_536 + 96);
    service.detached();
}

#[tokio::test]
async fn dead_driver_and_absent_command_are_typed_failures() {
    let (client, _, _) = connection();
    let crashed = Code::with_command(PathBuf::from("/usr/bin/false"));
    let outcome = crashed.run(request("crash", "2"), client.caller()).await;
    assert!(matches!(outcome, Err(CodeError::Exited)), "{outcome:?}");
    let absent = Code::with_command(PathBuf::from("/definitely/missing/python3"));
    assert!(matches!(
        absent.run(request("absent", "2"), client.caller()).await,
        Err(CodeError::Spawn(_))
    ));
}

#[tokio::test]
async fn detach_kills_the_tenant_interpreter() {
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new("/definitely/missing/tmux", None, "code".into()).await;
    let service =
        Service::open(&client_config::client_config(root.path(), None), pty).expect("service");
    let (client, mut reader, _writer) = connection();
    service.connected(client.caller());
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["kernel.py".into()],
        exports: vec![],
    });
    let pid = serve(
        &service,
        "machine.run_code",
        json!({
            "cellId":"pid","code":"import os\nos.getpid()","timeoutMs":5000
        }),
    )
    .await["value"]
        .as_str()
        .expect("pid")
        .parse::<i32>()
        .expect("numeric pid");
    let code = serve(
        &service,
        "machine.run_code",
        json!({
            "cellId":"detach","code":"tool.wait()","timeoutMs":5000
        }),
    );
    let detach = async {
        let call = reader.next().await.expect("host frame").expect("host call");
        assert_eq!(call["method"], "machine.call_tool");
        service.detached();
    };
    let (_, ()) = tokio::join!(code, detach);
    assert_eq!(kill(Pid::from_raw(pid), None), Err(Errno::ESRCH));
}

/// A service whose host never answers tool calls, so a `tool.wait()` cell
/// holds the tenant interpreter until the cell is stopped.
type Blocked = (
    Arc<Service>,
    Client,
    Framed,
    WriteHalf<DuplexStream>,
    tempfile::TempDir,
);

async fn blocked_service() -> Blocked {
    let root = tempfile::tempdir().expect("root");
    let pty = Pty::new("/definitely/missing/tmux", None, "code".into()).await;
    let service =
        Service::open(&client_config::client_config(root.path(), None), pty).expect("service");
    let (client, reader, writer) = connection();
    service.connected(client.caller());
    service.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec!["kernel.py".into()],
        exports: vec![],
    });
    (service, client, reader, writer, root)
}

fn cell(cell_id: &str, code: &str, timeout_ms: u64) -> Value {
    json!({"cellId":cell_id,"code":code,"timeoutMs":timeout_ms})
}

#[tokio::test]
async fn duplicate_cell_id_is_refused_while_the_cell_runs() {
    let (service, _client, mut reader, _writer, _root) = blocked_service().await;
    let first = serve(
        &service,
        "machine.run_code",
        cell("same", "tool.wait()", 5000),
    );
    let second = async {
        reader.next().await.expect("host frame").expect("host call");
        let hooks = service.hooks(Duration::from_secs(30));
        let refused =
            (hooks.service)("machine.run_code".to_owned(), Some(cell("same", "1", 5000))).await;
        assert_eq!(refused, Err("cell same is already running".to_owned()));
        assert_eq!(
            serve(&service, "machine.cancel_code", json!({"cellId":"same"})).await["cancelled"],
            true
        );
    };
    let (answer, ()) = tokio::join!(first, second);
    assert_eq!(answer["status"], "cancelled", "{answer}");
    service.detached();
}

#[tokio::test]
async fn queued_cell_times_out_waiting_for_the_tenant() {
    let (service, _client, mut reader, _writer, _root) = blocked_service().await;
    let holder = serve(
        &service,
        "machine.run_code",
        cell("holder", "tool.wait()", 5000),
    );
    let queued = async {
        reader.next().await.expect("host frame").expect("host call");
        let answer = serve(&service, "machine.run_code", cell("queued", "1", 200)).await;
        assert_eq!(answer["status"], "timed_out", "{answer}");
        assert_eq!(answer["output"], json!({"stdout":"","stderr":""}));
        serve(&service, "machine.cancel_code", json!({"cellId":"holder"})).await;
    };
    let (answer, ()) = tokio::join!(holder, queued);
    assert_eq!(answer["status"], "cancelled", "{answer}");
    service.detached();
}

#[tokio::test]
async fn queued_cell_can_be_stopped_before_it_starts() {
    let (service, _client, mut reader, _writer, _root) = blocked_service().await;
    let holder = serve(
        &service,
        "machine.run_code",
        cell("holder", "tool.wait()", 5000),
    );
    let queued = serve(&service, "machine.run_code", cell("queued", "1", 5000));
    let stop = async {
        reader.next().await.expect("host frame").expect("host call");
        let peek = serve(&service, "machine.peek_code", json!({"cellId":"queued"})).await;
        assert_eq!(
            peek,
            json!({"running":true,"output":{"stdout":"","stderr":""}})
        );
        assert_eq!(
            serve(&service, "machine.cancel_code", json!({"cellId":"queued"})).await["cancelled"],
            true
        );
        serve(&service, "machine.cancel_code", json!({"cellId":"holder"})).await;
    };
    let (held, queued, ()) = tokio::join!(holder, queued, stop);
    assert_eq!(queued["status"], "cancelled", "{queued}");
    assert_eq!(held["status"], "cancelled", "{held}");
    service.detached();
}

async fn interpreter_pid(service: &Arc<Service>, cell_id: &str) -> i32 {
    serve(
        service,
        "machine.run_code",
        cell(cell_id, "import os\nos.getpid()", 5000),
    )
    .await["value"]
        .as_str()
        .expect("pid")
        .parse()
        .expect("numeric pid")
}

#[tokio::test]
async fn timed_out_cell_is_interrupted_and_the_tenant_respawns() {
    let (service, _client, _root) = service().await;
    let pid = interpreter_pid(&service, "pid").await;
    let answer = serve(
        &service,
        "machine.run_code",
        cell("slow", "print('started')\nimport time\ntime.sleep(30)", 300),
    )
    .await;
    assert_eq!(answer["status"], "timed_out", "{answer}");
    assert_eq!(answer["output"]["stdout"], "started\n");
    assert_eq!(kill(Pid::from_raw(pid), None), Err(Errno::ESRCH));
    assert_ne!(interpreter_pid(&service, "again").await, pid);
    service.detached();
}

#[tokio::test]
async fn cell_that_ignores_sigint_is_killed_after_the_grace() {
    let (service, _client, _root) = service().await;
    let pid = interpreter_pid(&service, "pid").await;
    let answer = serve(
        &service,
        "machine.run_code",
        cell(
            "stuck",
            "import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\ntime.sleep(30)",
            300,
        ),
    )
    .await;
    assert_eq!(answer["status"], "timed_out", "{answer}");
    assert_eq!(kill(Pid::from_raw(pid), None), Err(Errno::ESRCH));
    service.detached();
}

/// A stand-in interpreter that answers the first request with fixed frames.
fn fake_driver(dir: &tempfile::TempDir, name: &str, frames: &[&str]) -> PathBuf {
    let path = dir.path().join(name);
    let mut script = std::fs::File::create(&path).expect("script");
    writeln!(script, "#!/bin/sh\nread -r _request").expect("header");
    for frame in frames {
        writeln!(script, "printf '%s\\n' '{frame}'").expect("frame");
    }
    drop(script);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("mode");
    path
}

#[tokio::test]
async fn frames_for_another_cell_and_an_early_lifecycle_are_typed_failures() {
    let dir = tempfile::tempdir().expect("scripts");
    let (client, _, _) = connection();
    let foreign = Code::with_command(fake_driver(
        &dir,
        "foreign",
        &[
            r#"{"kind":"output","cellId":"other","stream":"stdout","text":"noise","originalBytes":5}"#,
            r#"{"kind":"tool_call","cellId":"other","callId":"c","name":"demo","arguments":{}}"#,
        ],
    ));
    let outcome = foreign.run(request("mine", "1"), client.caller()).await;
    assert!(
        matches!(&outcome, Err(CodeError::Frame(message)) if message == "tool call for another cell: other"),
        "{outcome:?}"
    );
    let early = Code::with_command(fake_driver(
        &dir,
        "early",
        &[r#"{"kind":"lifecycle","event":"browser-cleanup-complete","failed":[]}"#],
    ));
    let outcome = early.run(request("mine", "1"), client.caller()).await;
    assert!(matches!(outcome, Err(CodeError::Exited)), "{outcome:?}");
}

#[tokio::test]
async fn malformed_and_off_schema_driver_frames_are_typed_failures() {
    let dir = tempfile::tempdir().expect("scripts");
    let (client, _, _) = connection();
    let garbled = Code::with_command(fake_driver(&dir, "garbled", &["not json"]));
    let outcome = garbled.run(request("mine", "1"), client.caller()).await;
    assert!(
        matches!(&outcome, Err(CodeError::Frame(message)) if message.contains("expected")),
        "{outcome:?}"
    );
    let off_schema = Code::with_command(fake_driver(
        &dir,
        "off-schema",
        &[r#"{"kind":"result","result":{"cellId":"mine","status":"bogus"}}"#],
    ));
    let outcome = off_schema.run(request("mine", "1"), client.caller()).await;
    assert!(matches!(outcome, Err(CodeError::Frame(_))), "{outcome:?}");
}
