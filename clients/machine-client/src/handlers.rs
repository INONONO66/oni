//! Inbound machine wire dispatch. A method this client offers is served by
//! its driver once the host's attach grants the capability; every other
//! method answers the protocol's typed refusal, and a method outside the
//! daemon-served wire set is an invalid method.

use std::{
    collections::HashMap,
    fmt::Display,
    future::Future,
    num::NonZeroU64,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use oni_protocol::{
    fs_stream_request::FsStreamRequestExclusiveMode, AgentPermissionDecision,
    AgentPermissionRequest, AgentSessionListRequest, AgentSessionListResult,
    AgentSessionOpenRequest, AgentSessionOpenResult, AgentSessionSendRequest,
    AgentSessionSendResult, AgentSessionStopRequest, AgentSessionStopResult,
    AgentSessionTailRequest, AgentSessionTailResult, CancelCode, CellRequest, ClipboardReadRequest,
    ClipboardWriteRequest, ExecRequest, FsRequest, FsStreamRequest, InputActionRequest,
    InputStatusRequest, InputWriteRequest, PeekCode, PtyCloseRequest, PtyListRequest,
    PtyOpenRequest, PtyReadRequest, PtyReadScreenRequest, PtyResizeRequest, PtyWriteRequest,
    ScreenReadRequest, WireMethod, WireRoot,
};
use oni_protocol::{CdpChunk, CdpCloseRequest, CdpOpenRequest};
use oni_protocol::{InputKeyRequest, InputPointerRequest, InputTextRequest};
use oni_protocol::{
    ScreenCaptureRequest, ScreenListRequest, ScreenObserveRequest, ScreenSettleRequest,
};
use oni_protocol::{StreamCloseRequest, StreamOpenRequest, StreamSignalRequest};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{watch, RwLock};

use crate::stream::{self, Stream};
use crate::{
    agent::{
        launcher::{self, HookTarget, Launcher, PermissionRelay, PtySpawner, Settings},
        manifest,
        registry::{Registry, RegistryError, Session as Observed},
        tail::{self, Position, TailError},
    },
    attach::{Hooks, Negotiated, Session},
    budget::{Pressure, Retained},
    clipboard::Clipboard,
    code::Code,
    config::ClientConfig,
    exec::{Exec, DEFAULT_DEADLINE},
    fs::{FsDriver, FsError},
    input::{action, dispatch::Completion, Input},
    pty::ops::Pty,
    screen::Screen,
    transport::{
        client::{handler, Caller},
        request_table::CallError,
    },
};
use crate::{attach::Uplink, cdp::Cdp};

const FS_READ: &str = "fs.read";
const FS_WRITE: &str = "fs.write";
const SHELL_EXEC: &str = "shell.exec";
const PTY_SESSION: &str = "pty.session";
const AGENT_SESSION: &str = "agent.session";
const MAX_SESSIONS: usize = 256;
const SCREEN_READ: &str = "screen.read";
const COMPUTER_USE: &str = "computer.use";
const INPUT_WRITE: &str = "input.write";
const PYTHON_KERNEL: &str = "kernel.py";

/// Every capability this client can serve; the enrollment receipt allows all
/// of them so a later attach can offer whatever is available by then.
pub const SUPPORTED: [&str; 9] = [
    FS_READ,
    FS_WRITE,
    SHELL_EXEC,
    PTY_SESSION,
    AGENT_SESSION,
    SCREEN_READ,
    COMPUTER_USE,
    INPUT_WRITE,
    PYTHON_KERNEL,
];

/// The capabilities offered at attach: the filesystem only with an export,
/// terminals only when tmux answered its probe. `agent.session` is never
/// offered here: only [`Service::open_with_agents`] adds it.
pub fn available(exports: bool, pty: bool) -> Vec<String> {
    SUPPORTED
        .into_iter()
        .filter(|capability| match *capability {
            FS_READ | FS_WRITE => exports,
            PTY_SESSION => pty,
            AGENT_SESSION => false,
            SCREEN_READ | COMPUTER_USE => false,
            INPUT_WRITE => false,
            PYTHON_KERNEL => false,
            _ => true,
        })
        .map(str::to_owned)
        .collect()
}

struct Grant {
    generation: NonZeroU64,
    capabilities: Vec<String>,
    exports: Vec<String>,
}

/// Where CLI sessions are observed and how long their launches and
/// permission verdicts may take.
pub struct AgentOptions {
    pub registry: PathBuf,
    pub home: PathBuf,
    pub hook: HookTarget,
    pub ready: Duration,
    pub decide: Duration,
    pub grace: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error(transparent)]
    Fs(#[from] FsError),
    #[error(transparent)]
    Registry(#[from] RegistryError),
}

struct Agents {
    launcher: RwLock<Launcher<PtySpawner>>,
    decide: Duration,
}

pub struct Service {
    machine_id: String,
    offered: Vec<String>,
    exports: HashMap<String, PathBuf>,
    fs: Mutex<FsDriver>,
    exec: Exec,
    pty: Arc<Pty>,
    grant: Mutex<Option<Grant>>,
    agents: Option<Agents>,
    caller: Mutex<Option<Caller>>,
    screen: Arc<Screen>,
    input: Arc<Input>,
    clipboard: Arc<Clipboard>,
    cdp: Cdp,
    stream: Stream,
    code: Code,
}

impl Service {
    pub async fn shutdown(&self) {
        self.clipboard.close();
        self.code.shutdown().await;
        self.exec.shutdown().await;
    }
}

/// Asks the attached host for a permission verdict; no connection, a
/// timeout, a transport error or an undecodable answer is a refusal.
struct HostRelay {
    caller: Option<Caller>,
    deadline: Duration,
}

impl PermissionRelay for HostRelay {
    async fn decide(&self, request: AgentPermissionRequest) -> AgentPermissionDecision {
        let Some(caller) = &self.caller else {
            return launcher::refused(&request, false);
        };
        let method = WireMethod::AgentSessionPermission.to_string();
        let params = serde_json::to_value(&request).expect("generated requests serialize");
        match caller
            .call_with_timeout(&method, Some(params), self.deadline)
            .await
        {
            Ok(Some(answer)) => {
                oni_protocol::decode(answer).unwrap_or_else(|_| launcher::refused(&request, false))
            }
            Err(CallError::Timeout(_)) => launcher::refused(&request, true),
            _ => launcher::refused(&request, false),
        }
    }
}

fn cursor(session_id: &str, generation: NonZeroU64, position: &Position) -> Value {
    json!({
        "sessionId": session_id, "generation": generation,
        "byteOffset": position.byte_offset, "recordHash": position.record_hash,
    })
}

fn checked<T: WireRoot + Serialize>(answer: Value) -> Result<Value, String> {
    decode::<T>(answer).map(value)
}

/// `running` means this client owns the session's live process now, not that
/// a terminal name was once persisted.
fn info(session: &Observed, running: bool) -> Value {
    json!({
        "sessionId": session.session_id, "project": session.project, "cli": session.cli,
        "state": if running { "running" } else { "stopped" },
    })
}

fn refused(reason: &str) -> Value {
    json!({"status":"refused","reason":reason})
}

fn fs_refused(reason: &str, message: String) -> Value {
    json!({"status":"refused","reason":reason,"message":message})
}

fn invalid(method: impl Display) -> String {
    format!("invalid method: {method}")
}

fn decode<T: WireRoot>(params: Value) -> Result<T, String> {
    oni_protocol::decode(params).map_err(|error| error.to_string())
}

fn value(result: impl Serialize) -> Value {
    serde_json::to_value(result).expect("generated wire results serialize")
}

fn wire<T: Serialize, E: Display>(outcome: Result<T, E>) -> Result<Value, String> {
    outcome.map(value).map_err(|error| error.to_string())
}

impl crate::agent::hook::Decide for Service {
    fn decide(
        &self,
        request: AgentPermissionRequest,
    ) -> impl Future<Output = AgentPermissionDecision> + Send {
        self.permission(request)
    }
}

/// The drivers every constructor opens before anything optional.
struct Drivers {
    exports: HashMap<String, PathBuf>,
    fs: FsDriver,
    pty: Arc<Pty>,
}

impl Service {
    pub fn open(config: &ClientConfig, pty: Pty) -> Result<Arc<Self>, FsError> {
        Self::open_with(config, pty, Screen::absent())
    }

    /// Like [`Service::open`], and also serves `agent.session` when terminals
    /// and an export are available to run CLI sessions in.
    pub fn open_with_agents(
        config: &ClientConfig,
        pty: Pty,
        options: AgentOptions,
    ) -> Result<Arc<Self>, OpenError> {
        Self::open_full(
            config,
            pty,
            (Screen::absent(), Input::absent(), Clipboard::absent()),
            Cdp::absent(),
            stream::local_address(),
            options,
        )
    }

    /// Screen capabilities are offered when a source exists, including before permission.
    pub fn open_with(
        config: &ClientConfig,
        pty: Pty,
        screen: Screen,
    ) -> Result<Arc<Self>, FsError> {
        Self::open_computer(config, pty, screen, Input::absent())
    }

    /// `input.write` is offered when screen and input drivers exist; serving
    /// still requires permission and a successful capture anchor.
    pub fn open_computer(
        config: &ClientConfig,
        pty: Pty,
        screen: Screen,
        input: Input,
    ) -> Result<Arc<Self>, FsError> {
        Self::open_cdp(config, pty, screen, input, Cdp::absent())
    }

    /// CDP channels ride `computer.use`: they open only when it is granted
    /// and `cdp` has a configured manifest.
    pub fn open_cdp(
        config: &ClientConfig,
        pty: Pty,
        screen: Screen,
        input: Input,
        cdp: Cdp,
    ) -> Result<Arc<Self>, FsError> {
        Self::open_stream(
            config,
            pty,
            (screen, input, Clipboard::local()),
            cdp,
            stream::local_address(),
        )
    }

    /// Screen streams ride `computer.use` and gather their host candidate
    /// on `address`; the clipboard rides `computer.use` too.
    pub fn open_stream(
        config: &ClientConfig,
        pty: Pty,
        desk: (Screen, Input, Clipboard),
        cdp: Cdp,
        address: std::net::IpAddr,
    ) -> Result<Arc<Self>, FsError> {
        let drivers = Self::open_drivers(config, pty)?;
        Ok(Self::assemble(
            config.machine_id.clone(),
            drivers,
            desk,
            cdp,
            address,
            None,
        ))
    }

    /// Everything the wire needs: the drivers plus the agent registry, which
    /// opens only after the filesystem driver so an unexportable config fails
    /// as `Fs` before any registry directory is created.
    pub(crate) fn open_full(
        config: &ClientConfig,
        pty: Pty,
        desk: (Screen, Input, Clipboard),
        cdp: Cdp,
        address: std::net::IpAddr,
        options: AgentOptions,
    ) -> Result<Arc<Self>, OpenError> {
        let drivers = Self::open_drivers(config, pty)?;
        let registry = Registry::open(&options.registry)?;
        Ok(Self::assemble(
            config.machine_id.clone(),
            drivers,
            desk,
            cdp,
            address,
            Some((registry, options)),
        ))
    }

    fn open_drivers(config: &ClientConfig, pty: Pty) -> Result<Drivers, FsError> {
        let exports: HashMap<String, PathBuf> = config
            .exports
            .iter()
            .map(|export| (export.name.clone(), PathBuf::from(&export.path)))
            .collect();
        let fs = FsDriver::open(exports.clone())?;
        Ok(Drivers {
            exports,
            fs,
            pty: Arc::new(pty),
        })
    }

    fn assemble(
        machine_id: String,
        Drivers { exports, fs, pty }: Drivers,
        (screen, input, clipboard): (Screen, Input, Clipboard),
        cdp: Cdp,
        address: std::net::IpAddr,
        agents: Option<(Registry, AgentOptions)>,
    ) -> Arc<Self> {
        let agents = agents.map(|(registry, options)| {
            let roots: Vec<PathBuf> = exports.values().cloned().collect();
            let launcher = Launcher::new(
                registry,
                PtySpawner::new(pty.clone(), roots.clone(), options.grace),
                Settings {
                    exports: roots,
                    home: options.home,
                    hook: options.hook,
                    ready: options.ready,
                    decide: options.decide.saturating_mul(2),
                },
            );
            Agents {
                launcher: RwLock::new(launcher),
                decide: options.decide,
            }
        });
        let mut offered = available(!exports.is_empty(), pty.offered());
        if agents.is_some() && pty.offered() && !exports.is_empty() {
            offered.push(AGENT_SESSION.to_owned());
        }
        if screen.available() {
            offered.extend([SCREEN_READ, COMPUTER_USE].map(str::to_owned));
        }
        if screen.available() && input.available() {
            offered.push(INPUT_WRITE.to_owned());
        }
        if Code::available() {
            offered.push(PYTHON_KERNEL.to_owned());
        }
        let tmux_socket = pty.socket().map(str::to_owned);
        Arc::new(Self {
            machine_id: machine_id.clone(),
            offered,
            exports,
            fs: Mutex::new(fs),
            exec: Exec::new(DEFAULT_DEADLINE),
            pty,
            grant: Mutex::new(None),
            agents,
            caller: Mutex::new(None),
            screen: Arc::new(screen),
            input: Arc::new(input),
            clipboard: Arc::new(clipboard),
            cdp,
            stream: Stream::new(address, machine_id.clone()),
            code: Code::with_socket(tmux_socket),
        })
    }

    pub fn capabilities(&self) -> &[String] {
        &self.offered
    }

    pub fn hooks(self: &Arc<Self>, heartbeat: Duration) -> Hooks {
        let service = self.clone();
        Hooks {
            service: handler(move |method, params| {
                let service = service.clone();
                async move { service.serve(&method, params.unwrap_or(Value::Null)).await }
            }),
            pressure: self.clone(),
            session: self.clone(),
            screen: self.screen.clone(),
            input: self.input.clone(),
            heartbeat,
        }
    }

    async fn serve(&self, method: &str, params: Value) -> Result<Value, String> {
        if method == "machine.ping" {
            return Ok(json!({"status":"alive"}));
        }
        let Ok(method) = serde_json::from_value(Value::String(method.to_owned())) else {
            return Err(invalid(method));
        };
        self.agent_dispatch(method, params).await
    }

    /// The `agent.*` methods; anything else falls through to the P3 machine methods.
    async fn agent_dispatch(&self, method: WireMethod, params: Value) -> Result<Value, String> {
        match method {
            WireMethod::MachineAppLaunch => {
                let request: oni_protocol::AppLaunchRequest = decode(params)?;
                let screen = self.screen.clone();
                self.capture(COMPUTER_USE, "permission_denied", move || {
                    crate::app::launch(&screen, &request)
                })
                .await
            }
            WireMethod::MachineAppQuit => {
                let request: oni_protocol::AppQuitRequest = decode(params)?;
                let screen = self.screen.clone();
                self.capture(COMPUTER_USE, "permission_denied", move || {
                    crate::app::quit(&screen, request.pid.get() as u32)
                })
                .await
            }
            WireMethod::MachineWindowClose => {
                let request: oni_protocol::WindowCloseRequest = decode(params)?;
                let target = crate::screen::observe::target(
                    request.target.pid.get(),
                    request.target.window_id,
                    Some(request.target.epoch),
                );
                let screen = self.screen.clone();
                self.capture(COMPUTER_USE, "permission_denied", move || {
                    crate::app::window(&screen, target, false)
                })
                .await
            }
            WireMethod::MachineWindowPark => {
                let request: oni_protocol::WindowParkRequest = decode(params)?;
                let target = crate::screen::observe::target(
                    request.target.pid.get(),
                    request.target.window_id,
                    Some(request.target.epoch),
                );
                let screen = self.screen.clone();
                self.capture(COMPUTER_USE, "permission_denied", move || {
                    crate::app::window(&screen, target, true)
                })
                .await
            }
            WireMethod::AgentSessionList => self.agent_list(decode(params)?).await,
            WireMethod::AgentSessionOpen => self.agent_open(decode(params)?).await,
            WireMethod::AgentSessionTail => self.agent_tail(decode(params)?).await,
            WireMethod::AgentSessionSend => {
                self.agent_send(decode(params)?).await.unwrap_or_else(Ok)
            }
            WireMethod::AgentSessionStop => {
                self.agent_stop(decode(params)?).await.unwrap_or_else(Ok)
            }
            other => self.machine_dispatch(other, params).await,
        }
    }

    /// The fs and exec methods; anything else falls through to the terminal methods.
    async fn machine_dispatch(&self, method: WireMethod, params: Value) -> Result<Value, String> {
        match method {
            WireMethod::MachineRunCode => {
                let request: CellRequest = decode(params)?;
                if !self.has(PYTHON_KERNEL) {
                    return Ok(refused("kernel_not_available"));
                }
                let caller = self.caller().clone().ok_or("machine_not_attached")?;
                self.code
                    .run(request, caller)
                    .await
                    .map_err(|error| error.to_string())
            }
            WireMethod::MachinePeekCode => {
                let request: PeekCode = decode(params)?;
                if !self.has(PYTHON_KERNEL) {
                    return Ok(refused("kernel_not_available"));
                }
                Ok(self.code.peek(&request.cell_id))
            }
            WireMethod::MachineCancelCode => {
                let request: CancelCode = decode(params)?;
                Ok(json!({"cancelled": self.code.stop(&request.cell_id)}))
            }
            WireMethod::MachineFsOp => decode(params).map(|request| self.fs_op(&request)),
            WireMethod::MachineFsStream => decode(params).map(|request| self.fs_stream(&request)),
            WireMethod::MachineExec => self.exec(&decode(params)?).await,
            other => self.terminal_dispatch(other, params).await,
        }
    }

    /// The `machine.pty.*` methods; anything else is not offered.
    async fn terminal_dispatch(&self, method: WireMethod, params: Value) -> Result<Value, String> {
        match method {
            WireMethod::MachinePtyOpen => {
                // The open request parses before the gate, the others inside it.
                let request: PtyOpenRequest = decode(params)?;
                let exports = self.export_paths();
                self.terminal(|| async { wire(self.pty.open(&request, &exports).await) })
                    .await
            }
            WireMethod::MachinePtyWrite => {
                self.terminal(|| async {
                    wire(self.pty.write(&decode::<PtyWriteRequest>(params)?).await)
                })
                .await
            }
            WireMethod::MachinePtyRead => self.terminal(|| self.pty_read(params)).await,
            WireMethod::MachinePtyResize => {
                self.terminal(|| async {
                    wire(self.pty.resize(&decode::<PtyResizeRequest>(params)?).await)
                })
                .await
            }
            WireMethod::MachinePtyClose => {
                self.terminal(|| async {
                    wire(self.pty.close(&decode::<PtyCloseRequest>(params)?).await)
                })
                .await
            }
            WireMethod::MachinePtyList => {
                self.terminal(|| async {
                    decode::<PtyListRequest>(params)?;
                    wire(self.pty.list().await)
                })
                .await
            }
            other => self.serve_computer(other, params).await,
        }
    }

    /// Answer a CLI hook's permission request with the attached host's
    /// verdict; anything but an explicit grant from the host is a refusal.
    pub async fn permission(&self, request: AgentPermissionRequest) -> AgentPermissionDecision {
        let Some(agents) = self.agents.as_ref().filter(|_| self.has(AGENT_SESSION)) else {
            return launcher::refused(&request, false);
        };
        let relay = HostRelay {
            caller: self.caller().clone(),
            deadline: agents.decide,
        };
        agents
            .launcher
            .read()
            .await
            .permission(&relay, request)
            .await
    }

    fn caller(&self) -> MutexGuard<'_, Option<Caller>> {
        self.caller.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn agent_gate(&self) -> Result<(&Agents, NonZeroU64), Value> {
        let generation = self
            .grant()
            .as_ref()
            .map(|grant| grant.generation)
            .ok_or_else(|| refused("machine_not_attached"))?;
        match &self.agents {
            Some(agents) if self.has(AGENT_SESSION) => Ok((agents, generation)),
            _ => Err(refused("session_not_available")),
        }
    }

    fn project(&self, path: &Path) -> Result<PathBuf, Value> {
        Registry::project(path, &self.export_paths()).map_err(|_| refused("session_not_available"))
    }

    async fn observed(&self, agents: &Agents, session_id: &str) -> Result<Observed, Value> {
        let session = agents
            .launcher
            .read()
            .await
            .registry()
            .by_id(session_id)
            .cloned()
            .ok_or_else(|| refused("session_not_found"))?;
        self.project(&session.project)?;
        Ok(session)
    }

    async fn agent_list(&self, request: AgentSessionListRequest) -> Result<Value, String> {
        let (agents, project) = match self.agent_gate().and_then(|(agents, _)| {
            Ok((agents, self.project(Path::new(request.project.as_str()))?))
        }) {
            Ok(found) => found,
            Err(refusal) => return Ok(refusal),
        };
        let launcher = agents.launcher.read().await;
        let sessions: Vec<Value> = launcher
            .registry()
            .sessions(&project)
            .map(|session| info(session, launcher.owns(session)))
            .collect();
        checked::<AgentSessionListResult>(json!({
            "status": "ok",
            "truncated": sessions.len() > MAX_SESSIONS,
            "sessions": &sessions[..sessions.len().min(MAX_SESSIONS)],
        }))
    }

    async fn agent_open(&self, request: AgentSessionOpenRequest) -> Result<Value, String> {
        let (agents, generation, project) =
            match self.agent_gate().and_then(|(agents, generation)| {
                Ok((
                    agents,
                    generation,
                    self.project(Path::new(request.project.as_str()))?,
                ))
            }) {
                Ok(found) => found,
                Err(refusal) => return Ok(refusal),
            };
        let dialect = manifest::select(&request.cli.to_string())
            .expect("wire CLI names are manifest dialects");
        let requested = request.session_id.as_ref().map(|id| id.as_str());
        let opened = agents
            .launcher
            .write()
            .await
            .start(&dialect, &project, requested)
            .await;
        match opened {
            Ok(opened) => checked::<AgentSessionOpenResult>(json!({
                "status": "ok",
                "cursor": cursor(&opened.session.session_id, generation, &tail::origin(&opened.session.session_id, generation.get())),
            })),
            Err(_) => Ok(refused("session_not_available")),
        }
    }

    async fn agent_tail(&self, request: AgentSessionTailRequest) -> Result<Value, String> {
        let (agents, generation) = match self.agent_gate() {
            Ok(gate) => gate,
            Err(refusal) => return Ok(refusal),
        };
        let (session_id, from) = match request {
            AgentSessionTailRequest::SessionId(id) => {
                (id.to_string(), tail::origin(&id, generation.get()))
            }
            AgentSessionTailRequest::Cursor {
                generation: minted, ..
            } if minted != generation => {
                return Ok(refused("invalid_cursor"));
            }
            AgentSessionTailRequest::Cursor {
                byte_offset,
                record_hash,
                session_id,
                ..
            } => (
                session_id.to_string(),
                Position {
                    byte_offset: u64::try_from(byte_offset).unwrap_or(u64::MAX),
                    record_hash: record_hash.to_string(),
                },
            ),
        };
        let session = match self.observed(agents, &session_id).await {
            Ok(session) => session,
            Err(refusal) => return Ok(refusal),
        };
        let Some(dialect) = manifest::select(&session.cli) else {
            return Ok(refused("session_not_available"));
        };
        match tail::read(
            &session.transcript,
            dialect.format,
            &from,
            &session_id,
            generation.get(),
        ) {
            Ok(page) => checked::<AgentSessionTailResult>(json!({
                "status": "ok",
                "records": page.records,
                "cursor": cursor(&session_id, generation, &page.position),
                "hasMore": page.has_more,
            })),
            Err(TailError::InvalidCursor) => Ok(refused("invalid_cursor")),
            Err(TailError::Io(_)) => Ok(refused("session_not_available")),
        }
    }

    /// `Err` carries the refusal the caller answers with.
    async fn agent_send(
        &self,
        request: AgentSessionSendRequest,
    ) -> Result<Result<Value, String>, Value> {
        let (agents, session) = self.owned(&request.session_id).await?;
        let sent = agents
            .launcher
            .read()
            .await
            .send(
                &session.project,
                &session.cli,
                &session.session_id,
                &request.text,
            )
            .await;
        Ok(checked::<AgentSessionSendResult>(sent.map_or_else(
            |_| refused("session_not_available"),
            |()| json!({"status": "ok"}),
        )))
    }

    /// `Err` carries the refusal the caller answers with.
    async fn agent_stop(
        &self,
        request: AgentSessionStopRequest,
    ) -> Result<Result<Value, String>, Value> {
        let (agents, session) = self.owned(&request.session_id).await?;
        let stopped = agents
            .launcher
            .write()
            .await
            .stop(&session.project, &session.cli, &session.session_id)
            .await;
        Ok(checked::<AgentSessionStopResult>(stopped.map_or_else(
            |_| refused("session_not_available"),
            |_| json!({"status": "ok"}),
        )))
    }

    async fn owned(&self, session_id: &str) -> Result<(&Agents, Observed), Value> {
        let (agents, _) = self.agent_gate()?;
        Ok((agents, self.observed(agents, session_id).await?))
    }

    fn grant(&self) -> MutexGuard<'_, Option<Grant>> {
        self.grant.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn fs(&self) -> MutexGuard<'_, FsDriver> {
        self.fs.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn has(&self, capability: &str) -> bool {
        self.offered.iter().any(|offered| offered == capability)
            && self.grant().as_ref().is_some_and(|grant| {
                grant
                    .capabilities
                    .iter()
                    .any(|granted| granted == capability)
            })
    }

    fn exported(&self, name: &str) -> bool {
        self.exports.contains_key(name)
            && self
                .grant()
                .as_ref()
                .is_some_and(|grant| grant.exports.iter().any(|export| export == name))
    }

    fn export_paths(&self) -> Vec<PathBuf> {
        self.grant()
            .as_ref()
            .map(|grant| {
                grant
                    .exports
                    .iter()
                    .filter_map(|name| self.exports.get(name).cloned())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn fs_gate(&self, capability: &str, export: &str) -> Option<Value> {
        if !self.has(capability) {
            return Some(fs_refused(
                "fs_not_available",
                format!("{capability} is not available"),
            ));
        }
        (!self.exported(export)).then(|| {
            fs_refused(
                "export_not_available",
                format!("export is not available: {export}"),
            )
        })
    }

    fn fs_op(&self, request: &FsRequest) -> Value {
        let (capability, export) = match request {
            FsRequest::Read { export, .. } => (FS_READ, export.as_str()),
            FsRequest::Write { export, .. } => (FS_WRITE, export.as_str()),
            FsRequest::List { export, .. } => (FS_READ, export.as_str()),
            FsRequest::Stat { export, .. } => (FS_READ, export.as_str()),
        };
        self.fs_gate(capability, export)
            .unwrap_or_else(|| value(self.fs().execute(request)))
    }

    /// Only `begin` is gated by capability and export: transfers never outlive
    /// the attachment that granted them (detach aborts them all).
    fn fs_stream(&self, request: &FsStreamRequest) -> Value {
        if self.grant().is_none() {
            return fs_refused("machine_not_attached", "machine is not attached".to_owned());
        }
        let refusal = match request {
            FsStreamRequest::Begin { export, mode, .. } => {
                let capability = match mode {
                    FsStreamRequestExclusiveMode::Read => FS_READ,
                    FsStreamRequestExclusiveMode::Write => FS_WRITE,
                };
                self.fs_gate(capability, export)
            }
            _ => None,
        };
        refusal.unwrap_or_else(|| value(self.fs().stream(request)))
    }

    async fn exec(&self, request: &ExecRequest) -> Result<Value, String> {
        if !self.has(SHELL_EXEC) {
            return Ok(refused("exec_not_available"));
        }
        let (_cancel, cancelled) = watch::channel(false);
        wire(
            self.exec
                .execute(request, &self.export_paths(), cancelled)
                .await,
        )
    }

    async fn terminal<F, Fut>(&self, body: F) -> Result<Value, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value, String>>,
    {
        if !self.has(PTY_SESSION) {
            return Ok(refused("pty_not_available"));
        }
        body().await
    }

    async fn pty_read(&self, params: Value) -> Result<Value, String> {
        if params.get("source").is_some() {
            wire(
                self.pty
                    .screen(&decode::<PtyReadScreenRequest>(params)?)
                    .await,
            )
        } else {
            wire(self.pty.read(&decode::<PtyReadRequest>(params)?).await)
        }
    }
}

impl Session for Service {
    fn connected(&self, caller: Caller) {
        *self.caller() = Some(caller);
    }

    fn attached(&self, negotiated: &Negotiated) {
        self.input.ledger().attach(negotiated.generation.get());
        *self.grant() = Some(Grant {
            generation: negotiated.generation,
            capabilities: negotiated.capabilities.clone(),
            exports: negotiated.exports.clone(),
        });
        if !self.has(COMPUTER_USE) {
            self.stream.fail_all();
            self.input.settle();
        }
    }

    fn detached(&self) {
        self.clipboard.close();
        self.input.ledger().cancel();
        self.code.detach();
        self.exec.detach();
        *self.grant() = None;
        *self.caller() = None;
        self.fs().abort_all();
        self.screen.release();
        self.screen.forget();
        self.input.settle();
        self.cdp.detach();
        self.stream.detach();
    }

    fn uplink(&self, uplink: Uplink) {
        self.cdp.uplink(uplink.clone());
        self.stream.uplink(uplink);
    }
}

impl Pressure for Service {
    fn retained(&self) -> Retained {
        Retained {
            pty_bytes: self.pty.retained(),
            transfers: self.fs().retained(),
            frame_bytes: self.screen.retained(),
            stream_bytes: self.stream.retained(),
        }
    }

    /// Aborts every open transfer and releases the largest terminal buffer.
    /// Also frees the idle screen frames and fails the retained streams.
    fn shed(&self) {
        self.fs().abort_all();
        self.pty.shed();
        self.screen.release();
        self.stream.fail_all();
    }

    fn streams(&self) -> Vec<Value> {
        self.stream.observations()
    }
}

impl Service {
    async fn publish_private_edges(&self) {
        let Some(caller) = self.caller().clone() else {
            return;
        };
        let screen = self.screen.clone();
        let Ok(Ok(edges)) = tokio::task::spawn_blocking(move || screen.private_edges()).await
        else {
            return;
        };
        for (target, edge, reason) in edges {
            let state = match edge {
                crate::screen::private::Edge::Entered => "entered",
                crate::screen::private::Edge::Left => "left",
            };
            let params = json!({
                "machineId": self.machine_id,
                "target": {
                    "pid": target.pid,
                    "windowId": target.window_id,
                    "epoch": target.epoch.unwrap_or(0),
                },
                "state": state,
                "reason": reason.name(),
            });
            let _ = caller
                .call_with_timeout(
                    "machine.event.private",
                    Some(params),
                    Duration::from_secs(5),
                )
                .await;
        }
    }

    /// Screen methods answer `machine_not_attached` before an attach and
    /// `unavailable` unless `capability` is offered and granted; the
    /// capture itself runs off the async workers.
    async fn capture<F>(
        &self,
        capability: &str,
        unavailable: &str,
        body: F,
    ) -> Result<Value, String>
    where
        F: FnOnce() -> Value + Send + 'static,
    {
        if self.grant().is_none() {
            return Ok(refused("machine_not_attached"));
        }
        if !self.has(capability) {
            return Ok(refused(unavailable));
        }
        tokio::task::spawn_blocking(body)
            .await
            .map_err(|error| error.to_string())
    }

    fn cdp_gate(&self) -> Option<Value> {
        if self.grant().is_none() {
            return Some(refused("machine_not_attached"));
        }
        (!self.has(COMPUTER_USE) || !self.cdp.available()).then(|| refused("cdp_not_available"))
    }

    pub fn cdp_channels(&self) -> usize {
        self.cdp.open_channels()
    }

    fn stream_gate(&self) -> Option<Value> {
        if self.grant().is_none() {
            return Some(refused("machine_not_attached"));
        }
        (!self.has(COMPUTER_USE)).then(|| refused("stream_not_available"))
    }

    pub fn open_streams(&self) -> usize {
        self.stream.open_streams()
    }

    /// Input methods answer `machine_not_attached` before an attach and
    /// `input_not_available` unless `capability` is offered and granted;
    /// planning and injection run off the async workers.
    async fn inject<F>(&self, capability: &str, body: F) -> Result<Value, String>
    where
        F: FnOnce() -> Value + Send + 'static,
    {
        if self.grant().is_none() {
            return Ok(refused("machine_not_attached"));
        }
        if !self.has(capability) {
            return Ok(refused("input_not_available"));
        }
        tokio::task::spawn_blocking(body)
            .await
            .map_err(|error| error.to_string())
    }
}

/// The computer-use family, routed outside `serve` so each family keeps
/// its own gate: screen frames, anchored input, the CDP tunnel and the
/// stream relay. Anything else is a method the host serves itself.
impl Service {
    async fn serve_computer(&self, method: WireMethod, params: Value) -> Result<Value, String> {
        match method {
            WireMethod::MachineComputerClose => {
                let request = decode(params)?;
                self.clipboard.close();
                Ok(crate::computer_close::serve_computer_close(
                    &self.input.ledger(),
                    &request,
                ))
            }
            WireMethod::MachineClipboardRead | WireMethod::MachineClipboardWrite => {
                self.serve_clipboard(method, params).await
            }
            WireMethod::MachineScreenList
            | WireMethod::MachineScreenCapture
            | WireMethod::MachineScreenRead
            | WireMethod::MachineScreenObserve => self.serve_screen(method, params).await,
            WireMethod::MachineScreenSettle => {
                let request: ScreenSettleRequest = decode(params)?;
                let screen = self.screen.clone();
                self.capture(COMPUTER_USE, "permission_denied", move || {
                    screen.settle(&request)
                })
                .await
            }
            WireMethod::MachineInputPointer
            | WireMethod::MachineInputKey
            | WireMethod::MachineInputText
            | WireMethod::MachineInputStatus
            | WireMethod::MachineInputWrite
            | WireMethod::MachineInputAction => self.serve_input(method, params).await,
            WireMethod::MachineCdpOpen
            | WireMethod::MachineCdpChunk
            | WireMethod::MachineCdpClose => self.serve_cdp(method, params).await,
            WireMethod::MachineStreamOpen
            | WireMethod::MachineStreamSignal
            | WireMethod::MachineStreamClose => self.serve_stream(method, params).await,
            host_served => Err(invalid(host_served)),
        }
    }

    /// Reads refuse while the focused window is private, exactly like
    /// injected input; a change the human made since the last look is
    /// reported to the host once the answer is known.
    async fn serve_clipboard(&self, method: WireMethod, params: Value) -> Result<Value, String> {
        let clipboard = self.clipboard.clone();
        let unavailable = "clipboard_not_available";
        let answer = if method == WireMethod::MachineClipboardRead {
            let request: ClipboardReadRequest = decode(params)?;
            if self.grant().is_some() && self.has(COMPUTER_USE) {
                self.publish_private_edges().await;
                let screen = self.screen.clone();
                let private = tokio::task::spawn_blocking(move || screen.input_private(None)).await;
                if !matches!(private, Ok(Ok(false))) {
                    return Ok(refused("private"));
                }
            }
            self.capture(COMPUTER_USE, unavailable, move || clipboard.read(&request))
                .await?
        } else {
            let request: ClipboardWriteRequest = decode(params)?;
            self.capture(COMPUTER_USE, unavailable, move || clipboard.write(&request))
                .await?
        };
        if self.clipboard.take_human_edge() {
            let caller = self.caller().clone();
            if let Some(caller) = caller {
                let params = json!({
                    "machineId": self.machine_id,
                    "at": crate::attach::now_ms(),
                    "source": "clipboard",
                });
                let _ = caller
                    .notify("machine.event.human_input", Some(params))
                    .await;
            }
        }
        Ok(answer)
    }

    async fn serve_screen(&self, method: WireMethod, params: Value) -> Result<Value, String> {
        let screen = self.screen.clone();
        let unavailable = "screen_not_available";
        if method == WireMethod::MachineScreenList {
            let request: ScreenListRequest = decode(params)?;
            if self.grant().is_some() && self.has(COMPUTER_USE) {
                self.publish_private_edges().await;
            }
            self.capture(COMPUTER_USE, unavailable, move || screen.list(&request))
                .await
        } else if method == WireMethod::MachineScreenCapture {
            let request: ScreenCaptureRequest = decode(params)?;
            if self.grant().is_some() && self.has(COMPUTER_USE) {
                self.publish_private_edges().await;
            }
            self.capture(COMPUTER_USE, unavailable, move || screen.capture(&request))
                .await
        } else if method == WireMethod::MachineScreenObserve {
            let request: ScreenObserveRequest = decode(params)?;
            if self.grant().is_some() && self.has(COMPUTER_USE) {
                self.publish_private_edges().await;
            }
            self.capture(COMPUTER_USE, "observe_not_available", move || {
                screen.observe(&request)
            })
            .await
        } else {
            let request: ScreenReadRequest = decode(params)?;
            if self.grant().is_some() && self.has(SCREEN_READ) {
                self.publish_private_edges().await;
            }
            self.capture(SCREEN_READ, unavailable, move || screen.read(&request))
                .await
        }
    }

    async fn serve_input(&self, method: WireMethod, params: Value) -> Result<Value, String> {
        let (screen, input) = (self.screen.clone(), self.input.clone());
        if method == WireMethod::MachineInputStatus {
            let request: InputStatusRequest = decode(params)?;
            return Ok(if self.has(COMPUTER_USE) {
                input.ledger().status(&request.request_id)
            } else {
                refused("request_unknown")
            });
        }
        if method == WireMethod::MachineInputPointer {
            let request: InputPointerRequest = decode(params)?;
            if self.grant().is_some() && self.has(COMPUTER_USE) {
                self.publish_private_edges().await;
            }
            let request_id = match &request {
                InputPointerRequest::Move { request_id, .. } => request_id.to_string(),
                InputPointerRequest::Click { request_id, .. } => request_id.to_string(),
                InputPointerRequest::Button { request_id, .. } => request_id.to_string(),
                InputPointerRequest::Scroll { request_id, .. } => request_id.to_string(),
            };
            self.inject(COMPUTER_USE, move || {
                let ledger = input.ledger();
                let entry = match ledger.start(&request_id) {
                    Ok(entry) => entry,
                    Err(refusal) => return refusal,
                };
                let _completion = Completion(entry.clone());
                input.pointer_guarded(&screen, &request, Some(&entry))
            })
            .await
        } else if method == WireMethod::MachineInputKey {
            let request: InputKeyRequest = decode(params)?;
            if self.grant().is_some() && self.has(COMPUTER_USE) {
                self.publish_private_edges().await;
            }
            self.inject(COMPUTER_USE, move || {
                let ledger = input.ledger();
                let entry = match ledger.start(&request.request_id) {
                    Ok(entry) => entry,
                    Err(refusal) => return refusal,
                };
                let _completion = Completion(entry.clone());
                input.key_guarded(&screen, &request, Some(&entry))
            })
            .await
        } else if method == WireMethod::MachineInputText {
            let request: InputTextRequest = decode(params)?;
            if self.grant().is_some() && self.has(COMPUTER_USE) {
                self.publish_private_edges().await;
            }
            self.inject(COMPUTER_USE, move || {
                let ledger = input.ledger();
                let entry = match ledger.start(&request.request_id) {
                    Ok(entry) => entry,
                    Err(refusal) => return refusal,
                };
                let _completion = Completion(entry.clone());
                input.text_guarded(&screen, &request, Some(&entry))
            })
            .await
        } else if method == WireMethod::MachineInputAction {
            let request: InputActionRequest = decode(params)?;
            let act = action::parse(&request)?;
            if self.grant().is_some() && self.has(COMPUTER_USE) {
                self.publish_private_edges().await;
            }
            self.inject(COMPUTER_USE, move || {
                let ledger = input.ledger();
                let entry = match ledger.start(&request.request_id) {
                    Ok(entry) => entry,
                    Err(refusal) => return refusal,
                };
                let _completion = Completion(entry.clone());
                if entry.before_event(ledger.current()) {
                    action::serve_action_guarded(&screen, &act, &entry, &ledger)
                } else {
                    entry.cancelled_result()
                }
            })
            .await
        } else {
            let request: InputWriteRequest = decode(params)?;
            if self.grant().is_some() && self.has(INPUT_WRITE) {
                self.publish_private_edges().await;
            }
            self.inject(INPUT_WRITE, move || input.write(&screen, &request))
                .await
        }
    }

    async fn serve_cdp(&self, method: WireMethod, params: Value) -> Result<Value, String> {
        if method == WireMethod::MachineCdpOpen {
            let request: CdpOpenRequest = decode(params)?;
            return Ok(match self.cdp_gate() {
                Some(refusal) => refusal,
                None => self.cdp.open(&request).await,
            });
        }
        let attached = self.grant().is_some();
        if method == WireMethod::MachineCdpChunk {
            let request: CdpChunk = decode(params)?;
            if !attached {
                return Ok(refused("machine_not_attached"));
            }
            return self.cdp.chunk(&request).await;
        }
        let request: CdpCloseRequest = decode(params)?;
        if !attached {
            return Ok(refused("machine_not_attached"));
        }
        Ok(self.cdp.close(&request).await)
    }

    async fn serve_stream(&self, method: WireMethod, params: Value) -> Result<Value, String> {
        if method == WireMethod::MachineStreamOpen {
            let request: StreamOpenRequest = decode(params)?;
            return Ok(match self.stream_gate() {
                Some(refusal) => refusal,
                None => self.stream.open(&request, &self.screen).await,
            });
        }
        let attached = self.grant().is_some();
        if method == WireMethod::MachineStreamSignal {
            let request: StreamSignalRequest = decode(params)?;
            if !attached {
                return Ok(refused("machine_not_attached"));
            }
            return Ok(self.stream.signal(&request).await);
        }
        let request: StreamCloseRequest = decode(params)?;
        if !attached {
            return Ok(refused("machine_not_attached"));
        }
        Ok(self.stream.close(&request))
    }
}

#[cfg(test)]
mod private_tests {
    use super::*;
    use crate::{
        screen::{
            ax::{self, fixture::Scripted, Observer},
            fixture::Fixture,
            Fault,
        },
        transport::{
            client::Client,
            framing::{self, Framed},
        },
    };

    struct PanicWindows;

    impl ax::Observer for PanicWindows {
        fn windows(&self) -> Result<Vec<ax::WindowIdentity>, Fault> {
            panic!("observer crashed while listing windows")
        }

        fn walk(&self, _: &ax::WindowIdentity, _: &ax::Bounds) -> Result<ax::Walk, Fault> {
            Err(Fault::Absent)
        }

        fn focused(
            &self,
            _: &ax::WindowIdentity,
        ) -> Result<Option<crate::screen::private::Focused>, Fault> {
            Err(Fault::Absent)
        }

        fn act(
            &self,
            _: &ax::WindowIdentity,
            _: &[ax::Segment],
            _: ax::Admit<'_>,
            _: &ax::Action,
        ) -> Result<(), ax::ActFault> {
            Err(ax::ActFault::Unsupported)
        }
    }

    #[test]
    fn panicking_observer_refuses_every_other_call() {
        let observer = PanicWindows;
        let window = ax::WindowIdentity {
            pid: 7,
            window_id: 9,
            owner_pid: 7,
            title: "Editor".into(),
            app: ax::fixture::fixture_app(7),
            token: 0,
            origin: (0, 0),
            minimized: false,
        };
        let bounds = ax::Bounds {
            max_elements: 1,
            max_visits: 1,
            budget: Duration::from_secs(1),
        };

        assert_eq!(observer.walk(&window, &bounds), Err(Fault::Absent));
        assert_eq!(observer.focused(&window), Err(Fault::Absent));
        assert_eq!(
            observer.act(&window, &[], &|_| true, &ax::Action::Press),
            Err(ax::ActFault::Unsupported)
        );
    }

    async fn service_with_observer(observer: Box<dyn ax::Observer>) -> Arc<Service> {
        let config = ClientConfig {
            machine_id: "laptop".into(),
            name: "Laptop".into(),
            host: "127.0.0.1:7643".into(),
            tags: vec![],
            exports: vec![],
            memory_budget_mb: 96,
            unix: None,
            tmux_socket: None,
        };
        let pty = Pty::new("/definitely/missing/tmux", None, "g".into()).await;
        let screen = Screen::new(Box::new(Fixture::display(32, 16, 1.0)), 1).observing(observer);
        let service = Service::open_with(&config, pty, screen).expect("service");
        let (client, host) = tokio::io::duplex(4096);
        let client = Client::from_stream(client, handler(|_, _| async { Ok(Value::Null) }));
        service.connected(client.caller());
        let (reader, mut writer) = tokio::io::split(host);
        framing::write_frame(
            &mut writer,
            &json!({"v":2,"type":"request","id":"probe","method":"machine.ping","params":{}}),
        )
        .await
        .expect("probe written");
        assert_eq!(
            Framed::new(reader)
                .next()
                .await
                .expect("probe response")
                .expect("frame")["result"],
            Value::Null
        );
        service
    }

    #[tokio::test]
    async fn private_edge_without_caller_never_queries_observer() {
        let service = service_with_observer(Box::new(PanicWindows)).await;
        *service.caller() = None;
        service.publish_private_edges().await;
    }

    #[tokio::test]
    async fn private_edge_observer_failure_does_not_publish() {
        let directory = tempfile::tempdir().expect("directory");
        let service = service_with_observer(Box::new(Scripted {
            layout: directory.path().join("missing.json"),
            recorder: directory.path().join("recorder.jsonl"),
        }))
        .await;
        service.publish_private_edges().await;
    }

    #[tokio::test]
    async fn private_edge_worker_panic_does_not_publish() {
        let service = service_with_observer(Box::new(PanicWindows)).await;
        service.publish_private_edges().await;
    }

    #[tokio::test]
    async fn publishes_private_window_entry_and_exit_with_exact_target() {
        let directory = tempfile::tempdir().expect("directory");
        let layout = directory.path().join("layout.json");
        let row = |secure| {
            json!({
                "windows":[{"id":9,"pid":7,"title":"Editor","elements":[{
                    "role":"AXTextField","secure":secure,"focused":true,
                    "frame":{"x":0,"y":0,"width":16,"height":16}
                }]}]
            })
        };
        std::fs::write(&layout, row(true).to_string()).expect("layout");
        let screen =
            Screen::new(Box::new(Fixture::display(32, 16, 1.0)), 1).observing(Box::new(Scripted {
                layout: layout.clone(),
                recorder: directory.path().join("recorder.jsonl"),
            }));
        let config = ClientConfig {
            machine_id: "laptop".into(),
            name: "Laptop".into(),
            host: "127.0.0.1:7643".into(),
            tags: vec![],
            exports: vec![],
            memory_budget_mb: 96,
            unix: None,
            tmux_socket: None,
        };
        let pty = Pty::new("/definitely/missing/tmux", None, "g".into()).await;
        let service = Service::open_with(&config, pty, screen).expect("service");
        let (client, host) = tokio::io::duplex(4096);
        let client = Client::from_stream(client, handler(|_, _| async { Ok(Value::Null) }));
        service.connected(client.caller());
        let (reader, mut writer) = tokio::io::split(host);
        let mut frames = Framed::new(reader);
        framing::write_frame(
            &mut writer,
            &json!({"v":2,"type":"request","id":"probe","method":"machine.ping","params":{}}),
        )
        .await
        .expect("probe written");
        assert_eq!(
            frames.next().await.expect("probe response").expect("frame")["result"],
            Value::Null
        );
        for (secure, state) in [(true, "entered"), (false, "left")] {
            std::fs::write(&layout, row(secure).to_string()).expect("focus");
            let publish = service.publish_private_edges();
            let respond = async {
                let call = frames.next().await.expect("frame").expect("request");
                assert_eq!(call["method"], "machine.event.private");
                assert_eq!(
                    call["params"],
                    json!({
                        "machineId":"laptop",
                        "target":{"pid":7,"windowId":9,"epoch":0},
                        "state":state,
                        "reason":"secure_focus",
                    })
                );
                framing::write_frame(
                    &mut writer,
                    &json!({
                        "v":2,"type":"response","id":call["id"],
                        "result":{"status":"accepted"}
                    }),
                )
                .await
                .expect("reply");
            };
            let ((), ()) = tokio::join!(publish, respond);
        }
    }
}
