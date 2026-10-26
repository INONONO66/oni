#[path = "support/client_config.rs"]
mod client_config;
#[path = "support/tmux.rs"]
mod tmux_server;

use std::{
    fs,
    num::NonZeroU64,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use oni_machine_client::{
    agent::{
        launcher::{HookTarget, LaunchCommand, ProcessSpawner, PtySpawner},
        registry::{Registry, Session as Observed},
    },
    attach::{Hooks, Negotiated, Session},
    config::ClientConfig,
    handlers::{AgentOptions, OpenError, Service},
    pty::ops::Pty,
    transport::{
        client::{handler, Client},
        framing::{write_frame, Framed},
    },
};
use oni_protocol::{AgentPermissionDecision, AgentPermissionRequest};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::io::{split, AsyncWriteExt, DuplexStream, WriteHalf};

const AGENT: &str = "agent.session";
const SESSION: &str = "01a13a97-ae35-7672-bd24-274ca5f9404b";
const HEADER: &str = "{\"type\":\"session\",\"version\":3,\"id\":\"s\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"cwd\":\"/work\"}\n";

static SOCKET: AtomicU64 = AtomicU64::new(0);

fn turn(id: &str, text: &str) -> String {
    format!(
        "{{\"type\":\"message\",\"id\":\"{id}\",\"parentId\":null,\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{{\"role\":\"user\",\"content\":\"{text}\",\"timestamp\":1}}}}\n"
    )
}

struct Fixture {
    _root: TempDir,
    base: PathBuf,
    project: PathBuf,
    transcript: PathBuf,
    service: Arc<Service>,
    hooks: Hooks,
    socket: Option<String>,
}

fn config(base: &Path, exports: bool) -> ClientConfig {
    client_config::client_config(base, exports.then_some("work"))
}

fn options(base: &Path, decide: Duration) -> AgentOptions {
    AgentOptions {
        registry: base.join("registry"),
        home: base.join("home"),
        hook: HookTarget {
            program: PathBuf::from("/opt/mclient"),
            modules: base.join("hooks"),
            socket: base.join("hook.sock"),
        },
        ready: Duration::ZERO,
        decide,
        grace: Duration::from_millis(200),
    }
}

fn socket() -> String {
    format!(
        "oni-wire-{}-{}",
        std::process::id(),
        SOCKET.fetch_add(1, Ordering::Relaxed)
    )
}

async fn tmux(socket: &str) -> Pty {
    Pty::new("tmux", Some(socket.to_owned()), "g".into()).await
}

impl Fixture {
    async fn new(seed: impl FnOnce(&Path, &Path, &mut Registry)) -> Self {
        Self::with(Some(socket()), true, Duration::from_secs(5), seed).await
    }

    async fn with(
        socket: Option<String>,
        exports: bool,
        decide: Duration,
        seed: impl FnOnce(&Path, &Path, &mut Registry),
    ) -> Self {
        let root = tempfile::tempdir().expect("root");
        let base = root.path().canonicalize().expect("canonical root");
        let project = base.join("project");
        fs::create_dir_all(&project).expect("project");
        let transcript = base.join("transcript.jsonl");
        let mut registry = Registry::open(&base.join("registry")).expect("registry");
        seed(&base, &project, &mut registry);
        drop(registry);
        let pty = match &socket {
            Some(socket) => tmux(socket).await,
            None => Pty::new("/definitely/missing/tmux", None, "g".into()).await,
        };
        let service =
            Service::open_with_agents(&config(&base, exports), pty, options(&base, decide))
                .expect("service");
        let hooks = service.hooks(Duration::from_secs(60));
        Self {
            _root: root,
            base,
            project,
            transcript,
            service,
            hooks,
            socket,
        }
    }

    fn grant(&self, generation: u64, capabilities: &[&str]) {
        self.service.attached(&Negotiated {
            generation: NonZeroU64::new(generation).expect("generation"),
            capabilities: capabilities.iter().map(|&id| id.to_owned()).collect(),
            exports: vec!["work".to_owned()],
        });
    }

    async fn call(&self, method: &str, params: Value) -> Value {
        (self.hooks.service)(method.to_owned(), Some(params))
            .await
            .expect(method)
    }

    fn project(&self) -> String {
        self.project.display().to_string()
    }

    async fn shutdown(self) {
        let Some(socket) = self.socket else { return };
        tmux_server::kill_server(&socket).await;
    }
}

fn observed(project: &Path, cli: &str, id: &str, transcript: PathBuf) -> Observed {
    Observed {
        project: project.to_owned(),
        cli: cli.to_owned(),
        session_id: id.to_owned(),
        transcript,
        terminal: None,
    }
}

fn seed_pi(base: &Path, project: &Path, registry: &mut Registry) {
    let transcript = base.join("transcript.jsonl");
    fs::write(
        &transcript,
        format!("{HEADER}{}{}", turn("a", "one"), turn("b", "two")),
    )
    .expect("transcript");
    registry
        .observe(observed(project, "pi", SESSION, transcript))
        .expect("seed");
}

fn refusal(reason: &str) -> Value {
    json!({"status": "refused", "reason": reason})
}

fn texts(page: &Value) -> Vec<String> {
    page["records"]
        .as_array()
        .expect("records")
        .iter()
        .map(|record| record["text"].as_str().unwrap_or("").to_owned())
        .collect()
}

fn append(path: &Path, text: &str) {
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("transcript")
        .write_all(text.as_bytes())
        .expect("append");
}

#[tokio::test]
async fn agent_session_is_offered_with_terminals_and_exports_and_routed_only_when_granted() {
    let fixture = Fixture::new(seed_pi).await;
    assert!(fixture.service.capabilities().contains(&AGENT.to_owned()));
    let list = json!({"project": fixture.project()});
    assert_eq!(
        fixture.call("agent.session.list", list.clone()).await,
        refusal("machine_not_attached")
    );
    fixture.grant(1, &["fs.read"]);
    assert_eq!(
        fixture
            .call("agent.session.tail", json!({"sessionId": SESSION}))
            .await,
        refusal("session_not_available")
    );
    let plain =
        Service::open(&config(&fixture.base, true), tmux("unused").await).expect("plain service");
    assert!(!plain.capabilities().contains(&AGENT.to_owned()));
    plain.attached(&Negotiated {
        generation: NonZeroU64::MIN,
        capabilities: vec![AGENT.to_owned()],
        exports: vec!["work".to_owned()],
    });
    let hooks = plain.hooks(Duration::from_secs(60));
    assert_eq!(
        (hooks.service)("agent.session.list".to_owned(), Some(list)).await,
        Ok(refusal("session_not_available"))
    );
    let request: AgentPermissionRequest = oni_protocol::decode(
        json!({"sessionId": SESSION, "requestId": "r", "tool": "bash", "description": "ls"}),
    )
    .expect("request");
    assert!(matches!(
        plain.permission(request).await,
        AgentPermissionDecision::Refused { .. }
    ));
    fixture.shutdown().await;

    let bare = Fixture::with(None, true, Duration::ZERO, |_, _, _| {}).await;
    assert!(!bare.service.capabilities().contains(&AGENT.to_owned()));
    let unexported = Fixture::with(Some(socket()), false, Duration::ZERO, |_, _, _| {}).await;
    assert!(!unexported
        .service
        .capabilities()
        .contains(&AGENT.to_owned()));
    unexported.shutdown().await;

    let root = tempfile::tempdir().expect("root");
    fs::write(root.path().join("registry"), "").expect("file in place of directory");
    fs::create_dir_all(root.path().join("registry-dir")).expect("directory");
    let blocked = Service::open_with_agents(
        &config(root.path(), true),
        tmux("unused").await,
        AgentOptions {
            registry: root.path().join("registry").join("nested"),
            ..options(root.path(), Duration::ZERO)
        },
    );
    assert!(matches!(blocked, Err(OpenError::Registry(_))));
    let missing = config(&root.path().join("missing"), true);
    let unexportable = Service::open_with_agents(
        &missing,
        tmux("unused").await,
        options(root.path(), Duration::ZERO),
    );
    assert!(matches!(unexportable, Err(OpenError::Fs(_))));
}

#[tokio::test]
async fn tail_resumes_from_server_cursor_without_duplicates_across_reconnect() {
    let fixture = Fixture::new(seed_pi).await;
    fixture.grant(7, &[AGENT]);
    let list = fixture
        .call("agent.session.list", json!({"project": fixture.project()}))
        .await;
    assert_eq!(
        list,
        json!({"status": "ok", "truncated": false, "sessions": [{
            "sessionId": SESSION, "project": fixture.project(), "cli": "pi", "state": "stopped",
        }]})
    );
    assert_eq!(
        fixture
            .call("agent.session.list", json!({"project": "/elsewhere"}))
            .await,
        refusal("session_not_available")
    );

    let first = fixture
        .call("agent.session.tail", json!({"sessionId": SESSION}))
        .await;
    assert_eq!(first["status"], "ok");
    assert_eq!(texts(&first), ["one", "two"]);
    assert_eq!(first["hasMore"], false);
    let cursor = first["cursor"].clone();
    assert_eq!(cursor["sessionId"], SESSION);
    assert_eq!(cursor["generation"], 7);
    let length = fs::metadata(&fixture.transcript).expect("length").len();
    assert_eq!(cursor["byteOffset"], length);

    append(&fixture.transcript, &turn("c", "three"));
    let next = fixture
        .call("agent.session.tail", json!({"cursor": cursor}))
        .await;
    assert_eq!(texts(&next), ["three"]);

    // The host lost this response before checkpointing it: replaying the
    // acknowledged cursor yields the identical page, never an earlier one.
    let replay = fixture
        .call("agent.session.tail", json!({"cursor": cursor}))
        .await;
    assert_eq!(replay, next);

    let (left, right) = tokio::join!(
        fixture.call("agent.session.tail", json!({"cursor": cursor})),
        fixture.call("agent.session.tail", json!({"cursor": cursor})),
    );
    assert_eq!(left, next);
    assert_eq!(right, next);

    fixture.service.detached();
    assert_eq!(
        fixture
            .call("agent.session.tail", json!({"cursor": next["cursor"]}))
            .await,
        refusal("machine_not_attached")
    );
    fixture.grant(7, &[AGENT]);
    let resumed = fixture
        .call("agent.session.tail", json!({"cursor": next["cursor"]}))
        .await;
    assert_eq!(texts(&resumed), Vec::<String>::new());
    assert_eq!(resumed["cursor"], next["cursor"]);

    fixture.grant(8, &[AGENT]);
    assert_eq!(
        fixture
            .call("agent.session.tail", json!({"cursor": next["cursor"]}))
            .await,
        refusal("invalid_cursor")
    );
    let resynced = fixture
        .call("agent.session.tail", json!({"sessionId": SESSION}))
        .await;
    assert_eq!(texts(&resynced), ["one", "two", "three"]);
    assert_eq!(resynced["cursor"]["generation"], 8);
    fixture.shutdown().await;
}

#[tokio::test]
async fn tail_refuses_foreign_rotated_or_truncated_cursors_and_bounds_reads() {
    let other = "other-session";
    let fixture = Fixture::new(|base, project, registry| {
        seed_pi(base, project, registry);
        let transcript = base.join("other.jsonl");
        fs::copy(base.join("transcript.jsonl"), &transcript).expect("equal-content transcript");
        registry
            .observe(observed(project, "pi", other, transcript))
            .expect("other");
        let elsewhere = Path::new("/elsewhere");
        registry
            .observe(observed(elsewhere, "pi", "outside", base.join("x")))
            .expect("outside");
        registry
            .observe(observed(project, "bogus", "unknown-cli", base.join("x")))
            .expect("unknown cli");
        registry
            .observe(observed(project, "pi", "gone", base.join("gone.jsonl")))
            .expect("missing transcript");
    })
    .await;
    fixture.grant(1, &[AGENT]);
    let tail = |params: Value| fixture.call("agent.session.tail", params);
    let first = tail(json!({"sessionId": SESSION})).await;
    let cursor = first["cursor"].clone();

    let mut foreign = cursor.clone();
    foreign["sessionId"] = other.into();
    assert_eq!(
        tail(json!({"cursor": foreign})).await,
        refusal("invalid_cursor")
    );
    let mut non_boundary = cursor.clone();
    non_boundary["byteOffset"] = 10.into();
    let mut forged = Sha256::new();
    forged.update(
        u64::try_from(SESSION.len())
            .expect("id length")
            .to_be_bytes(),
    );
    forged.update(SESSION.as_bytes());
    forged.update(1_u64.to_be_bytes());
    forged.update(10_u64.to_be_bytes());
    forged.update(&fs::read(&fixture.transcript).expect("transcript")[..10]);
    non_boundary["recordHash"] = hex::encode(forged.finalize()).into();
    assert_eq!(
        tail(json!({"cursor": non_boundary})).await,
        refusal("invalid_cursor")
    );
    for (id, reason) in [
        ("missing", "session_not_found"),
        ("outside", "session_not_available"),
        ("unknown-cli", "session_not_available"),
        ("gone", "session_not_available"),
    ] {
        assert_eq!(
            tail(json!({"sessionId": id})).await,
            refusal(reason),
            "{id}"
        );
    }

    append(&fixture.transcript, "{not json\n");
    let malformed = tail(json!({"cursor": cursor})).await;
    assert_eq!(malformed["status"], "ok");
    let length = fs::metadata(&fixture.transcript).expect("length").len();
    assert_eq!(malformed["cursor"]["byteOffset"], length);

    append(&fixture.transcript, "{\"type\":\"message\"");
    let partial = tail(json!({"cursor": malformed["cursor"]})).await;
    assert_eq!(texts(&partial), Vec::<String>::new());
    assert_eq!(partial["cursor"], malformed["cursor"]);

    let body = fs::read_to_string(&fixture.transcript).expect("body");
    fs::write(&fixture.transcript, body.replace("one", "uno")).expect("rotate");
    assert_eq!(
        tail(json!({"cursor": cursor})).await,
        refusal("invalid_cursor")
    );
    fs::write(&fixture.transcript, HEADER).expect("truncate");
    assert_eq!(
        tail(json!({"cursor": cursor})).await,
        refusal("invalid_cursor")
    );

    let long = format!("{HEADER}{}", turn("long", &"x".repeat(6000)));
    fs::write(&fixture.transcript, &long).expect("long transcript");
    let long_page = tail(json!({"sessionId": SESSION})).await;
    let omitted = long_page["records"]
        .as_array()
        .expect("records")
        .iter()
        .find(|record| record["kind"] == "truncated")
        .expect("explicit truncation");
    assert!(omitted["originalBytes"].as_u64().expect("length") >= 6000);
    assert_eq!(long_page["cursor"]["byteOffset"], long.len());

    let mut many = String::from(HEADER);
    for index in 0..40 {
        many.push_str(&turn(&format!("m{index}"), &format!("t{index}")));
    }
    fs::write(&fixture.transcript, &many).expect("many");
    let page = tail(json!({"sessionId": SESSION})).await;
    assert_eq!(page["hasMore"], true);
    let rest = tail(json!({"cursor": page["cursor"]})).await;
    assert_eq!(
        texts(&page).len() + texts(&rest).len(),
        40,
        "every record exactly once"
    );
    assert_eq!(rest["hasMore"], false);

    let huge = format!("{HEADER}{}", turn("h", &"x".repeat(300 * 1024)));
    fs::write(&fixture.transcript, &huge).expect("huge");
    let header = tail(json!({"sessionId": SESSION})).await;
    assert_eq!(header["cursor"]["byteOffset"], HEADER.len());
    let oversized = tail(json!({"cursor": header["cursor"]})).await;
    let truncated = oversized["records"]
        .as_array()
        .expect("records")
        .iter()
        .find(|record| record["kind"] == "truncated")
        .expect("truncated record")
        .clone();
    assert!(truncated["originalBytes"].as_u64().expect("bytes") > 300 * 1024);
    assert_eq!(oversized["cursor"]["byteOffset"], huge.len());

    let growing = format!("{HEADER}{}", "y".repeat(300 * 1024));
    fs::write(&fixture.transcript, &growing).expect("unterminated");
    let pending = tail(json!({"cursor": header["cursor"]})).await;
    assert_eq!(texts(&pending), Vec::<String>::new());
    assert_eq!(pending["cursor"], header["cursor"]);

    let calls: Vec<Value> = (0..40)
        .map(|index| json!({"type": "toolCall", "id": format!("c{index}"), "name": "read", "arguments": {}}))
        .collect();
    let dense = json!({"type": "message", "id": "d", "parentId": null, "timestamp": "2026-01-01T00:00:00Z",
        "message": {"role": "assistant", "content": calls, "timestamp": 1}});
    let body = format!("{HEADER}{dense}\n");
    fs::write(&fixture.transcript, &body).expect("dense");
    let page = tail(json!({"cursor": header["cursor"]})).await;
    let records = page["records"].as_array().expect("records");
    assert_eq!(records.len(), 32);
    assert_eq!(records[31]["kind"], "truncated");
    assert_eq!(page["cursor"]["byteOffset"], body.len());
    fixture.shutdown().await;
}

#[tokio::test]
async fn cursor_refuses_equal_length_rewrites_before_the_previous_hash_window() {
    let fixture = Fixture::new(|base, project, registry| {
        seed_pi(base, project, registry);
        let transcript = base.join("transcript.jsonl");
        append(&transcript, &turn("padding", &"x".repeat(5000)));
    })
    .await;
    fixture.grant(1, &[AGENT]);
    let first = fixture
        .call("agent.session.tail", json!({"sessionId": SESSION}))
        .await;
    let cursor = first["cursor"].clone();
    let body = fs::read_to_string(&fixture.transcript).expect("transcript");
    fs::write(&fixture.transcript, body.replacen("one", "uno", 1)).expect("rewrite");
    assert_eq!(
        fixture
            .call("agent.session.tail", json!({"cursor": cursor}))
            .await,
        refusal("invalid_cursor")
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn list_caps_sessions_and_marks_truncation() {
    let fixture = Fixture::new(|base, project, registry| {
        for index in 0..257 {
            registry
                .observe(observed(
                    project,
                    "pi",
                    &format!("s{index}"),
                    base.join("t"),
                ))
                .expect("seed");
        }
    })
    .await;
    fixture.grant(1, &[AGENT]);
    let list = fixture
        .call("agent.session.list", json!({"project": fixture.project()}))
        .await;
    assert_eq!(list["truncated"], true);
    assert_eq!(list["sessions"].as_array().expect("sessions").len(), 256);
    fixture.shutdown().await;
}

struct Host {
    reader: Framed,
    writer: WriteHalf<DuplexStream>,
    _client: Client,
}

impl Host {
    fn connect(service: &Service) -> Self {
        let (host, peer) = tokio::io::duplex(1 << 16);
        let client = Client::from_stream(peer, handler(|_, _| async { Ok(json!(null)) }));
        service.connected(client.caller());
        let (reader, writer) = split(host);
        Self {
            reader: Framed::new(reader),
            writer,
            _client: client,
        }
    }

    async fn asked(&mut self) -> Value {
        let frame = self.reader.next().await.expect("frame").expect("request");
        assert_eq!(frame["method"], "agent.session.permission");
        frame
    }

    async fn answer(&mut self, frame: &Value, body: Value) {
        let mut response = json!({"v": 2, "type": "response", "id": frame["id"]});
        for (key, value) in body.as_object().expect("body") {
            response[key] = value.clone();
        }
        write_frame(&mut self.writer, &response)
            .await
            .expect("answer");
        self.writer.flush().await.expect("flush");
    }
}

fn permission(request: &str) -> AgentPermissionRequest {
    oni_protocol::decode(json!({
        "sessionId": SESSION, "requestId": request, "tool": "bash", "description": "ls",
    }))
    .expect("request")
}

fn decided(decision: &AgentPermissionDecision) -> Value {
    serde_json::to_value(decision).expect("decision")
}

#[tokio::test]
async fn owned_sessions_send_stop_and_relay_permission_to_the_host() {
    let socket = socket();
    let root = tempfile::tempdir().expect("terminal root");
    let cwd = root.path().canonicalize().expect("cwd");
    let narrow = PtySpawner::new(
        Arc::new(tmux(&socket).await),
        vec![cwd.clone()],
        Duration::ZERO,
    );
    let cat = LaunchCommand {
        executable: "/bin/cat".into(),
        args: vec![],
        env: vec![],
        requires: None,
    };
    let terminal = narrow.terminal(&narrow.launch(&cwd, &cat).await.expect("terminal"));
    let fixture = Fixture::with(
        Some(socket.clone()),
        true,
        Duration::from_millis(300),
        |base, project, registry| {
            seed_pi(base, project, registry);
            let discovered = base.join("home/.pi/agent/sessions").join(format!(
                "--{}--",
                project
                    .display()
                    .to_string()
                    .trim_start_matches('/')
                    .replace('/', "-")
            ));
            fs::create_dir_all(&discovered).expect("discovered directory");
            fs::write(discovered.join("2026_found.jsonl"), HEADER).expect("discovered transcript");
            registry
                .observe(Observed {
                    terminal: Some(terminal.clone()),
                    ..observed(project, "pi", SESSION, base.join("transcript.jsonl"))
                })
                .expect("live seed");
        },
    )
    .await;
    let unknown = permission("early");
    fixture.grant(3, &[AGENT]);
    assert_eq!(
        decided(&fixture.service.permission(unknown).await),
        json!({"status": "refused", "sessionId": SESSION, "requestId": "early", "reason": "denied"})
    );

    let open = |id: Option<&str>, cli: &str| {
        let mut params = json!({"project": fixture.project(), "cli": cli});
        if let Some(id) = id {
            params["sessionId"] = id.into();
        }
        fixture.call("agent.session.open", params)
    };
    let opened = open(Some(SESSION), "pi").await;
    assert_eq!(opened["status"], "ok");
    assert_eq!(opened["cursor"]["generation"], 3);
    assert_eq!(opened["cursor"]["byteOffset"], 0);
    let from_open = fixture
        .call("agent.session.tail", json!({"cursor": opened["cursor"]}))
        .await;
    assert_eq!(texts(&from_open), ["one", "two"]);
    assert_eq!(
        fixture
            .call("agent.session.list", json!({"project": fixture.project()}))
            .await["sessions"][0]["state"],
        "running"
    );
    assert_eq!(open(Some("found"), "pi").await["status"], "ok");
    assert_eq!(
        open(Some("absent"), "codex").await,
        refusal("session_not_available")
    );
    let outside = fixture
        .call(
            "agent.session.open",
            json!({"project": "/elsewhere", "cli": "pi"}),
        )
        .await;
    assert_eq!(outside, refusal("session_not_available"));

    let send =
        |id: &str| fixture.call("agent.session.send", json!({"sessionId": id, "text": "hi"}));
    assert_eq!(send(SESSION).await, json!({"status": "ok"}));
    assert_eq!(send("found").await, refusal("session_not_available"));
    assert_eq!(send("missing").await, refusal("session_not_found"));

    assert_eq!(
        decided(&fixture.service.permission(permission("r0")).await)["reason"],
        "denied"
    );

    let mut host = Host::connect(&fixture.service);
    let service = fixture.service.clone();
    let asking = tokio::spawn(async move { service.permission(permission("r1")).await });
    let frame = host.asked().await;
    assert_eq!(frame["params"]["requestId"], "r1");
    host.answer(
        &frame,
        json!({"result": {"status": "allowed", "sessionId": SESSION, "requestId": "r1"}}),
    )
    .await;
    assert_eq!(
        decided(&asking.await.expect("decision")),
        json!({"status": "allowed", "sessionId": SESSION, "requestId": "r1"})
    );

    for (request, body) in [
        ("r2", json!({"error": {"code": 1, "message": "no"}})),
        ("r3", json!({"result": {"status": "maybe"}})),
        (
            "r4",
            json!({"result": {"status": "allowed", "sessionId": SESSION, "requestId": "other"}}),
        ),
    ] {
        let service = fixture.service.clone();
        let asking = tokio::spawn(async move { service.permission(permission(request)).await });
        let frame = host.asked().await;
        host.answer(&frame, body).await;
        assert_eq!(
            decided(&asking.await.expect("decision"))["reason"],
            "denied",
            "{request}"
        );
    }

    let service = fixture.service.clone();
    let asking = tokio::spawn(async move { service.permission(permission("r5")).await });
    host.asked().await;
    assert_eq!(
        decided(&asking.await.expect("decision"))["reason"],
        "timeout"
    );

    let service = fixture.service.clone();
    let asking = tokio::spawn(async move { service.permission(permission("r6")).await });
    host.asked().await;
    drop(host);
    assert_eq!(
        decided(&asking.await.expect("decision"))["reason"],
        "denied"
    );

    let stop = |id: &str| fixture.call("agent.session.stop", json!({"sessionId": id}));
    assert_eq!(stop("found").await, refusal("session_not_available"));
    assert_eq!(stop(SESSION).await, json!({"status": "ok"}));
    assert_eq!(stop(SESSION).await, refusal("session_not_available"));
    fixture.service.detached();
    assert_eq!(stop(SESSION).await, refusal("machine_not_attached"));
    fixture.shutdown().await;
}
