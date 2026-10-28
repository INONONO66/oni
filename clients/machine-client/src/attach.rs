use std::{
    convert::Infallible,
    fs,
    hash::{BuildHasher, Hasher},
    io,
    num::{NonZeroU64, NonZeroUsize},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use oni_protocol::{AttachResult, ReportResult};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::{
    agent::{hook, launcher::HookTarget},
    budget::{self, Budget, BudgetAction, Metrics, Pressure},
    config::{self, ClientConfig, JoinOptions},
    handlers::{AgentOptions, Service},
    pty::ops::Pty,
    report::{self, Probe},
    transport::{
        client::{handler, Caller, Client, Handler, TransportError},
        connection::HostTrust,
        request_table::CallError,
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
    #[error(transparent)]
    Computer(#[from] crate::computer::ComputerError),
}

impl AttachError {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Terminal(_) | Self::Transport(TransportError::HostKeyMismatch) => 3,
            Self::MemoryBudget => 4,
            _ => 2,
        }
    }

    pub fn reason(&self) -> String {
        match self {
            Self::Transport(TransportError::HostKeyMismatch) => "peer_key_mismatch".to_owned(),
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

pub struct Hooks {
    pub service: Handler,
    pub pressure: Arc<dyn Pressure>,
    pub session: Arc<dyn Session>,
    pub screen: Arc<crate::screen::Screen>,
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
    generation: NonZeroU64,
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
        "peer": {"kind":"client","contractVersion":oni_protocol::CONTRACT_VERSION}
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
        Ok(data) => Ok(Some(
            serde_json::from_slice::<SavedGeneration>(&data)?.generation,
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn save_generation(directory: &Path, generation: NonZeroU64) -> io::Result<()> {
    let state = json!({ "generation": generation }).to_string();
    config::write_private(&directory.join("state.json"), state.as_bytes())
}

fn clear_generation(directory: &Path) -> io::Result<()> {
    match fs::remove_file(directory.join("state.json")) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn jitter(attempt: u32) -> Duration {
    let ceiling = 250_u64
        .saturating_mul(2_u64.saturating_pow(attempt.min(20)))
        .min(30_000);
    let random = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    Duration::from_millis(random % (ceiling + 1))
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
    config::save(&config, &directory)?;
    let public_key = config::identity(&directory, &config.machine_id)?;
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

fn gated(service: Handler, in_flight: Arc<AtomicUsize>, restricted: Arc<AtomicBool>) -> Handler {
    handler(move |method, params| {
        let service = service.clone();
        let in_flight = in_flight.clone();
        let refusal = restricted
            .load(Ordering::Relaxed)
            .then(|| budget::refusal(&method, params.as_ref()))
            .flatten();
        async move {
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
    Ended,
}

pub struct Attachment<'a, P> {
    config: &'a ClientConfig,
    directory: &'a Path,
    capabilities: &'a [String],
    hooks: &'a Hooks,
    probe: &'a P,
    generation: Option<NonZeroU64>,
    budget: Budget,
    in_flight: Arc<AtomicUsize>,
    restricted: Arc<AtomicBool>,
}

impl<'a, P: Probe> Attachment<'a, P> {
    pub fn new(
        config: &'a ClientConfig,
        directory: &'a Path,
        capabilities: &'a [String],
        hooks: &'a Hooks,
        probe: &'a P,
    ) -> Result<Self, AttachError> {
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
        })
    }

    pub async fn once(&mut self) -> Result<Outcome, AttachError> {
        let Some(mut client) = self.connect().await? else {
            return Ok(Outcome::Unreachable);
        };
        let (uplink, mut calls) = Uplink::channel();
        self.hooks.session.uplink(uplink);
        if !self.negotiate(&client).await? {
            return Ok(Outcome::Refused);
        }
        let ended = self.heartbeat(&mut client, &mut calls).await;
        self.hooks.session.detached();
        ended.map(|()| Outcome::Ended)
    }

    async fn connect(&self) -> Result<Option<Client>, AttachError> {
        let service = gated(
            self.hooks.service.clone(),
            self.in_flight.clone(),
            self.restricted.clone(),
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
            Err(_) => Ok(None),
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
        let Ok(Some(response)) = client.call("machine.attach", Some(offered)).await else {
            return Ok(false);
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
            Err(_) => Ok(false),
        }
    }

    async fn beat(&mut self, client: &Client) -> Result<bool, AttachError> {
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
        let mut report = json!({
            "machineId": self.config.machine_id, "reportedAt": at,
            "load": self.probe.load(in_flight)?,
            "screen": {"permission": report::screen_permission(self.hooks.screen.probe())}
        });
        report::with_streams(&mut report, streams);
        match client.call("machine.report", Some(report)).await {
            Ok(Some(response)) => Ok(matches!(
                oni_protocol::decode::<ReportResult>(response)?,
                ReportResult::Accepted
            )),
            _ => Ok(true),
        }
    }

    async fn heartbeat(
        &mut self,
        client: &mut Client,
        calls: &mut mpsc::Receiver<UplinkCall>,
    ) -> Result<(), AttachError> {
        let mut tick = tokio::time::interval(self.hooks.heartbeat);
        loop {
            tokio::select! {
                _ = client.closed() => return Ok(()),
                Some(call) = calls.recv() => {
                    let answer = client.call(&call.method, Some(call.params.clone())).await;
                    call.answer(answer);
                },
                _ = tick.tick() => if !self.beat(client).await? {
                    return Ok(());
                },
            }
        }
    }
}

pub async fn run(
    config: &ClientConfig,
    directory: &Path,
    capabilities: &[String],
    hooks: &Hooks,
) -> Result<Infallible, AttachError> {
    run_with_probe(config, directory, capabilities, hooks, &report::SystemProbe).await
}

pub async fn run_with_probe(
    config: &ClientConfig,
    directory: &Path,
    capabilities: &[String],
    hooks: &Hooks,
    probe: &impl Probe,
) -> Result<Infallible, AttachError> {
    let mut attachment = Attachment::new(config, directory, capabilities, hooks, probe)?;
    let mut attempt = 0_u32;
    let error = loop {
        match attachment.once().await {
            Err(error) => break error,
            Ok(Outcome::Ended) => attempt = 0,
            Ok(_) => {}
        }
        tokio::time::sleep(jitter(attempt)).await;
        attempt = attempt.saturating_add(1);
    };
    Err(error)
}

pub async fn run_default(path: Option<&Path>) -> Result<(), AttachError> {
    run_default_with_screen(path, false).await
}

pub async fn run_service(path: Option<&Path>) -> Result<(), AttachError> {
    run_default_with_screen(path, true).await
}

async fn run_default_with_screen(
    path: Option<&Path>,
    request_screen: bool,
) -> Result<(), AttachError> {
    let path = path.map_or_else(
        || config::root().join("machine-client/client.json"),
        Path::to_path_buf,
    );
    let directory = path.parent().unwrap_or(Path::new(""));
    let config = config::load(&path)?;
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
    let (screen, input) = crate::computer::open(&path)?.unwrap_or_else(|| {
        (
            crate::screen::Screen::platform(),
            crate::input::Input::platform(),
        )
    });
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
    let result = tokio::select! {
        result = run(&config, directory, service.capabilities(), &hooks) => match result {
            Ok(never) => match never {},
            Err(error) => Err(error),
        },
        _ = terminated.recv() => Ok(()),
        _ = interrupted.recv() => Ok(()),
    };
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
    #[tokio::test]
    async fn inbound_requests_before_attachment_are_refused() {
        let refusal = super::refuse_inbound()("machine.exec".to_owned(), None).await;
        assert_eq!(refusal, Err("machine_not_attached".to_owned()));
    }
}
