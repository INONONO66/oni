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
    AgentSessionTailRequest, AgentSessionTailResult, CancelCode, CellRequest, ExecRequest,
    FsRequest, FsStreamRequest, InputWriteRequest, PeekCode, PtyCloseRequest, PtyListRequest,
    PtyOpenRequest, PtyReadRequest, PtyReadScreenRequest, PtyResizeRequest, PtyWriteRequest,
    ScreenReadRequest, WireMethod, WireRoot,
};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{watch, RwLock};

use crate::{
    agent::{
        launcher::{self, HookTarget, Launcher, PermissionRelay, PtySpawner, Settings},
        manifest,
        registry::{Registry, RegistryError, Session as Observed},
        tail::{self, Position, TailError},
    },
    attach::{Hooks, Negotiated, Session},
    budget::{Pressure, Retained},
    config::ClientConfig,
    exec::{Exec, DEFAULT_DEADLINE},
    fs::{FsDriver, FsError},
    pty::ops::Pty,
    transport::{
        client::{handler, Caller},
        request_table::CallError,
    },
};

const FS_READ: &str = "fs.read";
const FS_WRITE: &str = "fs.write";
const SHELL_EXEC: &str = "shell.exec";
const PTY_SESSION: &str = "pty.session";
const AGENT_SESSION: &str = "agent.session";
const MAX_SESSIONS: usize = 256;

/// Every capability this client can serve; the enrollment receipt allows all
/// of them so a later attach can offer whatever is available by then.
pub const SUPPORTED: [&str; 5] = [FS_READ, FS_WRITE, SHELL_EXEC, PTY_SESSION, AGENT_SESSION];

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
    offered: Vec<String>,
    exports: HashMap<String, PathBuf>,
    fs: Mutex<FsDriver>,
    exec: Exec,
    pty: Arc<Pty>,
    grant: Mutex<Option<Grant>>,
    agents: Option<Agents>,
    caller: Mutex<Option<Caller>>,
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

/// Methods this client never offers: no code runner, screen or input driver.
/// `cancel_code` answers like a daemon without a runner: nothing to cancel.
fn unoffered(method: WireMethod, params: Value) -> Result<Value, String> {
    match method {
        WireMethod::MachineRunCode => {
            decode::<CellRequest>(params).map(|_| refused("kernel_not_available"))
        }
        WireMethod::MachinePeekCode => {
            decode::<PeekCode>(params).map(|_| refused("kernel_not_available"))
        }
        WireMethod::MachineCancelCode => {
            decode::<CancelCode>(params).map(|_| json!({"cancelled": false}))
        }
        WireMethod::MachineScreenRead => {
            decode::<ScreenReadRequest>(params).map(|_| refused("screen_not_available"))
        }
        WireMethod::MachineInputWrite => {
            decode::<InputWriteRequest>(params).map(|_| refused("input_not_available"))
        }
        host_served => Err(invalid(host_served)),
    }
}

impl crate::agent::hook::Decide for Service {
    fn decide(
        &self,
        request: AgentPermissionRequest,
    ) -> impl Future<Output = AgentPermissionDecision> + Send {
        self.permission(request)
    }
}

impl Service {
    pub fn open(config: &ClientConfig, pty: Pty) -> Result<Arc<Self>, FsError> {
        let exports = Self::configured(config);
        let fs = FsDriver::open(exports.clone())?;
        Ok(Arc::new(Self::build(exports, fs, Arc::new(pty), None)))
    }

    /// Like [`Service::open`], and also serves `agent.session` when terminals
    /// and an export are available to run CLI sessions in.
    pub fn open_with_agents(
        config: &ClientConfig,
        pty: Pty,
        options: AgentOptions,
    ) -> Result<Arc<Self>, OpenError> {
        let exports = Self::configured(config);
        let fs = FsDriver::open(exports.clone())?;
        let pty = Arc::new(pty);
        let roots: Vec<PathBuf> = exports.values().cloned().collect();
        let launcher = Launcher::new(
            Registry::open(&options.registry)?,
            PtySpawner::new(pty.clone(), roots.clone(), options.grace),
            Settings {
                exports: roots,
                home: options.home,
                hook: options.hook,
                ready: options.ready,
                decide: options.decide.saturating_mul(2),
            },
        );
        let agents = Agents {
            launcher: RwLock::new(launcher),
            decide: options.decide,
        };
        let mut service = Self::build(exports, fs, pty, Some(agents));
        if service.pty.offered() && !service.exports.is_empty() {
            service.offered.push(AGENT_SESSION.to_owned());
        }
        Ok(Arc::new(service))
    }

    fn configured(config: &ClientConfig) -> HashMap<String, PathBuf> {
        config
            .exports
            .iter()
            .map(|export| (export.name.clone(), PathBuf::from(&export.path)))
            .collect()
    }

    fn build(
        exports: HashMap<String, PathBuf>,
        fs: FsDriver,
        pty: Arc<Pty>,
        agents: Option<Agents>,
    ) -> Self {
        Self {
            offered: available(!exports.is_empty(), pty.offered()),
            exports,
            fs: Mutex::new(fs),
            exec: Exec::new(DEFAULT_DEADLINE),
            pty,
            grant: Mutex::new(None),
            agents,
            caller: Mutex::new(None),
        }
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
            heartbeat,
        }
    }

    async fn serve(&self, method: &str, params: Value) -> Result<Value, String> {
        let Ok(method) = serde_json::from_value(Value::String(method.to_owned())) else {
            return Err(invalid(method));
        };
        self.agent_dispatch(method, params).await
    }

    /// The `agent.*` methods; anything else falls through to the P3 machine methods.
    async fn agent_dispatch(&self, method: WireMethod, params: Value) -> Result<Value, String> {
        match method {
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
            other => unoffered(other, params),
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
        *self.grant() = Some(Grant {
            generation: negotiated.generation,
            capabilities: negotiated.capabilities.clone(),
            exports: negotiated.exports.clone(),
        });
    }

    fn detached(&self) {
        *self.grant() = None;
        *self.caller() = None;
        self.fs().abort_all();
    }
}

impl Pressure for Service {
    fn retained(&self) -> Retained {
        Retained {
            pty_bytes: self.pty.retained(),
            transfers: self.fs().retained(),
        }
    }

    /// Aborts every open transfer and releases the largest terminal buffer.
    fn shed(&self) {
        self.fs().abort_all();
        self.pty.shed();
    }
}
