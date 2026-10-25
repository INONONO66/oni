#[path = "support/mod.rs"]
mod support;

use std::{
    num::NonZeroU64,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use oni_machine_client::{
    attach::{self, offer, result, run_with_probe, AttachError, Attachment, Hooks, Outcome},
    budget::{self, Budget, BudgetAction, Metrics, NoRetention, Pressure, Retained},
    config::{self, ClientConfig, Export, JoinOptions},
    handlers::{available, Service},
    pty::ops::Pty,
    report::{append_metrics, Load, Probe},
    transport::{
        client::{handler, TransportError},
        connection::{public_key_pin, HostTrust},
    },
};
use serde_json::{json, Value};
use support::fake_host::FakeHost;

fn config() -> ClientConfig {
    ClientConfig {
        machine_id: "laptop".into(),
        name: "Laptop".into(),
        host: "127.0.0.1:7643".into(),
        tags: vec![],
        exports: vec![Export {
            name: "home".into(),
            path: "/home/me".into(),
        }],
        memory_budget_mb: 96,
        unix: None,
    }
}

fn join_options(host: &str) -> JoinOptions {
    JoinOptions {
        host: host.into(),
        name: Some("Work-Mac".into()),
        tags: vec![],
        exports: vec![],
        host_cert: None,
        host_pin: None,
        trust_on_first_use: false,
        unix: None,
        memory_budget_mb: 96,
    }
}

struct Unobserved;

impl attach::Session for Unobserved {
    fn attached(&self, _: &attach::Negotiated) {}
    fn detached(&self) {}
}

fn hooks(pressure: Arc<dyn Pressure>) -> Hooks {
    Hooks {
        service: handler(|method, _| async move { Ok(json!({"served": method})) }),
        pressure,
        session: Arc::new(Unobserved),
        heartbeat: Duration::from_millis(1),
    }
}

fn host_pin(certificate: &str) -> [u8; 32] {
    let der = rustls_pemfile::certs(&mut std::io::Cursor::new(certificate.as_bytes()))
        .next()
        .expect("certificate")
        .expect("DER");
    public_key_pin(der.as_ref()).expect("pin")
}

fn attached(request: &Value, generation: u64) -> Value {
    json!({"v":2,"type":"response","id":request["id"],"result":{
        "status":"attached","effectiveCapabilities":["fs.read"],"effectiveExports":[],
        "generation":generation
    }})
}

fn reply(request: &Value, result: Value) -> Value {
    json!({"v":2,"type":"response","id":request["id"],"result":result})
}

async fn expect(host: &mut FakeHost, method: &str) -> Value {
    let frame = host.incoming.recv().await.expect("frame");
    assert_eq!(frame["method"], method, "{frame}");
    frame
}

struct FixedProbe {
    rss: AtomicU64,
}

impl FixedProbe {
    fn new(rss: u64) -> Self {
        Self {
            rss: AtomicU64::new(rss),
        }
    }
}

impl Probe for FixedProbe {
    fn load(&self, in_flight: usize) -> std::io::Result<Load> {
        Ok(Load {
            load_avg1: 0.5,
            memory_available_bytes: 1024,
            in_flight,
        })
    }

    fn rss(&self) -> std::io::Result<u64> {
        Ok(self.rss.load(Ordering::Relaxed))
    }

    fn memory(&self) -> std::io::Result<u64> {
        Ok(4096)
    }
}

#[derive(Default)]
struct CountingPressure {
    sheds: AtomicUsize,
}

impl Pressure for CountingPressure {
    fn retained(&self) -> Retained {
        Retained {
            pty_bytes: 77,
            transfers: 2,
        }
    }

    fn shed(&self) {
        self.sheds.fetch_add(1, Ordering::Relaxed);
    }
}

async fn unix_settings(host: &FakeHost, directory: &Path) -> ClientConfig {
    let mut settings = config();
    settings.unix = Some(host.endpoint.clone().into());
    config::save(&settings, directory).expect("save");
    settings
}

#[test]
fn reconnect_offer_contains_generation_and_exact_supplied_capabilities() {
    let generation = NonZeroU64::new(7).expect("nonzero");
    let value = offer(
        &config(),
        &["fs.read".into(), "pty.session".into()],
        Some(generation),
        123,
        4,
        1024,
    );
    assert_eq!(value["generation"], 7);
    assert_eq!(
        value["offeredCapabilities"],
        json!(["fs.read", "pty.session"])
    );
    assert_eq!(value["peer"], json!({"kind":"client","contractVersion":2}));
    assert_eq!(value["resources"], json!({"cpus":4,"memoryBytes":1024}));
    assert_eq!(value["exports"], json!([{"name":"home","path":"/home/me"}]));
    assert!(attach::now_ms() > 0);
}

#[test]
fn attachment_refusal_classifies_terminal_reasons() {
    for reason in [
        "stale_generation",
        "unsupported_contract",
        "peer_key_mismatch",
    ] {
        let error = result(json!({"status":"refused","reason":reason})).expect_err("refusal");
        assert!(matches!(error, AttachError::Terminal(_)));
        assert_eq!(error.exit_code(), 3);
        assert_eq!(error.reason(), reason);
    }
    let retrying =
        result(json!({"status":"refused","reason":"machine_not_enrolled"})).expect_err("refusal");
    assert!(matches!(retrying, AttachError::Call(_)));
    assert_eq!(retrying.exit_code(), 2);
    let attached = result(json!({"status":"attached","effectiveCapabilities":["fs.read"],"effectiveExports":["home"],"generation":9})).expect("attached");
    assert_eq!(attached.generation.get(), 9);
    assert_eq!(attached.capabilities, ["fs.read"]);
    assert_eq!(attached.exports, ["home"]);
    let mismatch = AttachError::Transport(TransportError::HostKeyMismatch);
    assert_eq!(
        (mismatch.exit_code(), mismatch.reason().as_str()),
        (3, "peer_key_mismatch")
    );
    assert_eq!(AttachError::MemoryBudget.exit_code(), 4);
}

#[test]
fn budget_sheds_once_and_recovers_after_two_under_samples() {
    let mut budget = Budget::new(1);
    assert_eq!(budget.sample(1_048_577), BudgetAction::Shed);
    assert!(budget.restricted());
    assert_eq!(budget.sample(1_048_577), BudgetAction::Healthy);
    assert_eq!(budget.sample(0), BudgetAction::Healthy);
    assert!(budget.restricted());
    assert_eq!(budget.sample(0), BudgetAction::Healthy);
    assert!(!budget.restricted());
    assert_eq!(budget.sample(1_048_577), BudgetAction::Shed);
    assert_eq!(budget.sample(1_048_577), BudgetAction::Healthy);
    assert_eq!(budget.sample(1_048_577), BudgetAction::Exit);
}

#[test]
fn budget_refusal_gates_exec_and_transfer_begin_only() {
    assert_eq!(
        budget::refusal("machine.exec", None),
        Some(json!({"status":"refused","reason":"exec_not_available"}))
    );
    assert_eq!(
        budget::refusal("machine.fs_stream", Some(&json!({"op":"begin"}))).expect("refused")
            ["reason"],
        "too_large"
    );
    assert_eq!(
        budget::refusal("machine.fs_stream", Some(&json!({"op":"chunk"}))),
        None
    );
    assert_eq!(budget::refusal("machine.fs_stream", None), None);
    assert_eq!(budget::refusal("machine.fs", None), None);
    NoRetention.shed();
    assert_eq!(NoRetention.retained(), Retained::default());
}

#[test]
fn saved_config_has_private_directory_and_keeps_budget() {
    let dir = tempfile::tempdir().expect("directory");
    let directory = dir.path().join("client");
    config::save(&config(), &directory).expect("save");
    let mode = |path: &Path| {
        std::fs::metadata(path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777
    };
    assert_eq!(mode(&directory), 0o700);
    assert_eq!(mode(&directory.join("client.json")), 0o600);
    assert_eq!(
        config::load(&directory.join("client.json"))
            .expect("load")
            .memory_budget_mb,
        96
    );
}

#[test]
fn trust_selection_uses_pin_then_certificate_then_explicit_tofu() {
    let dir = tempfile::tempdir().expect("home");
    let supplied = dir.path().join("supplied.pem");
    std::fs::write(&supplied, "supplied").expect("certificate");
    let options = JoinOptions {
        host_cert: Some(supplied),
        host_pin: Some("ab".repeat(32)),
        ..join_options("127.0.0.1")
    };
    assert!(
        matches!(config::trust(&options, dir.path()), Ok(HostTrust::Pin(pin)) if pin == [0xab; 32])
    );
    let options = JoinOptions {
        host_pin: None,
        ..options
    };
    assert!(
        matches!(config::trust(&options, dir.path()), Ok(HostTrust::CertPem(pem)) if pem == b"supplied")
    );
    let options = JoinOptions {
        host_cert: None,
        ..options
    };
    assert!(matches!(
        config::trust(&options, dir.path()),
        Err(config::ConfigError::PinRequired)
    ));
    let options = JoinOptions {
        trust_on_first_use: true,
        ..options
    };
    assert!(matches!(
        config::trust(&options, dir.path()),
        Ok(HostTrust::TrustOnFirstUse)
    ));
    std::fs::create_dir(dir.path().join("tls")).expect("tls directory");
    std::fs::write(dir.path().join("tls/host-cert.pem"), "certificate").expect("certificate");
    assert!(
        matches!(config::trust(&options, dir.path()), Ok(HostTrust::CertPem(pem)) if pem == b"certificate")
    );
    assert!(matches!(
        config::parse_pin("not a pin"),
        Err(config::ConfigError::InvalidPin)
    ));
    assert!(matches!(
        config::parse_pin("abcd"),
        Err(config::ConfigError::InvalidPin)
    ));
}

#[test]
fn host_addresses_split_ports_and_resolve_directly() {
    assert_eq!(config::resolve_host("127.0.0.1").expect("ip"), "127.0.0.1");
    assert_eq!(config::resolve_host("::1").expect("IPv6"), "::1");
    assert_eq!(
        config::resolve_host("host.example").expect("dns"),
        "host.example"
    );
    assert_eq!(config::split_port("::1"), ("::1", None));
    assert_eq!(config::split_port("[::1]:9"), ("::1", Some("9")));
    assert_eq!(
        config::split_port("host.example:9"),
        ("host.example", Some("9"))
    );
    assert_eq!(config::split_port("host.example"), ("host.example", None));
    assert_eq!(config::endpoint("::1"), ("[::1]:7643".into(), "::1".into()));
    assert_eq!(
        config::endpoint("10.0.0.1:9"),
        ("10.0.0.1:9".into(), "10.0.0.1".into())
    );
    assert_eq!(config::resolve_address("[::1]:9").expect("v6"), "[::1]:9");
    assert_eq!(
        config::resolve_address("host.example").expect("bare"),
        "host.example"
    );
    assert_eq!(config::slug("My-Mac.local"), "my-mac-local");
    assert!(!config::hostname().is_empty());
}

#[test]
fn tailnet_names_resolve_through_status_json() {
    let status = br#"{"Peer":{"id":{"HostName":"laptop","DNSName":"desk.tailnet.example.","TailscaleIPs":["100.1.2.3"]}}}"#;
    assert_eq!(
        config::resolve_peer("laptop", status).expect("host"),
        "100.1.2.3"
    );
    assert_eq!(
        config::resolve_peer("desk", status).expect("label"),
        "100.1.2.3"
    );
    assert_eq!(
        config::resolve_peer("other", status)
            .expect_err("unknown peer")
            .to_string(),
        "host_unresolved"
    );
    assert!(config::resolve_peer("laptop", b"not json").is_err());
    let dir = tempfile::tempdir().expect("bin");
    let binary = dir.path().join("tailscale");
    let script = format!(
        "#!/bin/sh\n[ \"$1 $2\" = \"status --json\" ] && printf '%s' '{}'\n",
        std::str::from_utf8(status).expect("utf-8")
    );
    std::fs::write(&binary, script).expect("script");
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).expect("mode");
    assert_eq!(
        config::resolve_with("laptop", dir.path().as_os_str()).expect("resolved"),
        "100.1.2.3"
    );
    std::fs::write(&binary, "#!/bin/sh\nexit 1\n").expect("failing script");
    assert!(matches!(
        config::resolve_with("laptop", dir.path().as_os_str()),
        Err(config::ConfigError::HostUnresolved)
    ));
}

#[test]
fn exports_must_be_unique_named_absolute_paths() {
    let parsed = config::parse_exports(&["notes=/tmp".into(), "a_1-b=/srv".into()]).expect("valid");
    assert_eq!(
        parsed
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["notes", "a_1-b"]
    );
    for invalid in [
        "noequals",
        "=/tmp",
        "Upper=/tmp",
        "1st=/tmp",
        "bad name=/tmp",
        "rel=tmp",
        "up=/tmp/../etc",
        "nul=/tmp\0x",
    ] {
        assert!(
            config::parse_exports(&[invalid.into()]).is_err(),
            "{invalid}"
        );
    }
    assert!(config::parse_exports(&[format!("{}=/tmp", "a".repeat(65))]).is_err());
    assert!(config::parse_exports(&["a=/tmp".into(), "a=/srv".into()]).is_err());
}

#[test]
fn metrics_keep_last_thousand_json_lines() {
    let dir = tempfile::tempdir().expect("directory");
    let path = dir.path().join("metrics.jsonl");
    for at in 0..1002 {
        append_metrics(
            &path,
            &Metrics {
                at,
                rss_bytes: 10,
                in_flight: 2,
                retained_pty_bytes: 3,
                transfers: 4,
            },
        )
        .expect("append");
    }
    let lines = std::fs::read_to_string(&path).expect("metrics");
    assert_eq!(lines.lines().count(), 1000);
    let mode = std::fs::metadata(&path)
        .expect("metadata")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    assert_eq!(
        serde_json::from_str::<Value>(lines.lines().next().expect("first")).expect("json")["at"],
        2
    );
    assert!(append_metrics(
        dir.path(),
        &Metrics {
            at: 0,
            rss_bytes: 0,
            in_flight: 0,
            retained_pty_bytes: 0,
            transfers: 0,
        }
    )
    .is_err());
    let value = serde_json::to_value(Load {
        load_avg1: 1.5,
        memory_available_bytes: 300,
        in_flight: 2,
    })
    .expect("report");
    assert_eq!(
        value,
        json!({"loadAvg1":1.5,"memoryAvailableBytes":300,"inFlight":2})
    );
}

#[tokio::test]
async fn join_unix_records_no_pin_and_clears_saved_generation() {
    let home = tempfile::tempdir().expect("home");
    let directory = home.path().join("machine-client");
    std::fs::create_dir_all(&directory).expect("directory");
    std::fs::write(directory.join("state.json"), r#"{"generation":3}"#).expect("state");
    let options = JoinOptions {
        unix: Some("/tmp/oni.sock".into()),
        exports: vec!["notes=/tmp".into()],
        ..join_options("localhost")
    };
    let enrollment = attach::join(&options, home.path(), &["fs.read"])
        .await
        .expect("join");
    assert_eq!(enrollment.notice(), "");
    assert_eq!(enrollment.receipt["machineId"], "work-mac");
    assert_eq!(
        enrollment.receipt["allowedCapabilities"],
        json!(["fs.read"])
    );
    assert_eq!(enrollment.receipt["allowedExports"], json!(["notes"]));
    assert!(!directory.join("state.json").exists());
    assert!(!directory.join("host-pin").exists());
    std::fs::create_dir(directory.join("state.json")).expect("blocking directory");
    assert!(matches!(
        attach::join(&options, home.path(), &[]).await,
        Err(AttachError::Io(_))
    ));
    assert!(matches!(
        attach::join(&join_options("127.0.0.1"), home.path(), &[]).await,
        Err(AttachError::Config(config::ConfigError::PinRequired))
    ));
}

#[tokio::test]
async fn trust_on_first_use_join_records_observed_pin() {
    let host = FakeHost::tls().await;
    let home = tempfile::tempdir().expect("home");
    let options = JoinOptions {
        trust_on_first_use: true,
        ..join_options(&host.endpoint)
    };
    let enrollment = attach::join(&options, home.path(), &[])
        .await
        .expect("join");
    let expected = hex::encode(host_pin(&host.certificate));
    assert_eq!(
        enrollment.notice(),
        format!("{}\n", json!({"hostPin": expected}))
    );
    assert_eq!(
        std::fs::read_to_string(home.path().join("machine-client/host-pin")).expect("pin"),
        expected
    );
}

#[tokio::test]
async fn pinned_join_records_pin_without_first_use_notice() {
    let host = FakeHost::tls().await;
    let home = tempfile::tempdir().expect("home");
    let options = JoinOptions {
        host_pin: Some(hex::encode(host_pin(&host.certificate))),
        ..join_options(&host.endpoint)
    };
    let enrollment = attach::join(&options, home.path(), &[])
        .await
        .expect("join");
    assert_eq!(enrollment.notice(), "");
    assert!(home.path().join("machine-client/host-pin").exists());
}

#[tokio::test]
async fn pin_mismatch_join_is_refused_as_terminal() {
    let host = FakeHost::tls().await;
    let home = tempfile::tempdir().expect("home");
    let options = JoinOptions {
        host_pin: Some("00".repeat(32)),
        ..join_options(&host.endpoint)
    };
    let error = attach::join(&options, home.path(), &[])
        .await
        .expect_err("join failure");
    assert_eq!(
        (error.exit_code(), error.reason().as_str()),
        (3, "peer_key_mismatch")
    );
}

async fn tls_client(host: &FakeHost, pin: [u8; 32]) -> (tempfile::TempDir, ClientConfig) {
    let directory = tempfile::tempdir().expect("client directory");
    let mut settings = config();
    settings.host = host.endpoint.clone();
    std::fs::write(directory.path().join("client-cert.pem"), &host.certificate).expect("cert");
    std::fs::write(directory.path().join("client-key.pem"), &host.private_key).expect("key");
    std::fs::write(directory.path().join("host-pin"), hex::encode(pin)).expect("pin");
    (directory, settings)
}

#[tokio::test]
async fn tls_attach_uses_recorded_pin_and_refuses_mismatch() {
    for host in [FakeHost::tls().await, FakeHost::tls12().await] {
        let mut host = host;
        let (directory, settings) = tls_client(&host, host_pin(&host.certificate)).await;
        let hooks = hooks(Arc::new(NoRetention));
        let probe = FixedProbe::new(0);
        let capabilities = ["fs.read".to_owned()];
        let mut attachment =
            Attachment::new(&settings, directory.path(), &capabilities, &hooks, &probe)
                .expect("new");
        let exchange = async {
            let request = expect(&mut host, "machine.attach").await;
            host.send(attached(&request, 23)).await;
            let report = expect(&mut host, "machine.report").await;
            host.send(reply(
                &report,
                json!({"status":"refused","reason":"machine_not_attached"}),
            ))
            .await;
        };
        let (outcome, ()) = tokio::join!(attachment.once(), exchange);
        assert_eq!(outcome.expect("attached over TLS"), Outcome::Ended);
    }
    let host = FakeHost::tls().await;
    let (directory, settings) = tls_client(&host, [7; 32]).await;
    let hooks = hooks(Arc::new(NoRetention));
    let capabilities = [];
    let probe = FixedProbe::new(0);
    let mut attachment =
        Attachment::new(&settings, directory.path(), &capabilities, &hooks, &probe).expect("new");
    assert!(matches!(
        attachment.once().await,
        Err(AttachError::Transport(TransportError::HostKeyMismatch))
    ));
    std::fs::remove_file(directory.path().join("host-pin")).expect("remove pin");
    assert!(matches!(attachment.once().await, Err(AttachError::Io(_))));
}

#[tokio::test]
async fn unix_attach_saves_generation_heartbeats_and_offers_it_on_reconnect() {
    let mut host = FakeHost::unix().await;
    let directory = tempfile::tempdir().expect("client directory");
    let settings = unix_settings(&host, directory.path()).await;
    let pressure = Arc::new(CountingPressure::default());
    let hooks = hooks(pressure.clone());
    let probe = FixedProbe::new(1024);
    let capabilities = ["fs.read".to_owned()];
    let mut attachment =
        Attachment::new(&settings, directory.path(), &capabilities, &hooks, &probe).expect("new");
    let exchange = async move {
        let request = expect(&mut host, "machine.attach").await;
        assert_eq!(request["params"]["offeredCapabilities"], json!(["fs.read"]));
        assert_eq!(request["params"]["resources"]["memoryBytes"], 4096);
        assert!(
            request["params"]
                .as_object()
                .is_some_and(|params| !params.contains_key("generation")),
            "a first attach must omit the generation key: {request}"
        );
        host.send(attached(&request, 17)).await;
        for _ in 0..3 {
            let report = expect(&mut host, "machine.report").await;
            assert_eq!(
                report["params"]["load"],
                json!({"loadAvg1":0.5,"memoryAvailableBytes":1024,"inFlight":0})
            );
            host.send(reply(&report, json!({"status":"accepted"})))
                .await;
        }
        let report = expect(&mut host, "machine.report").await;
        host.send(json!({"v":2,"type":"response","id":report["id"],"error":{"code":-32000,"message":"busy"}}))
            .await;
        expect(&mut host, "machine.report").await;
        host
    };
    let (outcome, host) = tokio::select! {
        outcome = attachment.once() => panic!("ended early: {outcome:?}"),
        host = exchange => (None::<Outcome>, host),
    };
    assert!(outcome.is_none());
    let state: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("state.json")).expect("state"))
            .expect("json");
    assert_eq!(state["generation"], 17);
    let metrics = std::fs::read_to_string(directory.path().join("metrics.jsonl")).expect("metrics");
    let first: Value = serde_json::from_str(metrics.lines().next().expect("line")).expect("json");
    assert_eq!(
        (
            first["retainedPtyBytes"].as_u64(),
            first["transfers"].as_u64()
        ),
        (Some(77), Some(2))
    );
    assert_eq!(pressure.sheds.load(Ordering::Relaxed), 0);
    drop(host);
    assert_eq!(
        attachment.once().await.expect("unreachable"),
        Outcome::Unreachable
    );

    let mut reconnect = FakeHost::unix().await;
    let settings = unix_settings(&reconnect, directory.path()).await;
    let mut attachment =
        Attachment::new(&settings, directory.path(), &capabilities, &hooks, &probe).expect("new");
    let exchange = async {
        let offer = expect(&mut reconnect, "machine.attach").await;
        assert_eq!(offer["params"]["generation"], 17);
        reconnect.send(attached(&offer, 18)).await;
        expect(&mut reconnect, "machine.report").await;
        drop(reconnect);
    };
    let (outcome, ()) = tokio::join!(attachment.once(), exchange);
    assert_eq!(outcome.expect("closed"), Outcome::Ended);
}

#[tokio::test]
async fn cancelled_inbound_work_is_not_counted_after_reconnect() {
    let mut host = FakeHost::unix().await;
    let directory = tempfile::tempdir().expect("client directory");
    let settings = unix_settings(&host, directory.path()).await;
    let (dropped, cancelled) = tokio::sync::oneshot::channel::<()>();
    let dropped = Arc::new(std::sync::Mutex::new(Some(dropped)));
    let mut hooks = hooks(Arc::new(NoRetention));
    hooks.service = handler(move |_, _| {
        let held = dropped.lock().expect("lock").take();
        async move {
            let _held = held;
            std::future::pending::<Result<Value, String>>().await
        }
    });
    let probe = FixedProbe::new(0);
    let mut attachment =
        Attachment::new(&settings, directory.path(), &[], &hooks, &probe).expect("new");
    let exchange = async move {
        let request = expect(&mut host, "machine.attach").await;
        host.send(attached(&request, 1)).await;
        host.send(json!({"v":2,"type":"request","id":"p1","method":"machine.exec","params":{}}))
            .await;
        loop {
            let report = expect(&mut host, "machine.report").await;
            host.send(reply(&report, json!({"status":"accepted"})))
                .await;
            if report["params"]["load"]["inFlight"] == 1 {
                break;
            }
        }
        host.reopen().await
    };
    let (outcome, mut host) = tokio::join!(attachment.once(), exchange);
    assert_eq!(outcome.expect("closed"), Outcome::Ended);
    assert!(cancelled.await.is_err(), "pending service future dropped");
    let exchange = async move {
        let request = expect(&mut host, "machine.attach").await;
        assert_eq!(request["params"]["generation"], 1);
        host.send(attached(&request, 1)).await;
        let report = expect(&mut host, "machine.report").await;
        drop(host);
        report
    };
    let (outcome, report) = tokio::join!(attachment.once(), exchange);
    assert_eq!(outcome.expect("closed"), Outcome::Ended);
    assert_eq!(report["params"]["load"]["inFlight"], 0);
}

#[tokio::test]
async fn attach_refusals_retry_or_stop_by_reason() {
    let mut host = FakeHost::unix().await;
    let directory = tempfile::tempdir().expect("client directory");
    let settings = unix_settings(&host, directory.path()).await;
    let hooks = hooks(Arc::new(NoRetention));
    let probe = FixedProbe::new(0);
    let mut attachment =
        Attachment::new(&settings, directory.path(), &[], &hooks, &probe).expect("new");
    let exchange = async {
        let request = expect(&mut host, "machine.attach").await;
        host.send(reply(
            &request,
            json!({"status":"refused","reason":"machine_not_enrolled"}),
        ))
        .await;
    };
    let (outcome, ()) = tokio::join!(attachment.once(), exchange);
    assert_eq!(outcome.expect("retrying"), Outcome::Refused);

    let mut host = host.reopen().await;
    let exchange = async {
        let request = expect(&mut host, "machine.attach").await;
        host.send(json!({"v":2,"type":"response","id":request["id"],"error":{"code":-32000,"message":"down"}}))
            .await;
    };
    let (outcome, ()) = tokio::join!(attachment.once(), exchange);
    assert_eq!(outcome.expect("retrying"), Outcome::Refused);

    let mut host = host.reopen().await;
    let exchange = async {
        let request = expect(&mut host, "machine.attach").await;
        host.send(reply(
            &request,
            json!({"status":"refused","reason":"stale_generation"}),
        ))
        .await;
    };
    let (outcome, ()) = tokio::join!(attachment.once(), exchange);
    assert!(matches!(outcome, Err(AttachError::Terminal(reason)) if reason == "stale_generation"));

    std::fs::create_dir(directory.path().join("state.json")).expect("blocking directory");
    assert!(matches!(
        Attachment::new(&settings, directory.path(), &[], &hooks, &probe),
        Err(AttachError::Io(_))
    ));
}

#[tokio::test]
async fn run_loop_reconnects_after_a_retrying_refusal() {
    let mut host = FakeHost::unix().await;
    let directory = tempfile::tempdir().expect("client directory");
    let settings = unix_settings(&host, directory.path()).await;
    let hooks = hooks(Arc::new(NoRetention));
    let probe = FixedProbe::new(0);
    let run = run_with_probe(&settings, directory.path(), &[], &hooks, &probe);
    let exchange = async {
        let request = expect(&mut host, "machine.attach").await;
        host.send(reply(
            &request,
            json!({"status":"refused","reason":"machine_not_enrolled"}),
        ))
        .await;
        let mut host = host.reopen().await;
        let request = expect(&mut host, "machine.attach").await;
        host.send(attached(&request, 5)).await;
        expect(&mut host, "machine.report").await;
        let mut host = host.reopen().await;
        let request = expect(&mut host, "machine.attach").await;
        host.send(reply(
            &request,
            json!({"status":"refused","reason":"stale_generation"}),
        ))
        .await;
        request
    };
    let (stopped, offer) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(run, exchange)
    })
    .await
    .expect("reconnect ends on terminal refusal");
    assert_eq!(offer["params"]["generation"], 5);
    assert!(matches!(stopped, Err(AttachError::Terminal(reason)) if reason == "stale_generation"));
}

#[tokio::test]
async fn memory_pressure_sheds_gates_new_work_and_exits_on_third_sample() {
    let mut host = FakeHost::unix().await;
    let directory = tempfile::tempdir().expect("client directory");
    let mut settings = unix_settings(&host, directory.path()).await;
    settings.memory_budget_mb = 1;
    let pressure = Arc::new(CountingPressure::default());
    let hooks = hooks(pressure.clone());
    let probe = FixedProbe::new(2 * 1024 * 1024);
    let mut attachment =
        Attachment::new(&settings, directory.path(), &[], &hooks, &probe).expect("new");
    let observed = pressure.clone();
    let exchange = async move {
        let request = expect(&mut host, "machine.attach").await;
        host.send(attached(&request, 1)).await;
        let report = expect(&mut host, "machine.report").await;
        assert_eq!(observed.sheds.load(Ordering::Relaxed), 1);
        let calls = [
            ("x1", "machine.exec", json!({})),
            ("x2", "machine.fs_stream", json!({"op":"begin"})),
            ("x3", "machine.fs_stream", json!({"op":"chunk"})),
        ];
        for (id, method, params) in &calls {
            host.send(json!({"v":2,"type":"request","id":id,"method":method,"params":params}))
                .await;
        }
        let mut answers = std::collections::HashMap::new();
        while answers.len() < calls.len() {
            let frame = host.incoming.recv().await.expect("answer");
            answers.insert(
                frame["id"].as_str().expect("id").to_owned(),
                frame["result"].clone(),
            );
        }
        assert_eq!(answers["x1"]["reason"], "exec_not_available");
        assert_eq!(answers["x2"]["reason"], "too_large");
        assert_eq!(answers["x3"], json!({"served":"machine.fs_stream"}));
        host.send(reply(&report, json!({"status":"accepted"})))
            .await;
        let report = expect(&mut host, "machine.report").await;
        host.send(reply(&report, json!({"status":"accepted"})))
            .await;
        host
    };
    let (outcome, _host) = tokio::join!(attachment.once(), exchange);
    assert!(matches!(outcome, Err(AttachError::MemoryBudget)));
    assert_eq!(pressure.sheds.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn unwritable_generation_and_metrics_stop_the_attachment() {
    let mut host = FakeHost::unix().await;
    let directory = tempfile::tempdir().expect("client directory");
    let settings = unix_settings(&host, directory.path()).await;
    let hooks = hooks(Arc::new(NoRetention));
    let probe = FixedProbe::new(0);
    let mut attachment =
        Attachment::new(&settings, directory.path(), &[], &hooks, &probe).expect("new");
    std::fs::create_dir(directory.path().join("state.json")).expect("blocking state");
    let exchange = async {
        let request = expect(&mut host, "machine.attach").await;
        host.send(attached(&request, 2)).await;
    };
    let (outcome, ()) = tokio::join!(attachment.once(), exchange);
    assert!(matches!(outcome, Err(AttachError::Io(_))));

    std::fs::remove_dir(directory.path().join("state.json")).expect("unblock state");
    std::fs::create_dir(directory.path().join("metrics.jsonl")).expect("blocking metrics");
    let mut host = host.reopen().await;
    let exchange = async {
        let request = expect(&mut host, "machine.attach").await;
        host.send(attached(&request, 3)).await;
    };
    let (outcome, ()) = tokio::join!(attachment.once(), exchange);
    assert!(matches!(outcome, Err(AttachError::Io(_))));
}

#[test]
fn identity_refuses_an_unwritable_key_path() {
    let directory = tempfile::tempdir().expect("directory");
    std::fs::create_dir(directory.path().join("client-key.pem")).expect("blocking key");
    assert!(matches!(
        config::identity(directory.path(), "laptop"),
        Err(config::ConfigError::Io(_))
    ));
}

#[test]
fn malformed_attach_result_and_saved_generation_are_typed_errors() {
    assert!(matches!(
        result(json!({"status": "unknown"})),
        Err(AttachError::Decode(_))
    ));
    let directory = tempfile::tempdir().expect("client directory");
    let settings = config();
    let hooks = hooks(Arc::new(NoRetention));
    let probe = FixedProbe::new(0);
    for state in ["{", r#"{"generation":0}"#] {
        std::fs::write(directory.path().join("state.json"), state).expect("corrupt state");
        assert!(matches!(
            Attachment::new(&settings, directory.path(), &[], &hooks, &probe),
            Err(AttachError::Json(_))
        ));
    }
}

#[tokio::test]
async fn malformed_host_attach_reply_never_saves_a_generation() {
    let mut host = FakeHost::unix().await;
    let directory = tempfile::tempdir().expect("client directory");
    let settings = unix_settings(&host, directory.path()).await;
    let hooks = hooks(Arc::new(NoRetention));
    let probe = FixedProbe::new(0);
    let mut attachment =
        Attachment::new(&settings, directory.path(), &[], &hooks, &probe).expect("new");
    let exchange = async {
        let request = expect(&mut host, "machine.attach").await;
        host.send(attached(&request, 0)).await;
    };

    let (outcome, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(attachment.once(), exchange)
    })
    .await
    .expect("malformed reply handled");

    assert_eq!(outcome.expect("retrying"), Outcome::Refused);
    assert!(!directory.path().join("state.json").exists());
    assert!(!directory.path().join("metrics.jsonl").exists());
}

#[tokio::test]
async fn tls_attach_without_client_identity_files_is_an_io_error() {
    let host = FakeHost::tls().await;
    let (directory, settings) = tls_client(&host, host_pin(&host.certificate)).await;
    let hooks = hooks(Arc::new(NoRetention));
    let probe = FixedProbe::new(0);
    let mut attachment =
        Attachment::new(&settings, directory.path(), &[], &hooks, &probe).expect("new");
    for file in ["client-cert.pem", "client-key.pem"] {
        let path = directory.path().join(file);
        let contents = std::fs::read(&path).expect("identity file");
        std::fs::remove_file(&path).expect("remove identity file");
        assert!(matches!(
            attachment.once().await,
            Err(AttachError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound
        ));
        std::fs::write(&path, contents).expect("restore identity file");
    }
}

#[tokio::test]
async fn join_refuses_an_unwritable_host_pin() {
    let host = FakeHost::tls().await;
    let home = tempfile::tempdir().expect("home");
    std::fs::create_dir_all(home.path().join("machine-client/host-pin")).expect("blocking pin");
    let options = JoinOptions {
        trust_on_first_use: true,
        ..join_options(&host.endpoint)
    };
    assert!(matches!(
        attach::join(&options, home.path(), &[]).await,
        Err(AttachError::Io(_))
    ));
}

#[tokio::test]
async fn join_reports_permission_denied_when_host_pin_directory_is_read_only() {
    let host = FakeHost::tls().await;
    let home = tempfile::tempdir().expect("home");
    let directory = home.path().join("machine-client");
    let pins = home.path().join("pins");
    std::fs::create_dir(&directory).expect("client directory");
    std::fs::create_dir(&pins).expect("pin directory");
    std::os::unix::fs::symlink(pins.join("host-pin"), directory.join("host-pin"))
        .expect("pin symlink");
    std::fs::set_permissions(&pins, std::fs::Permissions::from_mode(0o500))
        .expect("read-only directory");
    let options = JoinOptions {
        trust_on_first_use: true,
        ..join_options(&host.endpoint)
    };

    let outcome = tokio::time::timeout(
        Duration::from_secs(5),
        attach::join(&options, home.path(), &[]),
    )
    .await;
    std::fs::set_permissions(&pins, std::fs::Permissions::from_mode(0o700))
        .expect("restore directory permissions");

    assert!(matches!(
        outcome.expect("join completed"),
        Err(AttachError::Io(error)) if error.kind() == std::io::ErrorKind::PermissionDenied
    ));
    assert!(!pins.join("host-pin").exists());
}

fn exported(host: &FakeHost, root: &Path, directory: &Path) -> ClientConfig {
    let mut settings = config();
    settings.exports = vec![Export {
        name: "notes".into(),
        path: root.to_str().expect("utf8 root").into(),
    }];
    settings.unix = Some(host.endpoint.clone().into());
    config::save(&settings, directory).expect("save");
    settings
}

#[tokio::test]
async fn attach_grant_reaches_handlers_and_detach_revokes_it() {
    let mut host = FakeHost::unix().await;
    let directory = tempfile::tempdir().expect("client directory");
    let root = tempfile::tempdir().expect("export root");
    std::fs::write(root.path().join("one"), b"hello").expect("seed");
    let settings = exported(&host, root.path(), directory.path());
    let pty = Pty::new("/definitely/missing/tmux", None, "g".into()).await;
    let service = Service::open(&settings, pty).expect("service");
    let hooks = service.hooks(Duration::from_secs(60));
    let probe = FixedProbe::new(0);
    let mut attachment = Attachment::new(
        &settings,
        directory.path(),
        service.capabilities(),
        &hooks,
        &probe,
    )
    .expect("attachment");
    let read = json!({"op":"read","export":"notes","path":"one"});
    let params = read.clone();
    let exchange = async move {
        let request = expect(&mut host, "machine.attach").await;
        assert_eq!(
            request["params"]["offeredCapabilities"],
            json!(["fs.read", "fs.write", "shell.exec"])
        );
        host.send(reply(
            &request,
            json!({
                "status":"attached","effectiveCapabilities":["fs.read"],
                "effectiveExports":["notes"],"generation":3
            }),
        ))
        .await;
        host.send(
            json!({"v":2,"type":"request","id":"h1","method":"machine.fs_op","params":params}),
        )
        .await;
        loop {
            let frame = host.incoming.recv().await.expect("frame");
            if frame["id"] == "h1" {
                assert_eq!(frame["result"]["status"], "completed", "{frame}");
                break;
            }
            host.send(reply(&frame, json!({"status":"accepted"}))).await;
        }
    };
    let (outcome, ()) = tokio::join!(attachment.once(), exchange);
    assert_eq!(outcome.expect("ended"), Outcome::Ended);
    let answer = (hooks.service)("machine.fs_op".into(), Some(read)).await;
    assert_eq!(answer.expect("refusal")["reason"], "fs_not_available");
}

#[tokio::test]
async fn run_default_offers_the_available_capabilities_of_its_config() {
    let mut host = FakeHost::unix().await;
    let directory = tempfile::tempdir().expect("client directory");
    let root = tempfile::tempdir().expect("export root");
    exported(&host, root.path(), directory.path());
    let path = directory.path().join("client.json");
    let exchange = async move {
        let request = expect(&mut host, "machine.attach").await;
        let offered = request["params"]["offeredCapabilities"].clone();
        host.send(reply(
            &request,
            json!({"status":"refused","reason":"unsupported_contract"}),
        ))
        .await;
        offered
    };
    let (outcome, offered) = tokio::join!(attach::run_default(Some(&path)), exchange);
    assert!(
        matches!(outcome, Err(AttachError::Terminal(_))),
        "{outcome:?}"
    );
    let tmux = Pty::new("tmux", None, "g".into()).await.offered();
    assert_eq!(offered, json!(available(true, tmux)));

    std::fs::remove_dir(root.path()).expect("remove export");
    let missing = attach::run_default(Some(&path)).await;
    assert!(matches!(missing, Err(AttachError::Io(_))), "{missing:?}");
    let absent = attach::run_default(Some(&directory.path().join("absent.json"))).await;
    assert!(matches!(absent, Err(AttachError::Config(_))), "{absent:?}");
}
