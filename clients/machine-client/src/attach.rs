use std::{
    convert::Infallible,
    fs,
    hash::{BuildHasher, Hasher},
    io,
    num::{NonZeroU64, NonZeroUsize},
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use oni_protocol::{AttachResult, ReportResult};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{JoinError, JoinSet};

#[cfg(target_os = "macos")]
use crate::grant_restart::{Decision as GrantDecision, GrantRestart};
use crate::{
    agent::{hook, launcher::HookTarget},
    budget::{self, Budget, BudgetAction, Metrics, Pressure},
    config::{self, ClientConfig, JoinOptions},
    handlers::{AgentOptions, Service},
    input::watch::{InputProducer, InputWatch, Source},
    pty::ops::Pty,
    report::{self, Probe},
    transport::{
        classes::{self, FailureClass},
        client::{handler, Caller, Client, Handler, TransportError},
        connection::HostTrust,
        events,
        request_table::CallError,
        retry::{Event, Next, Random, Retry},
    },
};

pub const HEARTBEAT: Duration = Duration::from_secs(5);
const AGENT_READY: Duration = Duration::from_secs(30);
const AGENT_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum AttachError {
    #[error("transport: {0}")]
    Transport(#[from] TransportError),
    #[error(transparent)]
    Config(#[from] config::ConfigError),
    #[error("I/O: {0}")]
    Io(#[from] io::Error),
    #[error("invalid host reply: {0}")]
    Decode(#[from] oni_protocol::DecodeError),
    #[error("invalid saved generation: {0}")]
    Json(#[from] serde_json::Error),
    #[error("call: {0}")]
    Call(#[from] CallError),
    #[error("{0}")]
    Terminal(String),
    #[error("memory budget exceeded")]
    MemoryBudget,
    #[error("screen grant observed, restarting for it to apply")]
    GrantRestart,
    #[error(transparent)]
    Computer(#[from] crate::computer::ComputerError),
    #[error(transparent)]
    Update(#[from] crate::release::UpdateError),
    #[error("service_unavailable")]
    ServiceUnavailable,
    #[error("attachment event channel closed")]
    EventsClosed,
    #[error("attach failed: {0:?}")]
    Once(FailureClass),
}

impl AttachError {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Terminal(_)
            | Self::Transport(TransportError::HostKeyMismatch)
            | Self::Once(
                FailureClass::Authentication
                | FailureClass::Configuration
                | FailureClass::Superseded,
            ) => 3,
            Self::MemoryBudget => 4,
            Self::GrantRestart => 75,
            _ => 2,
        }
    }

    pub fn reason(&self) -> String {
        match self {
            Self::Transport(TransportError::HostKeyMismatch) => "peer_key_mismatch".to_owned(),
            Self::Update(crate::release::UpdateError::Unpinned { .. }) => {
                "unpinned_binary".to_owned()
            }
            Self::Update(_) => "update_failed".to_owned(),
            Self::Once(class) => class.as_str().to_owned(),
            _ => self.to_string(),
        }
    }
}

#[derive(Debug)]
pub struct Negotiated {
    pub generation: NonZeroU64,
    pub capabilities: Vec<String>,
    pub exports: Vec<String>,
}

/// Told the host's grant when an attach succeeds, and when its connection ends.
pub trait Session: Send + Sync {
    /// Handed a caller onto the admitted connection just before `attached`.
    fn connected(&self, _caller: Caller) {}
    fn attached(&self, negotiated: &Negotiated);
    fn detached(&self);
    /// Handed the client-to-host uplink of each connection before its attach.
    fn uplink(&self, _uplink: Uplink) {}
}

struct AttachedSession<'a>(&'a dyn Session);

impl Drop for AttachedSession<'_> {
    fn drop(&mut self) {
        self.0.detached();
    }
}

pub struct Hooks {
    pub service: Handler,
    pub pressure: Arc<dyn Pressure>,
    pub session: Arc<dyn Session>,
    pub screen: Arc<crate::screen::Screen>,
    pub input: Arc<crate::input::Input>,
    pub heartbeat: Duration,
}

#[derive(Debug)]
pub struct Enrollment {
    pub receipt: Value,
    pub first_use_pin: Option<String>,
}

impl Enrollment {
    pub fn notice(&self) -> String {
        self.first_use_pin
            .as_ref()
            .map_or_else(String::new, |pin| format!("{}\n", json!({"hostPin": pin})))
    }
}

#[derive(Deserialize)]
struct SavedGeneration {
    generation: Option<NonZeroU64>,
    pid: Option<u32>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

pub fn offer(
    config: &ClientConfig,
    capabilities: &[String],
    generation: Option<NonZeroU64>,
    at: u64,
    cpus: usize,
    memory_bytes: u64,
) -> Value {
    let mut offered = json!({
        "machineId": config.machine_id,
        "offeredCapabilities": capabilities,
        "resources": {"cpus": cpus, "memoryBytes": memory_bytes},
        "exports": config.exports,
        "daemonVersion": env!("CARGO_PKG_VERSION"),
        "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        "offeredAt": at,
        "peer": {"kind":"client","contractVersion":oni_protocol::CONTRACT_VERSION},
        "capabilities": ["ping"]
    });
    // The Offer schema allows `generation` to be absent, never `null`: a first
    // attach must omit the key or the host refuses the frame as invalid params.
    if let Some(generation) = generation {
        offered["generation"] = json!(generation);
    }
    offered
}

pub fn result(value: Value) -> Result<Negotiated, AttachError> {
    match oni_protocol::decode::<AttachResult>(value)? {
        AttachResult::Attached {
            generation,
            effective_capabilities,
            effective_exports,
        } => Ok(Negotiated {
            generation,
            capabilities: effective_capabilities
                .into_iter()
                .map(String::from)
                .collect(),
            exports: effective_exports.into_iter().map(String::from).collect(),
        }),
        AttachResult::Refused { reason } => {
            let name = reason.to_string();
            if matches!(
                name.as_str(),
                "stale_generation" | "unsupported_contract" | "peer_key_mismatch"
            ) {
                Err(AttachError::Terminal(name))
            } else {
                Err(AttachError::Call(CallError::Remote(name)))
            }
        }
    }
}

fn read_generation(directory: &Path) -> Result<Option<NonZeroU64>, AttachError> {
    match fs::read(directory.join("state.json")) {
        Ok(data) => Ok(serde_json::from_slice::<SavedGeneration>(&data)?.generation),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn save_generation(directory: &Path, generation: NonZeroU64) -> io::Result<()> {
    let state =
        json!({ "generation": generation, "pid": service_pid(directory).map_err(io::Error::other)? })
            .to_string();
    config::write_private(&directory.join("state.json"), state.as_bytes())
}

pub fn service_pid(directory: &Path) -> Result<Option<u32>, AttachError> {
    match fs::read(directory.join("state.json")) {
        Ok(data) => Ok(serde_json::from_slice::<SavedGeneration>(&data)?.pid),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn save_service_pid(directory: &Path, pid: Option<u32>) -> Result<(), AttachError> {
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let state = json!({ "generation": read_generation(directory)?, "pid": pid }).to_string();
    config::write_private(&directory.join("state.json"), state.as_bytes())?;
    Ok(())
}

fn clear_generation(directory: &Path) -> io::Result<()> {
    match fs::remove_file(directory.join("state.json")) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

struct RuntimeRandom;

impl Random for RuntimeRandom {
    fn upper_half(&mut self, ceiling: u64) -> u64 {
        let random = std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish();
        ceiling / 2 + random % (ceiling - ceiling / 2 + 1)
    }
}

fn refuse_inbound() -> Handler {
    handler(|_, _| async { Err("machine_not_attached".to_owned()) })
}

async fn connect_tls(
    host: &str,
    directory: &Path,
    trust: HostTrust,
    service: Handler,
) -> Result<Result<(Client, [u8; 32]), TransportError>, io::Error> {
    let cert = fs::read(directory.join("client-cert.pem"))?;
    let key = fs::read(directory.join("client-key.pem"))?;
    let (address, name) = config::endpoint(host);
    Ok(Client::connect_tls(&address, &name, trust, &cert, &key, service).await)
}

async fn record_pin(
    host: &str,
    directory: &Path,
    trust: HostTrust,
) -> Result<Option<String>, AttachError> {
    let first_use = matches!(trust, HostTrust::TrustOnFirstUse);
    let (connection, pin) = connect_tls(host, directory, trust, refuse_inbound()).await??;
    drop(connection);
    let pin = hex::encode(pin);
    config::write_private(&directory.join("host-pin"), pin.as_bytes())?;
    Ok(first_use.then_some(pin))
}

/// Asks the host for the client release it pins; `machine.release` is answered
/// before any attach, so no enrollment identity or generation is touched.
pub async fn release(
    config: &ClientConfig,
    directory: &Path,
) -> Result<Option<serde_json::Value>, AttachError> {
    let client = match &config.unix {
        Some(path) => Client::connect_unix(path, refuse_inbound()).await?,
        None => {
            let pin = fs::read_to_string(directory.join("host-pin"))?;
            let trust = HostTrust::Pin(config::parse_pin(&pin)?);
            connect_tls(&config.host, directory, trust, refuse_inbound())
                .await??
                .0
        }
    };
    let response = client.call("machine.release", None).await?;
    let result = oni_protocol::decode::<oni_protocol::ReleaseResult>(response.unwrap_or_default())?;
    let document = serde_json::to_value(result)?;
    Ok((document["status"] == "available").then(|| document["release"].clone()))
}

pub async fn join(
    options: &JoinOptions,
    home: &Path,
    capabilities: &[&str],
) -> Result<Enrollment, AttachError> {
    let directory = home.join("machine-client");
    let trust = match options.unix {
        Some(_) => None,
        None => Some(config::trust(options, home)?),
    };
    let host = match options.unix {
        Some(_) => options.host.clone(),
        None => config::resolve_address(&options.host)?,
    };
    let name = options.name.clone().unwrap_or_else(config::hostname);
    let config = ClientConfig {
        machine_id: config::slug(&name),
        name,
        host,
        tags: options.tags.clone(),
        exports: config::parse_exports(&options.exports)?,
        memory_budget_mb: options.memory_budget_mb,
        unix: options.unix.clone(),
        tmux_socket: None,
    };
    let public_key = config::identity(&directory, &config.machine_id)?;
    config::save(&config, &directory)?;
    let first_use_pin = match trust {
        Some(trust) => record_pin(&config.host, &directory, trust).await?,
        None => None,
    };
    clear_generation(&directory)?;
    let allowed_exports = config.exports.iter().map(|entry| &entry.name);
    Ok(Enrollment {
        receipt: json!({
            "machineId": config.machine_id, "name": config.name, "publicKey": public_key,
            "allowedCapabilities": capabilities,
            "allowedExports": allowed_exports.collect::<Vec<_>>()
        }),
        first_use_pin,
    })
}

fn gated(
    service: Handler,
    in_flight: Arc<AtomicUsize>,
    restricted: Arc<AtomicBool>,
    attached: watch::Receiver<bool>,
) -> Handler {
    handler(move |method, params| {
        let service = service.clone();
        let in_flight = in_flight.clone();
        let mut attached = attached.clone();
        let refusal = restricted
            .load(Ordering::Relaxed)
            .then(|| budget::refusal(&method, params.as_ref()))
            .flatten();
        async move {
            if method != "machine.ping" {
                attached
                    .wait_for(|ready| *ready)
                    .await
                    .map_err(|_| "attach ended before the routed call".to_owned())?;
            }
            if let Some(refusal) = refusal {
                return Ok(refusal);
            }
            let _counted = InFlight::enter(in_flight);
            service(method, params).await
        }
    })
}

/// Counts one inbound call; the decrement runs on drop, so a call cancelled
/// by transport loss leaves the count balanced.
struct InFlight(Arc<AtomicUsize>);

impl InFlight {
    fn enter(count: Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::Relaxed);
        Self(count)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Unreachable,
    Refused,
    Ended(Duration),
}

pub struct Attachment<'a, P: ?Sized> {
    config: &'a ClientConfig,
    directory: &'a Path,
    capabilities: &'a [String],
    hooks: &'a Hooks,
    probe: &'a P,
    generation: Option<NonZeroU64>,
    budget: Budget,
    in_flight: Arc<AtomicUsize>,
    restricted: Arc<AtomicBool>,
    human: InputWatch,
    input_producer: InputProducer,
    watch_start: Instant,
    #[cfg(target_os = "macos")]
    grant_restart: Option<GrantRestart>,
    pub last_failure: Option<FailureClass>,
    pub attempts: u64,
}

fn join_failure(error: JoinError) -> AttachError {
    AttachError::Terminal(error.to_string())
}

fn classify_attach_error(error: AttachError) -> Result<FailureClass, AttachError> {
    match error {
        AttachError::MemoryBudget | AttachError::GrantRestart => Err(error),
        error => Ok(classes::classify(&error)),
    }
}

async fn notify_human_edge(
    machine_id: &str,
    watch_start: Instant,
    client: &Client,
    at: u64,
    source: Source,
) -> Result<(), AttachError> {
    let elapsed = u64::try_from(watch_start.elapsed().as_millis()).unwrap_or(u64::MAX);
    let at = now_ms().saturating_sub(elapsed.saturating_sub(at));
    client
        .notify(
            "machine.event.human_input",
            Some(json!({"machineId": machine_id, "at": at, "source": source})),
        )
        .await?;
    Ok(())
}

impl<'a, P: Probe + ?Sized> Attachment<'a, P> {
    pub fn new(
        config: &'a ClientConfig,
        directory: &'a Path,
        capabilities: &'a [String],
        hooks: &'a Hooks,
        probe: &'a P,
    ) -> Result<Self, AttachError> {
        let watch_start = Instant::now();
        let (human, input_producer) = InputWatch::new();
        #[cfg(target_os = "macos")]
        crate::input::tap::start(watch_start, input_producer.clone());
        Ok(Self {
            config,
            directory,
            capabilities,
            hooks,
            probe,
            generation: read_generation(directory)?,
            budget: Budget::new(config.memory_budget_mb),
            in_flight: Arc::new(AtomicUsize::new(0)),
            restricted: Arc::new(AtomicBool::new(false)),
            human,
            input_producer,
            watch_start,
            #[cfg(target_os = "macos")]
            grant_restart: None,
            last_failure: None,
            attempts: 0,
        })
    }

    /// Fixture feeds use the same bounded producer as the native callback.
    pub fn input_feed(&self) -> InputProducer {
        self.input_producer.clone()
    }

    pub async fn once(&mut self) -> Result<Outcome, AttachError> {
        self.human.discard_edges();
        let (ready, attached) = watch::channel(false);
        let Some(mut client) = self.connect(attached).await? else {
            return Ok(Outcome::Unreachable);
        };
        let (uplink, mut calls) = Uplink::channel();
        self.hooks.session.uplink(uplink);
        if !self.negotiate(&client).await? {
            return Ok(Outcome::Refused);
        }
        ready.send_replace(true);
        let _session = AttachedSession(self.hooks.session.as_ref());
        let connected = tokio::time::Instant::now();
        let ended = self.heartbeat(&mut client, &mut calls).await;
        ended.map(|()| Outcome::Ended(connected.elapsed()))
    }

    async fn connect(
        &mut self,
        attached: watch::Receiver<bool>,
    ) -> Result<Option<Client>, AttachError> {
        let service = gated(
            self.hooks.service.clone(),
            self.in_flight.clone(),
            self.restricted.clone(),
            attached,
        );
        let connected = match &self.config.unix {
            Some(path) => Client::connect_unix(path, service).await,
            None => {
                let pin = fs::read_to_string(self.directory.join("host-pin"))?;
                let trust = HostTrust::Pin(config::parse_pin(&pin)?);
                connect_tls(&self.config.host, self.directory, trust, service)
                    .await?
                    .map(|(client, _)| client)
            }
        };
        match connected {
            Ok(client) => Ok(Some(client)),
            Err(error @ TransportError::HostKeyMismatch) => Err(error.into()),
            Err(error) => {
                self.last_failure = Some(classes::classify(&AttachError::Transport(error)));
                Ok(None)
            }
        }
    }

    async fn negotiate(&mut self, client: &Client) -> Result<bool, AttachError> {
        let cpus = std::thread::available_parallelism().map_or(1, NonZeroUsize::get);
        let offered = offer(
            self.config,
            self.capabilities,
            self.generation,
            now_ms(),
            cpus,
            self.probe.memory()?,
        );
        let response = match client.call("machine.attach", Some(offered)).await {
            Ok(Some(response)) => response,
            Err(error) => {
                self.last_failure = Some(classes::classify(&AttachError::Call(error)));
                return Ok(false);
            }
            Ok(None) => {
                self.last_failure = Some(FailureClass::RemoteUnavailable);
                return Ok(false);
            }
        };
        match result(response) {
            Ok(negotiated) => {
                self.generation = Some(negotiated.generation);
                save_generation(self.directory, negotiated.generation)?;
                self.hooks.session.connected(client.caller());
                self.hooks.session.attached(&negotiated);
                Ok(true)
            }
            Err(error @ AttachError::Terminal(_)) => Err(error),
            Err(error) => {
                self.last_failure = Some(classes::classify(&error));
                Ok(false)
            }
        }
    }

    fn beat(&mut self, mut screen: crate::screen::probe::Verdict) -> Result<Value, AttachError> {
        let at = now_ms();
        let in_flight = self.in_flight.load(Ordering::Relaxed);
        let rss_bytes = self.probe.rss()?;
        let retained = self.hooks.pressure.retained();
        let streams = self.hooks.pressure.streams();
        report::append_metrics(
            &self.directory.join("metrics.jsonl"),
            &Metrics {
                at,
                rss_bytes,
                in_flight,
                retained_pty_bytes: retained.pty_bytes,
                transfers: retained.transfers,
                retained_frame_bytes: retained.frame_bytes,
                retained_stream_bytes: retained.stream_bytes,
                streams: budget::StreamTotals::of(&streams),
            },
        )?;
        match self.budget.sample(rss_bytes) {
            BudgetAction::Exit => return Err(AttachError::MemoryBudget),
            BudgetAction::Shed => self.hooks.pressure.shed(),
            BudgetAction::Healthy => {}
        }
        self.restricted
            .store(self.budget.restricted(), Ordering::Relaxed);
        #[cfg(target_os = "macos")]
        if !self.human.available() {
            screen.blockers.push(crate::screen::probe::Blocker {
                kind: "input_monitoring_not_granted",
            });
            if screen.verdict == "available" {
                screen.verdict = "partial";
            }
        }
        screen.refresh_needs();
        crate::service::setup_needs(&mut screen, &config::home(), None, false);
        let mut report = json!({
            "machineId": self.config.machine_id, "reportedAt": at,
            "load": self.probe.load(in_flight)?,
            "screen": screen,
            "transport": {"lastFailure": self.last_failure, "attempts": self.attempts}
        });
        #[cfg(target_os = "macos")]
        {
            let (locked, asleep) = crate::input::tap::session();
            report["session"] = json!({ "locked": locked, "asleep": asleep });
        }
        if let Some(input) = self.human.consume(
            at,
            u64::try_from(self.watch_start.elapsed().as_millis()).unwrap_or(u64::MAX),
        ) {
            report["humanInput"] = json!(input);
        }
        report::with_streams(&mut report, streams);
        Ok(report)
    }

    async fn heartbeat(
        &mut self,
        client: &mut Client,
        calls: &mut mpsc::Receiver<UplinkCall>,
    ) -> Result<(), AttachError> {
        let mut tick = tokio::time::interval(self.hooks.heartbeat);
        let mut reports = JoinSet::new();
        #[cfg(target_os = "macos")]
        let mut restart_after_report = false;
        let mut probes = JoinSet::new();
        let mut uplinks = JoinSet::new();
        let mut frames = client.frames();
        let silence = async move {
            loop {
                let deadline = *frames.borrow_and_update() + Duration::from_secs(15);
                tokio::select! {
                    () = tokio::time::sleep_until(deadline) => return,
                    changed = frames.changed() => if changed.is_err() { return },
                }
            }
        };
        tokio::pin!(silence);
        loop {
            tokio::select! {
                _ = client.closed() => {
                    #[cfg(target_os = "macos")]
                    if restart_after_report { break Err(AttachError::GrantRestart); }
                    break Ok(());
                },
                () = &mut silence => {
                    self.last_failure = Some(FailureClass::Timeout);
                    #[cfg(target_os = "macos")]
                    if restart_after_report { break Err(AttachError::GrantRestart); }
                    break Ok(());
                },
                Some((at, source)) = self.human.next_edge() =>
                    notify_human_edge(&self.config.machine_id, self.watch_start, client, at, source).await?,
                Some(call) = calls.recv(), if uplinks.len() < UPLINK_BOUND => {
                    let caller = client.caller();
                    uplinks.spawn(async move {
                        let answer = caller.call_with_timeout(
                            &call.method, Some(call.params.clone()),
                            crate::transport::request_table::CALL_TIMEOUT,
                        ).await;
                        call.answer(answer);
                    });
                },
                Some(finished) = reports.join_next(), if !reports.is_empty() => {
                    if let Ok(Some(response)) = finished.map_err(join_failure)? {
                        if !matches!(
                            oni_protocol::decode::<ReportResult>(response)?,
                            ReportResult::Accepted
                        ) {
                            #[cfg(target_os = "macos")]
                            if restart_after_report { break Err(AttachError::GrantRestart); }
                            break Ok(());
                        }
                    }
                    #[cfg(target_os = "macos")]
                    if restart_after_report {
                        // The tick guard permits only one report in flight.
                        break Err(AttachError::GrantRestart);
                    }
                }
                Some(finished) = uplinks.join_next(), if !uplinks.is_empty() => {
                    finished.map_err(join_failure)?;
                }
                Some(finished) = probes.join_next(), if !probes.is_empty() => {
                    #[cfg(target_os = "macos")]
                    let mut screen = finished.map_err(join_failure)?;
                    #[cfg(not(target_os = "macos"))]
                    let screen = finished.map_err(join_failure)?;
                    #[cfg(target_os = "macos")]
                    if let Some(restart) = &mut self.grant_restart {
                        match restart.tick(&mut screen, crate::service::screen_granted, now_ms()) {
                            GrantDecision::Restart => {
                                eprintln!("screen grant observed, restarting for it to apply");
                                restart_after_report = true;
                            }
                            GrantDecision::None | GrantDecision::Bound => {}
                        }
                    }
                    let report = match self.beat(screen) {
                        Ok(report) => report,
                        Err(error) => {
                            #[cfg(target_os = "macos")]
                            if restart_after_report { break Err(AttachError::GrantRestart); }
                            return Err(error);
                        }
                    };
                    let caller = client.caller();
                    reports.spawn(async move {
                        caller.call_with_timeout(
                            "machine.report", Some(report),
                            crate::transport::request_table::CALL_TIMEOUT,
                        ).await
                    });
                }
                _ = tick.tick(), if reports.is_empty() && probes.is_empty() => {
                    let screen = self.hooks.screen.clone();
                    let input = self.hooks.input.clone();
                    probes.spawn_blocking(move || screen.capability(input.ready()));
                }
            }
        }
    }
}

pub async fn run_with_events(
    config: &ClientConfig,
    directory: &Path,
    capabilities: &[String],
    hooks: &Hooks,
    probe: &dyn Probe,
    events: &mut mpsc::UnboundedReceiver<Event>,
) -> Result<Infallible, AttachError> {
    run_with_grant_events(
        config,
        directory,
        capabilities,
        hooks,
        probe,
        events,
        #[cfg(target_os = "macos")]
        None,
    )
    .await
}

async fn run_with_grant_events(
    config: &ClientConfig,
    directory: &Path,
    capabilities: &[String],
    hooks: &Hooks,
    probe: &dyn Probe,
    events: &mut mpsc::UnboundedReceiver<Event>,
    #[cfg(target_os = "macos")] grant_restart: Option<GrantRestart>,
) -> Result<Infallible, AttachError> {
    let mut attachment = Attachment::new(config, directory, capabilities, hooks, probe)?;
    #[cfg(target_os = "macos")]
    {
        attachment.grant_restart = grant_restart;
    }
    let mut retry = Retry::default();
    let mut random = RuntimeRandom;
    let clock = tokio::time::Instant::now();
    loop {
        let outcome = tokio::select! {
            outcome = attachment.once() => Some(outcome),
            event = events.recv() => {
                let Some(event) = event else { return Err(AttachError::EventsClosed) };
                retry.event(clock.elapsed(), event, &mut random);
                None
            }
        };
        let Some(outcome) = outcome else {
            while retry.next(clock.elapsed()) == Next::Suspended {
                let Some(event) = events.recv().await else {
                    return Err(AttachError::EventsClosed);
                };
                retry.event(clock.elapsed(), event, &mut random);
            }
            continue;
        };
        let class = match outcome {
            Ok(Outcome::Ended(connected_for)) => {
                let stopped = clock.elapsed();
                retry.event(
                    stopped.saturating_sub(connected_for),
                    Event::Connected,
                    &mut random,
                );
                retry.event(stopped, Event::Disconnected, &mut random);
                attachment
                    .last_failure
                    .take()
                    .unwrap_or(FailureClass::RemoteUnavailable)
            }
            Ok(Outcome::Refused | Outcome::Unreachable) => attachment
                .last_failure
                .unwrap_or(FailureClass::RemoteUnavailable),
            Err(error) => classify_attach_error(error)?,
        };
        let next = retry.event(clock.elapsed(), Event::Failed(class), &mut random);
        attachment.last_failure = retry.last_failure;
        attachment.attempts = retry.attempts;
        report::append_metrics(
            &directory.join("metrics.jsonl"),
            &json!({"at": now_ms(), "transport": {"lastFailure": class, "attempts": retry.attempts}}),
        )?;
        if !class.retries() {
            eprintln!("{}", json!({"class": class, "nextStep": class.next_step()}));
        }
        await_next(&mut retry, next, events, clock, &mut random).await?;
    }
}

async fn await_next(
    retry: &mut Retry,
    mut next: Next,
    events: &mut mpsc::UnboundedReceiver<Event>,
    clock: tokio::time::Instant,
    random: &mut RuntimeRandom,
) -> Result<Next, AttachError> {
    while let Next::Wait(delay) = next {
        tokio::select! {
            () = tokio::time::sleep(delay) => break,
            event = events.recv() => {
                let Some(event) = event else { return Err(AttachError::EventsClosed) };
                next = retry.event(clock.elapsed(), event, random);
                if next == Next::Attempt { break }
            }
        }
    }
    while next == Next::Suspended {
        let Some(event) = events.recv().await else {
            return Err(AttachError::EventsClosed);
        };
        next = retry.event(clock.elapsed(), event, random);
    }
    Ok(next)
}

pub async fn run_default(path: &Path) -> Result<(), AttachError> {
    run_default_with_screen(path, false, false).await
}

pub async fn run_service(config_path: &Path) -> Result<(), AttachError> {
    let directory = config_path.parent().unwrap_or(Path::new(""));
    let mut retry_signal =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::user_defined1())?;
    let mut terminated = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    save_service_pid(directory, Some(std::process::id()))?;
    let result = loop {
        match run_default_with_screen(config_path, true, false).await {
            Err(error) if service_reprobe(&error) => {
                let class = classes::classify(&error);
                eprintln!("{}", json!({"class": class, "nextStep": class.next_step()}));
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_secs(300)) => {}
                    _ = retry_signal.recv() => {}
                    _ = terminated.recv() => break Ok(()),
                }
            }
            result => break result,
        }
    };
    save_service_pid(directory, None)?;
    result
}

fn service_reprobe(error: &AttachError) -> bool {
    !matches!(error, AttachError::MemoryBudget | AttachError::GrantRestart)
        && matches!(
            classes::classify(error),
            FailureClass::Authentication | FailureClass::Configuration | FailureClass::Superseded
        )
}

fn once_result(
    outcome: Result<Outcome, AttachError>,
    last_failure: Option<FailureClass>,
) -> Result<(), AttachError> {
    match outcome {
        Ok(Outcome::Ended(_)) => Ok(()),
        Ok(_) => Err(AttachError::Once(
            last_failure.unwrap_or(FailureClass::RemoteUnavailable),
        )),
        Err(error @ AttachError::MemoryBudget) => Err(error),
        Err(error) => Err(AttachError::Once(classes::classify(&error))),
    }
}

pub async fn run_service_once(path: &Path) -> Result<(), AttachError> {
    run_default_with_screen(path, false, true).await
}

async fn run_default_with_screen(
    path: &Path,
    request_screen: bool,
    once: bool,
) -> Result<(), AttachError> {
    let directory = path.parent().unwrap_or(Path::new(""));
    let config = config::load(path)?;
    #[cfg(target_os = "macos")]
    if request_screen {
        crate::service::request_screen();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = request_screen;
    let generation = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    let pty = Pty::new(
        "tmux",
        config.tmux_socket.clone(),
        format!("{generation:016x}"),
    )
    .await;
    let socket = hook::socket_path(directory)?;
    let options = AgentOptions {
        registry: directory.to_path_buf(),
        home: config::home(),
        hook: HookTarget {
            program: std::env::current_exe()?,
            modules: directory.join("hooks"),
            socket: socket.clone(),
        },
        ready: AGENT_READY,
        decide: hook::DECIDE,
        grace: AGENT_GRACE,
    };
    let manifest =
        crate::cdp::manifest::Manifest::load(&directory.join(crate::cdp::manifest::FILE))
            .map_err(io::Error::other)?;
    let (screen, input) = crate::computer::open(path)?.unwrap_or_else(crate::computer::platform);
    let service = Service::open_full(
        &config,
        pty,
        (screen, input),
        crate::cdp::Cdp::new(manifest, crate::cdp::OPEN_DEADLINE),
        crate::stream::local_address(),
        options,
    )
    .map_err(io::Error::other)?;
    let mut permissions = tokio::task::JoinSet::new();
    permissions.spawn(hook::serve(hook::bind(&socket)?, service.clone()));
    let hooks = service.hooks(HEARTBEAT);
    let mut terminated = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupted =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let (mut events, feed) = events::subscribe(!once)?;
    let result = tokio::select! {
        result = async {
            if once {
                let mut attachment = Attachment::new(&config, directory, service.capabilities(), &hooks, &report::SystemProbe)?;
                let outcome = attachment.once().await;
                return once_result(outcome, attachment.last_failure);
            }
            match run_with_grant_events(
                &config, directory, service.capabilities(), &hooks, &report::SystemProbe, &mut events,
                #[cfg(target_os = "macos")]
                request_screen.then(|| GrantRestart::new(config::root().join("state/grant-restarts.json"))),
            ).await {
                Ok(never) => match never {},
                Err(error) => Err(error),
            }
        } => result,
        _ = terminated.recv() => Ok(()),
        _ = interrupted.recv() => Ok(()),
    };
    feed.abort();
    service.detached();
    service.shutdown().await;
    permissions.abort_all();
    result
}

const UPLINK_BOUND: usize = 16;

/// One client-to-host call queued by long-lived local work (a CDP
/// channel's bytes); the attachment loop makes it on its connection.
pub struct UplinkCall {
    pub method: String,
    pub params: Value,
    reply: oneshot::Sender<Result<Option<Value>, CallError>>,
}

impl UplinkCall {
    /// A caller that stopped waiting has nothing left to receive.
    pub fn answer(self, answer: Result<Option<Value>, CallError>) {
        let _ = self.reply.send(answer);
    }
}

/// The queue into one connection's attachment loop: a call made after the
/// connection ended fails as disconnected.
#[derive(Clone)]
pub struct Uplink(mpsc::Sender<UplinkCall>);

impl Uplink {
    pub fn channel() -> (Self, mpsc::Receiver<UplinkCall>) {
        let (sender, calls) = mpsc::channel(UPLINK_BOUND);
        (Self(sender), calls)
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Option<Value>, CallError> {
        let (reply, answer) = oneshot::channel();
        let call = UplinkCall {
            method: method.to_owned(),
            params,
            reply,
        };
        self.0
            .send(call)
            .await
            .map_err(|_| CallError::Disconnected)?;
        answer.await.map_err(|_| CallError::Disconnected)?
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use serde_json::json;
    use tokio::{
        io::split,
        sync::{mpsc, watch},
    };

    use crate::{
        attach::{Negotiated, Session},
        config::ClientConfig,
        handlers::Service,
        input::watch::Source,
        pty::ops::Pty,
        transport::{
            client::{handler, Client, TransportError},
            framing::{self, Framed},
        },
    };

    use super::{
        await_next, classify_attach_error, gated, join_failure, notify_human_edge, once_result,
        service_reprobe, AttachError, Outcome, RuntimeRandom,
    };
    use crate::transport::{
        classes::FailureClass,
        retry::{Event, Next, Retry},
    };

    #[tokio::test]
    async fn attach_reply_before_routed_read_waits_for_grant_activation() {
        let root = tempfile::tempdir().expect("export root");
        let config = ClientConfig {
            machine_id: "conformance".into(),
            name: "Conformance".into(),
            host: "127.0.0.1:7643".into(),
            tags: vec![],
            exports: vec![crate::config::Export {
                name: "notes".into(),
                path: root.path().to_str().expect("root").into(),
            }],
            memory_budget_mb: 96,
            unix: None,
            tmux_socket: None,
        };
        std::fs::write(root.path().join("one"), b"hello").expect("seed");
        let pty = Pty::new("/definitely/missing/tmux", None, "g".into()).await;
        let service = Service::open(&config, pty).expect("service");
        let hooks = service.hooks(Duration::from_secs(60));
        let (ready, attached) = watch::channel(false);
        let gated_service = gated(
            hooks.service,
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            attached,
        );
        let (started, mut routed) = mpsc::unbounded_channel();
        let routed_handler = handler(move |method, params| {
            let gated_service = gated_service.clone();
            let started = started.clone();
            async move {
                if method == "machine.fs_op" {
                    started.send(()).expect("read reached dispatch");
                }
                gated_service(method, params).await
            }
        });
        let (client_stream, host_stream) = tokio::io::duplex(4096);
        let client = Client::from_stream(client_stream, routed_handler);
        let (reader, mut writer) = split(host_stream);
        let mut frames = Framed::new(reader);
        let call = client.call("machine.attach", Some(json!({})));
        let host = async {
            let offer = frames.next().await.expect("offer").expect("frame");
            framing::write_frame(
                &mut writer,
                &json!({"v":2,"type":"response","id":offer["id"],"result":{"status":"attached"}}),
            )
            .await
            .expect("attach reply");
            framing::write_frame(
                &mut writer,
                &json!({"v":2,"type":"request","id":"read","method":"machine.fs_op",
                    "params":{"op":"read","export":"notes","path":"one"}}),
            )
            .await
            .expect("back-to-back read");
            routed
                .recv()
                .await
                .expect("read reached dispatch before grant");
            service.attached(&Negotiated {
                generation: std::num::NonZeroU64::MIN,
                capabilities: vec!["fs.read".into()],
                exports: vec!["notes".into()],
            });
            ready.send_replace(true);
            let response = frames.next().await.expect("read response").expect("frame");
            assert_eq!(response["id"], "read");
            assert_eq!(response["result"]["status"], "completed");
        };
        let (reply, ()) =
            tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(call, host) })
                .await
                .expect("read completed");
        assert_eq!(
            reply.expect("attach response").expect("result")["status"],
            "attached"
        );
    }

    #[tokio::test]
    async fn pending_routed_call_fails_when_attach_connection_closes() {
        let (ready, attached) = watch::channel(false);
        let service = gated(
            super::refuse_inbound(),
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            attached,
        );
        drop(ready);
        assert_eq!(
            service("machine.fs_op".into(), Some(json!({}))).await,
            Err("attach ended before the routed call".into())
        );
    }

    #[tokio::test]
    async fn ping_is_served_before_attach() {
        let (_ready, attached) = watch::channel(false);
        let service = gated(
            handler(|_, _| async { Ok(json!({"status":"alive"})) }),
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            attached,
        );
        assert_eq!(
            service("machine.ping".into(), Some(json!({}))).await,
            Ok(json!({"status":"alive"}))
        );
    }

    #[tokio::test]
    async fn restricted_routed_call_waits_for_attach_then_refuses_without_dispatch() {
        let (ready, attached) = watch::channel(false);
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = calls.clone();
        let gate = gated(
            handler(move |_, _| {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async { Ok(json!({"status":"completed"})) }
            }),
            std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            attached,
        );
        ready.send_replace(true);
        assert_eq!(
            gate("machine.exec".into(), Some(json!({}))).await,
            Ok(json!({"status":"refused","reason":"exec_not_available"}))
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(
            gate("machine.fs_op".into(), Some(json!({}))).await,
            Ok(json!({"status":"completed"}))
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_retry_event_attempts_immediately() {
        let clock = tokio::time::Instant::now();
        let mut retry = Retry::default();
        let mut random = RuntimeRandom;
        let next = retry.event(
            Duration::ZERO,
            Event::Failed(FailureClass::Authentication),
            &mut random,
        );
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        sender.send(Event::Retry).expect("retry event");

        let result = await_next(&mut retry, next, &mut events, clock, &mut random).await;

        assert!(matches!(result, Ok(Next::Attempt)));
    }

    #[tokio::test(start_paused = true)]
    async fn wait_event_remains_waiting_until_deadline() {
        let clock = tokio::time::Instant::now();
        let mut retry = Retry::default();
        let mut random = RuntimeRandom;
        let next = retry.event(
            Duration::ZERO,
            Event::Failed(FailureClass::Authentication),
            &mut random,
        );
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        sender
            .send(Event::Failed(FailureClass::Authentication))
            .expect("failure event");

        let (result, ()) = tokio::join!(
            await_next(&mut retry, next, &mut events, clock, &mut random),
            tokio::time::advance(Duration::from_secs(301))
        );

        assert!(matches!(result, Ok(Next::Wait(_))));
        assert_eq!(retry.attempts, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_closed_events_returns_error() {
        let clock = tokio::time::Instant::now();
        let mut retry = Retry::default();
        let mut random = RuntimeRandom;
        let next = retry.event(
            Duration::ZERO,
            Event::Failed(FailureClass::Authentication),
            &mut random,
        );
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        drop(sender);

        let result = await_next(&mut retry, next, &mut events, clock, &mut random).await;

        assert!(matches!(result, Err(AttachError::EventsClosed)));
    }

    #[tokio::test(start_paused = true)]
    async fn wait_suspend_then_wake_attempts() {
        let clock = tokio::time::Instant::now();
        let mut retry = Retry::default();
        let mut random = RuntimeRandom;
        let next = retry.event(
            Duration::ZERO,
            Event::Failed(FailureClass::Authentication),
            &mut random,
        );
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        sender.send(Event::Suspend).expect("suspend event");
        sender.send(Event::Wake).expect("wake event");

        let result = await_next(&mut retry, next, &mut events, clock, &mut random).await;

        assert!(matches!(result, Ok(Next::Attempt)));
    }

    #[tokio::test(start_paused = true)]
    async fn suspended_wake_attempts() {
        let clock = tokio::time::Instant::now();
        let mut retry = Retry::default();
        let mut random = RuntimeRandom;
        let next = retry.event(Duration::ZERO, Event::Suspend, &mut random);
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        sender.send(Event::Wake).expect("wake event");

        let result = await_next(&mut retry, next, &mut events, clock, &mut random).await;

        assert!(matches!(result, Ok(Next::Attempt)));
    }

    #[tokio::test(start_paused = true)]
    async fn suspended_closed_events_returns_error() {
        let clock = tokio::time::Instant::now();
        let mut retry = Retry::default();
        let mut random = RuntimeRandom;
        let next = retry.event(Duration::ZERO, Event::Suspend, &mut random);
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        drop(sender);

        let result = await_next(&mut retry, next, &mut events, clock, &mut random).await;

        assert!(matches!(result, Err(AttachError::EventsClosed)));
    }

    #[test]
    fn budget_exit_survives_both_service_wrappers() {
        let budget = AttachError::MemoryBudget;
        assert!(!service_reprobe(&budget));
        assert_eq!(
            once_result(Err(budget), None)
                .expect_err("budget exit")
                .exit_code(),
            4
        );
    }

    #[test]
    fn grant_restart_bypasses_service_reprobe() {
        assert!(!service_reprobe(&AttachError::GrantRestart));
        assert_eq!(AttachError::GrantRestart.exit_code(), 75);
    }

    #[test]
    fn grant_restart_exits_retry_loop_without_classification() {
        assert!(matches!(
            classify_attach_error(AttachError::GrantRestart),
            Err(AttachError::GrantRestart)
        ));
    }

    #[test]
    fn once_result_maps_ended_refused_and_transport_failure() {
        assert!(once_result(Ok(Outcome::Ended(Duration::ZERO)), None).is_ok());
        assert!(matches!(
            once_result(Ok(Outcome::Unreachable), None),
            Err(AttachError::Once(FailureClass::RemoteUnavailable))
        ));
        assert!(matches!(
            once_result(Ok(Outcome::Refused), Some(FailureClass::Authentication)),
            Err(AttachError::Once(FailureClass::Authentication))
        ));
        assert!(matches!(
            once_result(Err(AttachError::ServiceUnavailable), None),
            Err(AttachError::Once(FailureClass::Configuration))
        ));
    }

    #[test]
    fn service_reprobes_authentication_configuration_and_superseded() {
        assert!(service_reprobe(&AttachError::Terminal(
            "unsupported_contract".to_owned()
        )));
        assert!(service_reprobe(&AttachError::Terminal(
            "machine_not_enrolled".to_owned()
        )));
        assert!(service_reprobe(&AttachError::Terminal(
            "stale_generation".to_owned()
        )));
        assert_eq!(
            once_result(Ok(Outcome::Refused), Some(FailureClass::Superseded))
                .expect_err("superseded one-shot refusal")
                .exit_code(),
            3
        );
        assert!(!service_reprobe(&AttachError::Transport(
            crate::transport::client::TransportError::Closed
        )));
    }

    #[tokio::test]
    async fn inbound_requests_before_attachment_are_refused() {
        let refusal = super::refuse_inbound()("machine.exec".to_owned(), None).await;
        assert_eq!(refusal, Err("machine_not_attached".to_owned()));
    }

    #[tokio::test]
    async fn human_edge_notification_after_disconnect_is_a_call_error() {
        let (stream, peer) = tokio::io::duplex(64);
        let mut client = Client::from_stream(stream, super::refuse_inbound());
        drop(peer);
        assert!(matches!(client.closed().await, Err(TransportError::Closed)));

        let error = notify_human_edge("test", Instant::now(), &client, 1_000, Source::Keyboard)
            .await
            .expect_err("notification failed");
        assert!(matches!(
            error,
            AttachError::Call(crate::transport::request_table::CallError::Disconnected)
        ));
    }

    #[tokio::test]
    async fn human_edge_notification_reaches_the_host() {
        let (stream, peer) = tokio::io::duplex(1024);
        let client = Client::from_stream(stream, super::refuse_inbound());

        notify_human_edge("test", Instant::now(), &client, 1_000, Source::Keyboard)
            .await
            .expect("notification queued");
        let frame = tokio::time::timeout(Duration::from_secs(5), Framed::new(peer).next())
            .await
            .expect("notification arrived")
            .expect("valid frame")
            .expect("notification frame");
        assert_eq!(frame["method"], "machine.event.human_input");
        assert_eq!(frame["params"]["machineId"], "test");
        assert_eq!(frame["params"]["source"], json!(Source::Keyboard));
        assert!(frame["params"]["at"].is_u64());
    }

    #[tokio::test]
    async fn panicked_join_task_maps_to_terminal_error() {
        let error = tokio::spawn(async { panic!("task panic") })
            .await
            .expect_err("panicked task");
        assert!(
            matches!(join_failure(error), AttachError::Terminal(message) if message.contains("panicked"))
        );
    }
}
