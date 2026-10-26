#[path = "support/tmux.rs"]
mod tmux_server;

use std::sync::atomic::{AtomicU64, Ordering};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_machine_client::pty::control::ControlError;
use oni_machine_client::pty::ops::{Pty, PtyError};
use oni_protocol::{
    PtyCloseRequest, PtyOpenRequest, PtyReadRequest, PtyReadScreenRequest, PtyResizeRequest,
    PtyWriteRequest,
};
use tempfile::tempdir;

static NEXT: AtomicU64 = AtomicU64::new(0);

fn socket_name() -> String {
    format!(
        "oni-p3-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn wire<T: oni_protocol::WireRoot>(value: serde_json::Value) -> T {
    oni_protocol::decode(value).expect("valid wire request")
}

#[tokio::test]
async fn terminal_refuses_open_without_tmux() {
    let root = tempdir().expect("export");
    let pty = Pty::new("/definitely/missing/tmux", None, "g".into()).await;
    assert!(!pty.offered());
    let request: PtyOpenRequest = wire(serde_json::json!({"name":"sample","cwd":root.path()}));
    let answer = pty
        .open(&request, &[root.path().to_owned()])
        .await
        .expect("refusal");
    assert_eq!(
        serde_json::to_value(answer).expect("wire")["reason"],
        "pty_not_available"
    );
    let close: PtyCloseRequest = wire(serde_json::json!({"name":"sample"}));
    assert_eq!(
        serde_json::to_value(pty.close(&close).await.expect("close refusal")).expect("wire")
            ["reason"],
        "pty_not_available"
    );
    assert_eq!(
        serde_json::to_value(pty.list().await.expect("list refusal")).expect("wire")["reason"],
        "pty_not_available"
    );
    let read: PtyReadRequest = wire(serde_json::json!({"name":"sample"}));
    assert_eq!(
        serde_json::to_value(pty.read(&read).await.expect("read refusal")).expect("wire")["reason"],
        "pty_not_available"
    );
}

#[tokio::test]
async fn terminal_replays_output_resizes_lists_and_closes_with_real_tmux() {
    let root = tempdir().expect("export");
    let socket = socket_name();
    let pty = Pty::new("tmux", Some(socket.clone()), "g".into()).await;
    assert!(pty.offered());
    let open: PtyOpenRequest = wire(serde_json::json!({"name":"sample","cwd":root.path()}));
    let opened = pty
        .open(&open, &[root.path().to_owned()])
        .await
        .expect("open");
    assert_eq!(
        serde_json::to_value(opened).expect("wire")["cursor"],
        "p1:g:0"
    );

    let mut completed = tokio::process::Command::new("tmux")
        .args(["-L", &socket, "wait-for", "output-ready"])
        .env("TERM", "xterm")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("subscribe to command completion");
    let command = format!(
        "stty -echo; printf '\\160\\063\\055\\162\\145\\141\\144\\171\\n'; \
         tmux -L {socket} wait-for -S output-ready; exec cat\n"
    );
    let write: PtyWriteRequest =
        wire(serde_json::json!({"name":"sample","data":STANDARD.encode(command)}));
    assert_eq!(
        serde_json::to_value(pty.write(&write).await.expect("write")).expect("wire")["status"],
        "ok"
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), completed.wait())
            .await
            .expect("command completion")
            .expect("tmux wait-for")
            .success()
    );
    let screen: PtyReadScreenRequest = wire(serde_json::json!({"name":"sample","source":"screen"}));
    let screenshot =
        serde_json::to_value(pty.screen(&screen).await.expect("screen")).expect("wire");
    let read: PtyReadRequest = wire(serde_json::json!({"name":"sample"}));
    let response = pty.read(&read).await.expect("read");
    let body = serde_json::to_value(response).expect("wire");
    let bytes = STANDARD
        .decode(body["data"].as_str().expect("data"))
        .expect("base64");
    assert!(
        String::from_utf8_lossy(&bytes).contains("p3-ready"),
        "output: {bytes:?}"
    );
    let cursor = body["cursor"].as_str().expect("cursor");
    let continued: PtyReadRequest = wire(serde_json::json!({"name":"sample","cursor":cursor}));
    let next =
        serde_json::to_value(pty.read(&continued).await.expect("continuation")).expect("wire");
    assert_eq!(next["data"], "");
    let retained = pty.retained();
    assert!(retained >= bytes.len(), "{retained} < {}", bytes.len());
    assert!(pty.shed().is_none());
    assert!(pty.retained() < retained);
    let kept = serde_json::to_value(pty.read(&continued).await.expect("after shed")).expect("wire");
    assert_eq!(kept["truncated"], false, "{kept}");
    assert_eq!(screenshot["status"], "ok");
    assert!(screenshot["rows"]
        .as_array()
        .expect("screen rows")
        .iter()
        .any(|row| row.as_str().is_some_and(|text| text.contains("p3-ready"))));

    let resize: PtyResizeRequest =
        wire(serde_json::json!({"name":"sample","cols":1000,"rows":1000}));
    assert_eq!(
        serde_json::to_value(pty.resize(&resize).await.expect("resize")).expect("wire")["status"],
        "ok"
    );
    let listed = serde_json::to_value(pty.list().await.expect("list")).expect("wire");
    assert_eq!(listed["sessions"][0]["name"], "sample");
    assert_eq!(listed["sessions"][0]["status"], "live");

    let close: PtyCloseRequest = wire(serde_json::json!({"name":"sample"}));
    assert_eq!(
        serde_json::to_value(pty.close(&close).await.expect("close")).expect("wire")["status"],
        "ok"
    );
    assert_eq!(
        serde_json::to_value(pty.list().await.expect("list after close")).expect("wire")
            ["sessions"],
        serde_json::json!([])
    );
    pty.shutdown().await.expect("stop control");
    tmux_server::kill_server(&socket).await;
}

#[tokio::test]
async fn terminal_discovers_session_after_control_reconnect() {
    let root = tempdir().expect("export");
    let socket = socket_name();
    let first = Pty::new("tmux", Some(socket.clone()), "first".into()).await;
    let open: PtyOpenRequest = wire(serde_json::json!({"name":"reconnect","cwd":root.path()}));
    first
        .open(&open, &[root.path().to_owned()])
        .await
        .expect("first open");
    first.shutdown().await.expect("disconnect control");

    let second = Pty::new("tmux", Some(socket.clone()), "second".into()).await;
    let listed = serde_json::to_value(second.list().await.expect("list")).expect("wire");
    assert_eq!(listed["sessions"][0]["name"], "reconnect");
    let reopened = serde_json::to_value(
        second
            .open(&open, &[root.path().to_owned()])
            .await
            .expect("reattach"),
    )
    .expect("wire");
    assert_eq!(reopened["cursor"], "p1:second:0");
    let close: PtyCloseRequest = wire(serde_json::json!({"name":"reconnect"}));
    second.close(&close).await.expect("close");
    second.shutdown().await.expect("shutdown");
    tmux_server::kill_server(&socket).await;
}

#[tokio::test]
async fn terminal_refuses_invalid_requests_at_the_typed_boundary() {
    let root = tempdir().expect("export");
    let outside = tempdir().expect("outside export");
    let socket = socket_name();
    let pty = Pty::new("tmux", Some(socket.clone()), "g".into()).await;

    let invalid_name: PtyOpenRequest =
        wire(serde_json::json!({"name":"oni-pty-control","cwd":root.path()}));
    let answer = serde_json::to_value(
        pty.open(&invalid_name, &[root.path().to_owned()])
            .await
            .expect("invalid name refusal"),
    )
    .expect("wire");
    assert_eq!(answer["reason"], "pty_not_found");

    let escaped: PtyOpenRequest = wire(serde_json::json!({"name":"sample","cwd":outside.path()}));
    let answer = serde_json::to_value(
        pty.open(&escaped, &[root.path().to_owned()])
            .await
            .expect("escaped cwd refusal"),
    )
    .expect("wire");
    assert_eq!(answer["reason"], "path_escapes_export");

    let missing_write: PtyWriteRequest = wire(serde_json::json!({"name":"missing","data":""}));
    assert_eq!(
        serde_json::to_value(pty.write(&missing_write).await.expect("missing write"))
            .expect("wire")["reason"],
        "pty_not_found"
    );
    let missing_read: PtyReadRequest = wire(serde_json::json!({"name":"missing"}));
    assert_eq!(
        serde_json::to_value(pty.read(&missing_read).await.expect("missing read")).expect("wire")
            ["reason"],
        "pty_not_found"
    );
    let missing_screen: PtyReadScreenRequest =
        wire(serde_json::json!({"name":"missing","source":"screen"}));
    assert_eq!(
        serde_json::to_value(pty.screen(&missing_screen).await.expect("missing screen"))
            .expect("wire")["reason"],
        "pty_not_found"
    );
    let missing_resize: PtyResizeRequest =
        wire(serde_json::json!({"name":"missing","cols":80,"rows":24}));
    assert_eq!(
        serde_json::to_value(pty.resize(&missing_resize).await.expect("missing resize"))
            .expect("wire")["reason"],
        "pty_not_found"
    );
    let missing_close: PtyCloseRequest = wire(serde_json::json!({"name":"missing"}));
    assert_eq!(
        serde_json::to_value(pty.close(&missing_close).await.expect("missing close"))
            .expect("wire")["reason"],
        "pty_not_found"
    );

    let open: PtyOpenRequest = wire(serde_json::json!({"name":"sample","cwd":root.path()}));
    pty.open(&open, &[root.path().to_owned()])
        .await
        .expect("open");
    let invalid_data =
        oni_protocol::decode::<PtyWriteRequest>(serde_json::json!({"name":"sample","data":"!"}))
            .expect_err("schema rejects non-base64 data");
    assert!(invalid_data.to_string().contains("/data"), "{invalid_data}");
    let oversized_data: PtyWriteRequest =
        wire(serde_json::json!({"name":"sample","data":STANDARD.encode(vec![0; 16_385])}));
    assert!(matches!(
        pty.write(&oversized_data).await,
        Err(PtyError::Control(ControlError::Refused(message)))
            if message == "terminal input exceeds 16384 bytes"
    ));
    let invalid_wait =
        oni_protocol::decode::<PtyReadRequest>(serde_json::json!({"name":"sample","waitMs":30001}))
            .expect_err("schema bounds wait");
    assert!(invalid_wait.to_string().contains("/waitMs"));
    let invalid_resize = oni_protocol::decode::<PtyResizeRequest>(
        serde_json::json!({"name":"sample","cols":1001,"rows":24}),
    )
    .expect_err("schema bounds columns");
    assert!(invalid_resize.to_string().contains("/cols"));

    let close: PtyCloseRequest = wire(serde_json::json!({"name":"sample"}));
    pty.close(&close).await.expect("close");
    let closed = serde_json::to_value(pty.write(&oversized_data).await.expect("closed write"))
        .expect("wire");
    assert_eq!(closed["reason"], "pty_not_found");
    let closed_resize: PtyResizeRequest =
        wire(serde_json::json!({"name":"sample","cols":80,"rows":24}));
    let closed = serde_json::to_value(pty.resize(&closed_resize).await.expect("closed resize"))
        .expect("wire");
    assert_eq!(closed["reason"], "pty_not_found");
    let closed_read: PtyReadRequest = wire(serde_json::json!({"name":"sample"}));
    assert_eq!(
        serde_json::to_value(pty.read(&closed_read).await.expect("closed read")).expect("wire")
            ["reason"],
        "pty_not_found"
    );
    let closed_screen: PtyReadScreenRequest =
        wire(serde_json::json!({"name":"sample","source":"screen"}));
    assert_eq!(
        serde_json::to_value(pty.screen(&closed_screen).await.expect("closed screen"))
            .expect("wire")["reason"],
        "pty_not_found"
    );
    pty.shutdown().await.expect("shutdown");
    let _ = tokio::process::Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .env("TERM", "xterm")
        .output()
        .await;
}

#[tokio::test]
async fn terminal_lists_lost_session_after_external_close() {
    let root = tempdir().expect("export");
    let socket = socket_name();
    let pty = Pty::new("tmux", Some(socket.clone()), "g".into()).await;
    let open: PtyOpenRequest = wire(serde_json::json!({"name":"external","cwd":root.path()}));
    pty.open(&open, &[root.path().to_owned()])
        .await
        .expect("open");
    let output = tokio::process::Command::new("tmux")
        .args(["-L", &socket, "kill-session", "-t", "=external"])
        .env("TERM", "xterm")
        .output()
        .await
        .expect("external close");
    assert!(output.status.success(), "external close: {output:?}");
    let listed = serde_json::to_value(pty.list().await.expect("list")).expect("wire");
    assert_eq!(listed["sessions"][0]["status"], "lost");
    let read: PtyReadRequest = wire(serde_json::json!({"name":"external"}));
    assert_eq!(
        serde_json::to_value(pty.read(&read).await.expect("lost read")).expect("wire")["reason"],
        "pty_not_found"
    );
    pty.shutdown().await.expect("shutdown");
    let output = tokio::process::Command::new("tmux")
        .args(["-L", &socket, "kill-server"])
        .env("TERM", "xterm")
        .output()
        .await
        .expect("server cleanup");
    assert!(
        output.status.success()
            || String::from_utf8_lossy(&output.stderr).contains("no server running"),
        "server cleanup: {output:?}"
    );
}
