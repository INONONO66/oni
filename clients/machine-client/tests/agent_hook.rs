use std::{
    future::Future,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use oni_machine_client::{
    agent::hook::{self, Decide, Outcome},
    config::ClientConfig,
    handlers::Service,
    pty::ops::Pty,
};
use oni_protocol::{AgentPermissionDecision, AgentPermissionRequest};
use serde_json::{json, Value};
use tempfile::{tempdir, TempDir};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
};

const WAIT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
enum Host {
    Allow,
    Deny,
    Elsewhere,
    Silent,
}

impl Decide for Host {
    fn decide(
        &self,
        request: AgentPermissionRequest,
    ) -> impl Future<Output = AgentPermissionDecision> + Send {
        let host = *self;
        async move {
            let (session, id) = (
                request.session_id.to_string(),
                request.request_id.to_string(),
            );
            let answer = match host {
                Host::Allow => json!({"status": "allowed", "sessionId": session, "requestId": id}),
                Host::Deny => json!({
                    "status": "refused", "sessionId": session, "requestId": id, "reason": "denied",
                }),
                Host::Elsewhere => {
                    json!({"status": "allowed", "sessionId": session, "requestId": "other"})
                }
                Host::Silent => std::future::pending().await,
            };
            oni_protocol::decode(answer).expect("decision")
        }
    }
}

struct Socket {
    _directory: TempDir,
    path: PathBuf,
}

fn socket() -> Socket {
    let directory = tempdir().expect("socket directory");
    let path = directory.path().join("client/hook.sock");
    Socket {
        _directory: directory,
        path,
    }
}

fn serve<D: Decide>(path: &Path, decider: D) -> tokio::task::JoinHandle<()> {
    let listener = hook::bind(path).expect("bind hook socket");
    tokio::spawn(hook::serve(listener, Arc::new(decider)))
}

fn claude_input() -> Vec<u8> {
    json!({
        "session_id": "s-1", "hook_event_name": "PreToolUse", "tool_name": "Bash",
        "tool_input": {"command": "ls"}, "tool_use_id": "toolu_1",
    })
    .to_string()
    .into_bytes()
}

fn pi_input() -> Vec<u8> {
    json!({"sessionId": "s-2", "toolCallId": "call-1", "toolName": "bash", "input": {"command": "ls"}})
        .to_string()
        .into_bytes()
}

async fn hook_run(cli: &str, input: &[u8], path: &Path) -> Outcome {
    hook::run(cli, input, path, WAIT).await
}

fn blocked(outcome: &Outcome, reason: &str) {
    assert_eq!(
        (
            outcome.code,
            outcome.stdout.as_str(),
            outcome.stderr.as_str()
        ),
        (2, "", reason)
    );
}

#[tokio::test]
async fn claude_hook_round_trip_carries_the_host_verdict() {
    let socket = socket();
    let server = serve(&socket.path, Host::Allow);
    let mode = std::fs::metadata(&socket.path)
        .expect("socket")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);

    let allowed = hook_run("claude-code", &claude_input(), &socket.path).await;
    assert_eq!((allowed.code, allowed.stderr.as_str()), (0, ""));
    let answer: Value = serde_json::from_str(&allowed.stdout).expect("hook JSON");
    assert_eq!(
        answer,
        json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}})
    );
    server.abort();

    let server = serve(&socket.path, Host::Deny);
    let denied = hook_run("claude-code", &claude_input(), &socket.path).await;
    blocked(&denied, "oni: permission refused (denied)");
    server.abort();
}

#[tokio::test]
async fn pi_and_omp_hooks_allow_on_exit_zero_and_block_on_refusal() {
    let socket = socket();
    let server = serve(&socket.path, Host::Allow);
    for cli in ["pi", "omp"] {
        let allowed = hook_run(cli, &pi_input(), &socket.path).await;
        assert_eq!(
            allowed,
            Outcome {
                code: 0,
                stdout: String::new(),
                stderr: String::new()
            }
        );
    }
    server.abort();
    let server = serve(&socket.path, Host::Elsewhere);
    let mismatched = hook_run("omp", &pi_input(), &socket.path).await;
    blocked(&mismatched, "oni: permission answer names another request");
    server.abort();
}

#[tokio::test]
async fn every_failure_blocks() {
    let socket = socket();
    let unreachable = hook_run("claude-code", &claude_input(), &socket.path).await;
    assert_eq!(unreachable.code, 2);
    assert!(
        unreachable.stderr.starts_with("oni: client not reachable"),
        "{unreachable:?}"
    );

    for cli in ["codex", "unknown"] {
        let outcome = hook_run(cli, &pi_input(), &socket.path).await;
        assert_eq!(outcome.code, 2, "{cli}");
    }
    blocked(
        &hook_run("unknown", &pi_input(), &socket.path).await,
        "oni: no permission hook for unknown",
    );
    for input in [b"not json".as_slice(), b"{\"session_id\":\"s\"}"] {
        blocked(
            &hook_run("claude-code", input, &socket.path).await,
            "oni: no permission request in hook input",
        );
    }

    let server = serve(&socket.path, Host::Silent);
    let request = hook::Verdict::Blocked("oni: permission request timed out".to_owned());
    let pending = oni_protocol::decode::<AgentPermissionRequest>(json!({
        "sessionId": "s", "requestId": "r", "tool": "t", "description": "",
    }))
    .expect("request");
    assert_eq!(
        hook::ask(&socket.path, &pending, Duration::from_millis(50)).await,
        request
    );
    server.abort();
}

async fn answering(path: &Path, reply: &'static [u8]) -> tokio::task::JoinHandle<()> {
    let listener = UnixListener::bind(path).expect("fake client");
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("hook connects");
        // Read the whole request frame first, as the real client does: replying
        // and closing after one byte races the hook's own write of that frame.
        let (read, mut write) = stream.into_split();
        let mut request = Vec::new();
        BufReader::new(read)
            .read_until(b'\n', &mut request)
            .await
            .expect("request");
        write.write_all(reply).await.expect("reply");
    })
}

#[tokio::test]
async fn malformed_or_missing_answers_block() {
    let socket = socket();
    std::fs::create_dir_all(socket.path.parent().expect("parent")).expect("directory");
    for (reply, reason) in [
        (b"{}\n".as_slice(), "oni: malformed decision"),
        (b"".as_slice(), "oni: client closed without a decision"),
        (b"{\n".as_slice(), "oni: IPC frame is not valid JSON"),
    ] {
        let fake = answering(&socket.path, reply).await;
        let outcome = hook_run("pi", &pi_input(), &socket.path).await;
        fake.await.expect("fake client");
        assert_eq!(outcome.code, 2);
        assert!(outcome.stderr.starts_with(reason), "{outcome:?}");
        std::fs::remove_file(&socket.path).expect("fake socket");
    }
}

async fn closed_without_answer(path: &Path, request: &[u8]) {
    let mut stream = UnixStream::connect(path).await.expect("connect");
    // An oversized request may meet a socket the client already closed.
    stream.write_all(request).await.ok();
    stream.shutdown().await.ok();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.ok();
    assert!(answer.is_empty(), "{}", String::from_utf8_lossy(&answer));
}

#[tokio::test]
async fn the_socket_closes_without_a_decision_on_bad_requests() {
    let socket = socket();
    let server = serve(&socket.path, Host::Allow);
    closed_without_answer(&socket.path, b"not json\n").await;
    closed_without_answer(&socket.path, b"{\"sessionId\":\"s\"}\n").await;
    closed_without_answer(&socket.path, &vec![b' '; 70 * 1024]).await;
    server.abort();
}

#[tokio::test]
async fn bind_replaces_a_stale_socket_and_refuses_what_it_cannot_replace() {
    let socket = socket();
    let first = hook::bind(&socket.path).expect("first bind");
    drop(first);
    assert!(socket.path.exists());
    let server = serve(&socket.path, Host::Allow);
    assert_eq!(hook_run("pi", &pi_input(), &socket.path).await.code, 0);
    server.abort();

    let occupied = socket.path.with_file_name("occupied");
    std::fs::create_dir_all(occupied.join("inside")).expect("occupied directory");
    assert!(hook::bind(&occupied).is_err());
}

#[tokio::test]
async fn a_service_without_agent_sessions_refuses_every_request() {
    let socket = socket();
    let config: ClientConfig = serde_json::from_value(json!({
        "machineId": "m", "name": "m", "host": "127.0.0.1:9", "exports": [], "tags": [],
        "memoryBudgetMb": 96, "unix": null,
    }))
    .expect("config");
    let pty = Pty::new("tmux", None, "g".into()).await;
    let service = Service::open(&config, pty).expect("service");
    let listener = hook::bind(&socket.path).expect("bind");
    let server = tokio::spawn(hook::serve(listener, service));
    let outcome = hook_run("claude-code", &claude_input(), &socket.path).await;
    assert_eq!(outcome.code, 2);
    assert!(
        outcome.stderr.starts_with("oni: permission refused"),
        "{outcome:?}"
    );
    server.abort();
}
