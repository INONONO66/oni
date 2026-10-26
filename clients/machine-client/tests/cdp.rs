#[path = "support/script.rs"]
mod script;

use script::script;
use std::{
    num::NonZeroU64,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_machine_client::{
    attach::{Hooks, Negotiated, Session, Uplink, UplinkCall},
    cdp::{chromium, manifest::Manifest, tunnel, Cdp, MAX_CHANNELS},
    config::ClientConfig,
    handlers::Service,
    input::Input,
    pty::ops::Pty,
    screen::{fixture::Fixture as Frames, Screen},
    transport::request_table::CallError,
};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, Semaphore},
};

const BROWSER: &str = "/devtools/browser/fake-0001";
const COMPUTER_USE: &str = "computer.use";
const LONG: Duration = Duration::from_secs(30);

#[derive(Clone, Copy)]
enum Answer {
    Browser,
    Elsewhere(u16),
    NotFound,
    RefuseUpgrade,
    Silent,
}

/// A loopback DevTools endpoint: `/json/version` answers the documented
/// version object, the browser path upgrades to a WebSocket whose socket is
/// handed to the test, and every request line is reported before it is
/// answered.
struct DevTools {
    port: u16,
    requests: mpsc::UnboundedReceiver<String>,
    sockets: mpsc::UnboundedReceiver<TcpStream>,
    hold: Arc<Semaphore>,
}

async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let byte = stream.read_u8().await.ok()?;
        head.push(byte);
    }
    Some(String::from_utf8(head).expect("ascii head"))
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then_some(value.trim())
    })
}

fn version(port: u16) -> Vec<u8> {
    json!({
        "Browser": "Chrome/140.0.7339.0",
        "Protocol-Version": "1.3",
        "User-Agent": "Mozilla/5.0",
        "V8-Version": "14.0.0",
        "WebKit-Version": "537.36",
        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{port}{BROWSER}"),
    })
    .to_string()
    .into_bytes()
}

struct Serve {
    port: u16,
    answer: Answer,
    requests: mpsc::UnboundedSender<String>,
    sockets: mpsc::UnboundedSender<TcpStream>,
    hold: Arc<Semaphore>,
}

impl Serve {
    async fn one(self: Arc<Self>, mut stream: TcpStream) {
        let Some(head) = read_head(&mut stream).await else {
            return;
        };
        let line = head.lines().next().expect("request line").to_owned();
        self.requests.send(line).expect("test listens");
        if let Some(key) = header(&head, "sec-websocket-key") {
            if matches!(self.answer, Answer::RefuseUpgrade) {
                let refusal = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";
                stream.write_all(refusal).await.expect("refusal");
                return;
            }
            let accept = STANDARD.encode(Sha1::digest(
                format!("{key}258EAFA5-E914-47A5-95CA-C5AB0DC85B11").as_bytes(),
            ));
            let switching = format!(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\
                 Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
            );
            stream.write_all(switching.as_bytes()).await.expect("101");
            self.sockets.send(stream).expect("test listens");
            return;
        }
        let body = match self.answer {
            Answer::Silent => return std::future::pending().await,
            Answer::NotFound => {
                let missing = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                stream.write_all(missing).await.expect("404");
                return;
            }
            Answer::Elsewhere(port) => version(port),
            Answer::Browser | Answer::RefuseUpgrade => version(self.port),
        };
        self.hold.acquire().await.expect("open semaphore").forget();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.expect("head");
        stream.write_all(&body).await.expect("body");
    }
}

impl DevTools {
    async fn start(answer: Answer) -> Self {
        Self::listen(answer, Semaphore::MAX_PERMITS).await
    }

    async fn held(answer: Answer) -> Self {
        Self::listen(answer, 0).await
    }

    async fn listen(answer: Answer, permits: usize) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (requests, requests_rx) = mpsc::unbounded_channel();
        let (sockets, sockets_rx) = mpsc::unbounded_channel();
        let hold = Arc::new(Semaphore::new(permits));
        let serve = Arc::new(Serve {
            port,
            answer,
            requests,
            sockets,
            hold: hold.clone(),
        });
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.expect("accept");
                tokio::spawn(serve.clone().one(stream));
            }
        });
        Self {
            port,
            requests: requests_rx,
            sockets: sockets_rx,
            hold,
        }
    }

    async fn request(&mut self) -> String {
        self.requests.recv().await.expect("request")
    }

    async fn socket(&mut self) -> TcpStream {
        self.sockets.recv().await.expect("upgraded socket")
    }
}

async fn unused_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    listener.local_addr().expect("addr").port()
}

async fn canned(response: Vec<u8>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept");
        read_head(&mut stream).await.expect("head");
        stream.write_all(&response).await.expect("response");
    });
    port
}

fn ports(ports: &[u16]) -> Manifest {
    Manifest::parse(json!({ "ports": ports }).to_string().as_bytes()).expect("manifest")
}

fn settings(root: &Path) -> ClientConfig {
    ClientConfig {
        machine_id: "laptop".into(),
        name: "Laptop".into(),
        host: "127.0.0.1:7643".into(),
        tags: vec![],
        exports: vec![],
        memory_budget_mb: 96,
        unix: Some(root.join("host.sock")),
    }
}

struct Machine {
    _root: TempDir,
    service: Arc<Service>,
    hooks: Hooks,
    calls: mpsc::Receiver<UplinkCall>,
}

impl Machine {
    async fn bare(manifest: Manifest, deadline: Duration) -> Self {
        let root = tempfile::tempdir().expect("root");
        let pty = Pty::new("/definitely/missing/tmux", None, "g".into()).await;
        let screen = Screen::new(Box::new(Frames::display(8, 8, 1.0)), 1);
        let cdp = Cdp::new(manifest, deadline);
        let service = Service::open_cdp(&settings(root.path()), pty, screen, Input::absent(), cdp)
            .expect("service");
        let hooks = service.hooks(LONG);
        let (_, calls) = Uplink::channel();
        Self {
            _root: root,
            service,
            hooks,
            calls,
        }
    }

    async fn new(manifest: Manifest) -> Self {
        let mut machine = Self::bare(manifest, LONG).await;
        machine.connect(&[COMPUTER_USE]);
        machine
    }

    fn connect(&mut self, capabilities: &[&str]) {
        let (uplink, calls) = Uplink::channel();
        self.service.uplink(uplink);
        self.calls = calls;
        self.grant(capabilities);
    }

    fn grant(&self, capabilities: &[&str]) {
        self.service.attached(&Negotiated {
            generation: NonZeroU64::MIN,
            capabilities: capabilities.iter().map(|&id| id.to_owned()).collect(),
            exports: vec![],
        });
    }

    async fn call(&self, method: &str, params: Value) -> Value {
        (self.hooks.service)(method.to_owned(), Some(params))
            .await
            .expect(method)
    }

    async fn open_for(&self, id: &str, endpoint: Value, lifetime: u64) -> Value {
        let request = json!({"channelId": id, "endpoint": endpoint, "lifetimeMs": lifetime});
        self.call("machine.cdp.open", request).await
    }

    async fn open(&self, id: &str) -> Value {
        self.open_for(id, json!({"kind":"discover"}), 60_000).await
    }

    async fn chunk(&self, id: &str, seq: i64, data: &[u8]) -> Value {
        let chunk = json!({"channelId": id, "seq": seq, "data": STANDARD.encode(data)});
        self.call("machine.cdp.chunk", chunk).await
    }

    async fn close(&self, id: &str) -> Value {
        let close = json!({"channelId": id, "reason": "requested"});
        self.call("machine.cdp.close", close).await
    }

    async fn uplinked(&mut self) -> UplinkCall {
        self.calls.recv().await.expect("uplink call")
    }

    async fn drain(&mut self, id: &str, first: i64, length: usize) -> (Vec<u8>, Vec<usize>) {
        let (mut bytes, mut sizes) = (Vec::new(), Vec::new());
        let mut seq = first;
        while bytes.len() < length {
            let call = self.uplinked().await;
            assert_eq!(call.method, "machine.cdp.chunk");
            assert_eq!(call.params["channelId"], id);
            assert_eq!(call.params["seq"], seq);
            let data = STANDARD
                .decode(call.params["data"].as_str().expect("base64"))
                .expect("decodes");
            sizes.push(data.len());
            bytes.extend(data);
            call.answer(Ok(Some(json!({"status":"accepted","seq":seq}))));
            seq += 1;
        }
        (bytes, sizes)
    }
}

fn refusal(reason: &str) -> Value {
    json!({"status":"refused","reason":reason})
}

fn opened(answer: &Value, id: &str) {
    assert_eq!(answer["status"], "opened", "{answer}");
    assert_eq!(answer["channelId"], id);
    assert!(answer["expiresAt"].as_u64().is_some(), "{answer}");
}

async fn eof(socket: &mut TcpStream) {
    let mut rest = Vec::new();
    socket.read_to_end(&mut rest).await.expect("read to eof");
    assert!(rest.is_empty(), "{rest:?}");
}

#[tokio::test]
async fn discovery_matches_the_documented_endpoint_and_tunnels_opaque_bytes() {
    let mut dev = DevTools::start(Answer::Browser).await;
    let mut machine = Machine::new(ports(&[dev.port])).await;
    assert!(machine
        .service
        .capabilities()
        .contains(&COMPUTER_USE.to_owned()));
    opened(&machine.open("c1").await, "c1");
    assert_eq!(chromium::VERSION_PATH, "/json/version");
    assert_eq!(dev.request().await, "GET /json/version HTTP/1.1");
    assert_eq!(dev.request().await, format!("GET {BROWSER} HTTP/1.1"));
    let mut socket = dev.socket().await;

    let frame = [0x81, 0x85, 0x00, 0xff, 0x10, 0x7f, 0xfe, b'{', b'}', 0x00];
    let accepted = json!({"status":"accepted","seq":0});
    assert_eq!(machine.chunk("c1", 0, &frame).await, accepted);
    let mut received = vec![0_u8; frame.len()];
    socket.read_exact(&mut received).await.expect("frame");
    assert_eq!(received, frame);
    assert_eq!(machine.chunk("c1", 0, &frame).await, accepted);
    assert_eq!(
        machine.chunk("c1", 2, b"gap").await,
        refusal("invalid_sequence")
    );
    let next = json!({"status":"accepted","seq":1});
    assert_eq!(machine.chunk("c1", 1, b"x").await, next);
    let mut one = [0_u8; 1];
    socket.read_exact(&mut one).await.expect("next");
    assert_eq!(&one, b"x");

    let reply = [0x81, 0x03, 0xff, 0x00, 0x80];
    socket.write_all(&reply).await.expect("reply");
    assert_eq!(machine.drain("c1", 0, reply.len()).await.0, reply);
    drop(socket);
    let close = machine.uplinked().await;
    assert_eq!(close.method, "machine.cdp.close");
    assert_eq!(
        close.params,
        json!({"channelId":"c1","reason":"endpoint_closed"})
    );
    close.answer(Ok(Some(json!({"status":"closed","channelId":"c1"}))));
    assert_eq!(
        machine.chunk("c1", 2, b"late").await,
        refusal("channel_closed")
    );
    assert_eq!(machine.close("c1").await, refusal("channel_not_found"));
    assert_eq!(
        machine.chunk("never", 0, b"x").await,
        refusal("channel_not_found")
    );
    assert_eq!(machine.service.cdp_channels(), 0);
}

#[tokio::test]
async fn oversized_chunks_are_refused_and_endpoint_bytes_split_at_the_bound() {
    let mut dev = DevTools::start(Answer::Browser).await;
    let mut machine = Machine::new(ports(&[dev.port])).await;
    opened(&machine.open("big").await, "big");
    let mut socket = dev.socket().await;

    let oversized = vec![7_u8; tunnel::CHUNK_MAX_BYTES + 1];
    let params = json!({"channelId":"big","seq":0,"data":STANDARD.encode(&oversized)});
    let refused = (machine.hooks.service)("machine.cdp.chunk".into(), Some(params)).await;
    assert!(refused.is_err(), "{refused:?}");
    let bad = json!({"channelId":"big","seq":0,"data":"AB=="});
    let undecodable = (machine.hooks.service)("machine.cdp.chunk".into(), Some(bad)).await;
    assert!(undecodable.is_err(), "{undecodable:?}");

    let largest: Vec<u8> = (0..tunnel::CHUNK_MAX_BYTES)
        .map(|i| (i % 251) as u8)
        .collect();
    let mut received = vec![0_u8; largest.len()];
    let (answer, read) = tokio::join!(
        machine.chunk("big", 0, &largest),
        socket.read_exact(&mut received)
    );
    assert_eq!(answer, json!({"status":"accepted","seq":0}));
    read.expect("largest chunk");
    assert_eq!(received, largest);

    let flood: Vec<u8> = (0..600_000_usize).map(|i| (i % 253) as u8).collect();
    let writing = flood.clone();
    let writer = tokio::spawn(async move {
        socket.write_all(&writing).await.expect("flood");
        socket
    });
    let (bytes, sizes) = machine.drain("big", 0, flood.len()).await;
    assert_eq!(bytes, flood);
    assert!(
        sizes.iter().all(|&size| size <= tunnel::CHUNK_MAX_BYTES),
        "{sizes:?}"
    );
    drop(writer.await.expect("writer"));
}

#[tokio::test]
async fn wrong_ports_and_foreign_endpoints_are_not_found() {
    let closed = unused_port().await;
    let elsewhere = DevTools::start(Answer::Elsewhere(closed)).await;
    let missing = DevTools::start(Answer::NotFound).await;
    let machine = Machine::new(ports(&[closed, elsewhere.port, missing.port])).await;
    assert_eq!(machine.open("c").await, refusal("endpoint_not_found"));

    let refusing = DevTools::start(Answer::RefuseUpgrade).await;
    let machine = Machine::new(ports(&[refusing.port])).await;
    let answer = machine.open("c").await;
    assert_eq!(answer["reason"], "endpoint_not_found", "{answer}");
    assert!(answer["message"].is_string(), "{answer}");

    let silent = DevTools::start(Answer::Silent).await;
    let mut machine = Machine::bare(ports(&[silent.port]), Duration::from_millis(50)).await;
    machine.connect(&[COMPUTER_USE]);
    let answer = machine.open("c").await;
    assert_eq!(
        answer,
        json!({"status":"refused","reason":"endpoint_not_found","message":"open deadline elapsed"})
    );
}

#[tokio::test]
async fn unattached_revoked_and_unconfigured_opens_are_refused() {
    let dev = DevTools::start(Answer::Browser).await;
    let machine = Machine::bare(ports(&[dev.port]), LONG).await;
    let not_attached = refusal("machine_not_attached");
    assert_eq!(machine.open("c").await, not_attached);
    assert_eq!(machine.chunk("c", 0, b"x").await, not_attached);
    assert_eq!(machine.close("c").await, not_attached);
    machine.grant(&[COMPUTER_USE]);
    assert_eq!(machine.open("c").await, not_attached);

    let mut revoked = Machine::new(ports(&[dev.port])).await;
    revoked.connect(&["shell.exec"]);
    assert_eq!(revoked.open("c").await, refusal("cdp_not_available"));

    let unconfigured = Machine::new(Manifest::default()).await;
    assert_eq!(unconfigured.open("c").await, refusal("cdp_not_available"));
}

#[tokio::test]
async fn detach_halts_channels_and_a_reconnect_starts_clean() {
    let mut dev = DevTools::start(Answer::Browser).await;
    let mut machine = Machine::new(ports(&[dev.port])).await;
    opened(&machine.open("c1").await, "c1");
    let mut first = dev.socket().await;
    machine.service.detached();
    eof(&mut first).await;
    assert_eq!(
        machine.chunk("c1", 0, b"x").await,
        refusal("machine_not_attached")
    );

    machine.connect(&[COMPUTER_USE]);
    assert_eq!(
        machine.chunk("c1", 0, b"x").await,
        refusal("channel_not_found")
    );
    opened(&machine.open("c1").await, "c1");
    assert_eq!(machine.open("c1").await, refusal("already_open"));
    let mut sockets = vec![dev.socket().await];
    for index in 2..=MAX_CHANNELS {
        let id = format!("c{index}");
        opened(&machine.open(&id).await, &id);
        sockets.push(dev.socket().await);
    }
    assert_eq!(machine.open("extra").await, refusal("channel_limit"));
    assert_eq!(machine.service.cdp_channels(), MAX_CHANNELS);
    assert_eq!(
        machine.close("c1").await,
        json!({"status":"closed","channelId":"c1"})
    );
    eof(&mut sockets[0]).await;
    machine.service.detached();
    for socket in &mut sockets[1..] {
        eof(socket).await;
    }
    assert_eq!(machine.service.cdp_channels(), 0);
}

#[tokio::test]
async fn detach_during_discovery_refuses_the_pending_open() {
    let mut dev = DevTools::held(Answer::Browser).await;
    let machine = Machine::new(ports(&[dev.port])).await;
    let request = json!({"channelId":"c","endpoint":{"kind":"discover"},"lifetimeMs":60_000});
    let opening = tokio::spawn((machine.hooks.service)(
        "machine.cdp.open".into(),
        Some(request),
    ));
    assert_eq!(dev.request().await, "GET /json/version HTTP/1.1");
    machine.service.detached();
    dev.hold.add_permits(1);
    let answer = opening.await.expect("open task").expect("answer");
    assert_eq!(answer, refusal("machine_not_attached"));
    assert_eq!(machine.service.cdp_channels(), 0);
}

#[tokio::test]
async fn expiry_refused_uplinks_and_lost_uplinks_close_the_channel() {
    let mut dev = DevTools::start(Answer::Browser).await;
    let mut machine = Machine::new(ports(&[dev.port])).await;
    let discover = json!({"kind":"discover"});
    opened(&machine.open_for("short", discover, 1).await, "short");
    let mut short = dev.socket().await;
    let expired = machine.uplinked().await;
    assert_eq!(
        expired.params,
        json!({"channelId":"short","reason":"expired"})
    );
    expired.answer(Ok(None));
    eof(&mut short).await;

    opened(&machine.open("refused").await, "refused");
    let mut socket = dev.socket().await;
    socket.write_all(b"a").await.expect("byte");
    let chunk = machine.uplinked().await;
    chunk.answer(Ok(Some(refusal("channel_not_found"))));
    let failed = machine.uplinked().await;
    assert_eq!(
        failed.params,
        json!({"channelId":"refused","reason":"failed"})
    );
    failed.answer(Err(CallError::Disconnected));
    eof(&mut socket).await;

    opened(&machine.open("lost").await, "lost");
    let mut lost = dev.socket().await;
    machine.calls.close();
    lost.write_all(b"b").await.expect("byte");
    eof(&mut lost).await;
    assert_eq!(machine.service.cdp_channels(), 0);
}

#[tokio::test]
async fn a_reset_endpoint_fails_the_next_write_as_closed() {
    let mut dev = DevTools::start(Answer::Browser).await;
    let mut machine = Machine::new(ports(&[dev.port])).await;
    opened(&machine.open("reset").await, "reset");
    let socket = dev.socket().await;
    let mut held = socket;
    held.write_all(b"z").await.expect("byte");
    let pending = machine.uplinked().await;
    held.set_zero_linger().expect("linger");
    drop(held);
    let mut seq = 0;
    let closed = loop {
        let answer = machine.chunk("reset", seq, b"payload").await;
        if answer["status"] != "accepted" {
            break answer;
        }
        seq += 1;
        assert!(seq < 100_000, "the reset never reached the tunnel");
    };
    assert_eq!(closed, refusal("channel_closed"));
    pending.answer(Ok(Some(json!({"status":"accepted","seq":0}))));
    assert_eq!(machine.service.cdp_channels(), 0);
}

#[tokio::test]
async fn closed_ids_are_bounded_to_the_most_recent() {
    let mut dev = DevTools::start(Answer::Browser).await;
    let machine = Machine::new(ports(&[dev.port])).await;
    for index in 0..65 {
        let id = format!("k{index}");
        opened(&machine.open(&id).await, &id);
        let mut socket = dev.socket().await;
        assert_eq!(machine.close(&id).await["status"], "closed");
        eof(&mut socket).await;
    }
    assert_eq!(
        machine.chunk("k0", 0, b"x").await,
        refusal("channel_not_found")
    );
    assert_eq!(
        machine.chunk("k64", 0, b"x").await,
        refusal("channel_closed")
    );
}

fn launcher(dir: &Path, port: u16) -> PathBuf {
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{argv}'\necho $$ > '{pid}'\n\
         echo 'warming up' >&2\n\
         echo 'DevTools listening on ws://127.0.0.1:1/devtools/browser/other' >&2\n\
         echo 'DevTools listening on ws://127.0.0.1:{port}{BROWSER}' >&2\n\
         exec tail -f /dev/null\n",
        argv = dir.join("argv").display(),
        pid = dir.join("pid").display(),
    );
    script(dir, "browser", &body)
}

fn launch_manifest(entries: &[(&str, &Path, u16)], profile: &Path) -> Manifest {
    let launch: Vec<Value> = entries
        .iter()
        .map(|(name, binary, port)| {
            json!({"name": name, "binary": binary, "args": ["--headless=new"],
                   "port": port, "profile": profile})
        })
        .collect();
    Manifest::parse(json!({ "launch": launch }).to_string().as_bytes()).expect("manifest")
}

#[tokio::test]
async fn launch_runs_only_the_manifest_binary_and_close_kills_it() {
    let dir = tempfile::tempdir().expect("dir");
    let mut dev = DevTools::start(Answer::Browser).await;
    let missing = DevTools::start(Answer::NotFound).await;
    let refusing = DevTools::start(Answer::RefuseUpgrade).await;
    let browser = launcher(dir.path(), dev.port);
    let exits = script(dir.path(), "exits", "#!/bin/sh\necho 'no endpoint' >&2\n");
    let chatty = script(
        dir.path(),
        "chatty",
        "#!/bin/sh\ni=0\nwhile [ $i -lt 70 ]; do echo line >&2; i=$((i+1)); done\n",
    );
    let lost = launcher(&tempfile::tempdir().expect("lost dir").keep(), missing.port);
    let refused = launcher(
        &tempfile::tempdir().expect("refused dir").keep(),
        refusing.port,
    );
    let absent = dir.path().join("absent");
    let profile = dir.path().join("profile");
    let manifest = launch_manifest(
        &[
            ("fake", &browser, dev.port),
            ("exits", &exits, dev.port),
            ("chatty", &chatty, dev.port),
            ("absent", &absent, dev.port),
            ("lost", &lost, missing.port),
            ("refused", &refused, refusing.port),
        ],
        &profile,
    );
    let mut machine = Machine::new(manifest).await;
    let launch = |name: &str| json!({"kind":"launch","manifest":name});

    opened(&machine.open_for("b", launch("fake"), 60_000).await, "b");
    let argv = std::fs::read_to_string(dir.path().join("argv")).expect("argv");
    let expected = [
        "--headless=new".to_owned(),
        format!("--remote-debugging-port={}", dev.port),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".to_owned(),
        "--no-default-browser-check".to_owned(),
    ];
    assert_eq!(argv.lines().collect::<Vec<_>>(), expected);
    assert_eq!(dev.request().await, "GET /json/version HTTP/1.1");
    let mut socket = dev.socket().await;
    socket.write_all(b"hello").await.expect("hello");
    assert_eq!(machine.drain("b", 0, 5).await.0, b"hello");
    let pid = std::fs::read_to_string(dir.path().join("pid")).expect("pid");
    assert_eq!(
        machine.close("b").await,
        json!({"status":"closed","channelId":"b"})
    );
    let alive = Command::new("kill")
        .args(["-0", pid.trim()])
        .stderr(Stdio::null())
        .status()
        .expect("kill -0");
    assert!(!alive.success(), "browser {pid} outlived its channel");
    eof(&mut socket).await;

    for name in ["exits", "chatty", "absent", "lost", "refused"] {
        let answer = machine.open_for(name, launch(name), 60_000).await;
        assert_eq!(answer["reason"], "launch_failed", "{name}: {answer}");
        assert!(answer["message"].is_string(), "{name}: {answer}");
    }
    let unknown = machine.open_for("u", launch("unknown"), 60_000).await;
    assert_eq!(unknown, refusal("manifest_not_found"));
}

#[tokio::test]
async fn detach_kills_a_launched_browser() {
    let dir = tempfile::tempdir().expect("dir");
    let mut dev = DevTools::start(Answer::Browser).await;
    let browser = launcher(dir.path(), dev.port);
    let manifest = launch_manifest(&[("fake", &browser, dev.port)], &dir.path().join("p"));
    let machine = Machine::new(manifest).await;
    let launch = json!({"kind":"launch","manifest":"fake"});
    opened(&machine.open_for("b", launch, 60_000).await, "b");
    let mut socket = dev.socket().await;
    machine.service.detached();
    eof(&mut socket).await;
}

#[test]
fn endpoint_selection_accepts_only_this_loopback_port() {
    let documented = br#"{"Browser":"Chrome/140","Protocol-Version":"1.3",
        "webSocketDebuggerUrl":"ws://localhost:9222/devtools/browser/b0b8a4fb-bb17-4359-9533-a8d9f3908bd8"}"#;
    assert_eq!(
        chromium::endpoint(documented, 9222).as_deref(),
        Some("/devtools/browser/b0b8a4fb-bb17-4359-9533-a8d9f3908bd8")
    );
    assert_eq!(chromium::endpoint(documented, 9223), None);
    for url in [
        "wss://127.0.0.1:9222/devtools/browser/x",
        "ws://127.0.0.1:9222",
        "ws://10.0.0.5:9222/devtools/browser/x",
        "ws://[::1]:9222/devtools/browser/x",
        "ws://127.0.0.1/devtools/browser/x",
        "ws://127.0.0.1:port/devtools/browser/x",
    ] {
        let body = json!({ "webSocketDebuggerUrl": url }).to_string();
        assert_eq!(chromium::endpoint(body.as_bytes(), 9222), None, "{url}");
    }
    assert_eq!(chromium::endpoint(b"{}", 9222), None);
    assert_eq!(chromium::endpoint(b"not json", 9222), None);
}

#[tokio::test]
async fn loopback_get_is_bounded_and_refuses_malformed_replies() {
    let ok = canned(b"HTTP/1.1 200 OK\r\n\r\nabc".to_vec()).await;
    assert_eq!(
        tunnel::get(ok, "/json/version").await.expect("body"),
        b"abc"
    );
    let sized = canned(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".to_vec()).await;
    assert_eq!(tunnel::get(sized, "/").await.expect("sized"), b"abc");

    let mut huge = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
    huge.extend(vec![b'x'; 70 * 1024]);
    let mut endless = b"HTTP/1.1 200 OK\r\n".to_vec();
    endless.extend(vec![b'h'; 17 * 1024]);
    let replies = [
        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdef".to_vec(),
        b"garbage\r\n\r\n".to_vec(),
        huge,
        endless,
        Vec::new(),
    ];
    for reply in replies {
        let port = canned(reply).await;
        assert!(tunnel::get(port, "/").await.is_err());
    }
    assert!(tunnel::get(unused_port().await, "/").await.is_err());

    let wrong_accept =
        canned(b"HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: AAAA\r\n\r\n".to_vec())
            .await;
    assert!(tunnel::upgrade(wrong_accept, BROWSER).await.is_err());
    let not_upgraded = canned(b"HTTP/1.1 200 OK\r\n\r\n".to_vec()).await;
    assert!(tunnel::upgrade(not_upgraded, BROWSER).await.is_err());
    assert!(tunnel::upgrade(unused_port().await, BROWSER).await.is_err());
}

async fn pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (near, far) = tokio::join!(TcpStream::connect(("127.0.0.1", port)), listener.accept());
    (near.expect("connect"), far.expect("accept").0)
}

/// One sender type for every call, so a single instantiation of `forward`
/// walks the leftover refusal, the leftover hand-off and the read refusal.
fn recorder(
    sent: mpsc::UnboundedSender<(i64, Vec<u8>)>,
    accept: usize,
) -> impl FnMut(i64, Vec<u8>) -> std::future::Ready<bool> {
    let mut taken = 0;
    move |seq, data| {
        taken += 1;
        sent.send((seq, data)).expect("recorded");
        std::future::ready(taken <= accept)
    }
}

#[tokio::test]
async fn forward_sends_leftover_first_and_stops_on_a_refused_send() {
    let (near, _far) = pair().await;
    let (reader, _writer) = near.into_split();
    let (sent, _seen) = mpsc::unbounded_channel();
    let stopped = tunnel::forward(reader, b"early".to_vec(), recorder(sent, 0)).await;
    assert!(!stopped);

    let (near, mut other) = pair().await;
    let (reader, _writer) = near.into_split();
    let (sent, mut refused) = mpsc::unbounded_channel();
    other.write_all(b"late").await.expect("late");
    let stopped = tunnel::forward(reader, b"early".to_vec(), recorder(sent, 1)).await;
    assert!(!stopped);
    assert_eq!(refused.recv().await, Some((0, b"early".to_vec())));
    assert_eq!(refused.recv().await.map(|(seq, _)| seq), Some(1));

    let (near, mut other) = pair().await;
    let (reader, _writer) = near.into_split();
    let (sent, mut seen) = mpsc::unbounded_channel();
    other.write_all(b"late").await.expect("late");
    drop(other);
    let clean = tunnel::forward(reader, b"early".to_vec(), recorder(sent, usize::MAX)).await;
    assert!(clean);

    let (near, other) = pair().await;
    let (reader, _writer) = near.into_split();
    let (sent, mut nothing) = mpsc::unbounded_channel();
    drop(other);
    assert!(tunnel::forward(reader, Vec::new(), recorder(sent, usize::MAX)).await);
    assert_eq!(nothing.recv().await, None);
    assert_eq!(seen.recv().await, Some((0, b"early".to_vec())));
    let mut late = Vec::new();
    while let Some((seq, data)) = seen.recv().await {
        assert!(seq >= 1);
        late.extend(data);
    }
    assert_eq!(late, b"late");
}

#[test]
fn manifest_refuses_malformed_entries_and_absent_means_unconfigured() {
    let dir = tempfile::tempdir().expect("dir");
    let absent = Manifest::load(&dir.path().join("cdp.json")).expect("absent");
    assert!(!absent.configured());
    assert!(Manifest::load(dir.path()).is_err());
    std::fs::write(dir.path().join("cdp.json"), br#"{"ports":[9222]}"#).expect("write");
    assert!(Manifest::load(&dir.path().join("cdp.json"))
        .expect("loads")
        .configured());

    let entry = |name: &str, binary: &str, profile: &str, port: u16, args: usize| {
        json!({"name":name,"binary":binary,"profile":profile,"port":port,
               "args": vec!["--x"; args]})
    };
    let valid = entry("chrome", "/usr/bin/chromium", "/tmp/p", 9222, 1);
    let launch_only = json!({ "launch": [valid.clone()] }).to_string();
    let parsed = Manifest::parse(launch_only.as_bytes()).expect("launch only");
    assert!(parsed.configured());
    assert!(parsed.entry("chrome").is_some());
    assert!(parsed.entry("other").is_none());

    let invalid = [
        json!({ "ports": vec![9222; 17] }),
        json!({ "ports": [0] }),
        json!({ "launch": vec![valid.clone(); 17] }),
        json!({ "launch": [valid.clone(), valid] }),
        json!({ "launch": [entry("Chrome", "/b", "/p", 9222, 0)] }),
        json!({ "launch": [entry("", "/b", "/p", 9222, 0)] }),
        json!({ "launch": [entry("bad name", "/b", "/p", 9222, 0)] }),
        json!({ "launch": [entry(&"a".repeat(65), "/b", "/p", 9222, 0)] }),
        json!({ "launch": [entry("c", "bin", "/p", 9222, 0)] }),
        json!({ "launch": [entry("c", "/b", "p", 9222, 0)] }),
        json!({ "launch": [entry("c", "/b", "/p", 0, 0)] }),
        json!({ "launch": [entry("c", "/b", "/p", 9222, 65)] }),
        json!({ "hosts": ["example.com"] }),
    ];
    for manifest in invalid {
        let error = Manifest::parse(manifest.to_string().as_bytes());
        assert!(error.is_err(), "{manifest}");
        assert!(!error.expect_err("refused").to_string().is_empty());
    }
}
