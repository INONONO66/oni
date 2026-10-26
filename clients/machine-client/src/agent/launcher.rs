//! Vendor-free CLI session lifecycle. Every CLI-specific argv, hook, and
//! transcript path comes from a [`Cli`]; processes come from a
//! [`ProcessSpawner`]; permission verdicts come from a [`PermissionRelay`].

use std::{
    collections::{BTreeMap, HashSet},
    fs,
    future::Future,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use nix::{
    sys::signal::{kill, Signal},
    unistd::Pid,
};
use oni_protocol::{AgentPermissionDecision, AgentPermissionRequest, WireRoot};
use serde::Serialize;
use serde_json::{json, Value};

use super::registry::{Registry, RegistryError, Session};
use crate::pty::ops::{Pty, PtyError};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Permission {
    /// The CLI raises a hook the client answers through the relay.
    Hook,
    /// The CLI only prompts in its own terminal; the relay is never raised.
    CliPrompt,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HookTarget {
    pub program: PathBuf,
    pub modules: PathBuf,
    /// The socket the running client answers permission requests on; every
    /// launch carries it in [`crate::config::AGENT_HOOK_SOCKET_VARIABLE`].
    pub socket: PathBuf,
}

impl HookTarget {
    pub fn current() -> io::Result<Self> {
        Ok(Self {
            program: std::env::current_exe()?,
            modules: crate::config::agent_hook_directory(),
            socket: crate::config::agent_hook_socket(),
        })
    }
}

pub struct LaunchContext<'a> {
    pub session_id: Option<&'a str>,
    pub hook: &'a HookTarget,
}

/// The one permission module every script-hook dialect loads; it asks
/// `$ONI_MCLIENT hook permission --cli $ONI_MCLIENT_CLI` before every tool
/// call and blocks unless that exits 0.
pub const PERMISSION_MODULE: &str = include_str!("permission.ts");
pub const PERMISSION_FILE: &str = "permission.ts";
/// The variable the permission module reads the client executable from.
pub const PROGRAM_VARIABLE: &str = "ONI_MCLIENT";
/// The variable the permission module reads its `--cli` selector from.
pub const CLI_VARIABLE: &str = "ONI_MCLIENT_CLI";

impl LaunchContext<'_> {
    /// Launch `executable` loading the shared permission module through
    /// `flag`, with `cli` as the module's `--cli` selector.
    pub fn script_hook(&self, cli: &str, executable: &str, flag: &str) -> LaunchCommand {
        let module = self.hook.modules.join(PERMISSION_FILE);
        LaunchCommand {
            executable: executable.to_owned(),
            args: vec![flag.to_owned(), module.to_string_lossy().into_owned()],
            env: vec![
                (
                    PROGRAM_VARIABLE.to_owned(),
                    self.hook.program.to_string_lossy().into_owned(),
                ),
                (CLI_VARIABLE.to_owned(), cli.to_owned()),
            ],
            requires: Some(HookModule {
                path: module,
                source: PERMISSION_MODULE,
            }),
        }
    }
}

/// A hook module the CLI loads, with the embedded source installed when the
/// file is absent or differs from it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HookModule {
    pub path: PathBuf,
    pub source: &'static str,
}

impl HookModule {
    /// Ensure the file holds exactly the embedded source: an absent, stale or
    /// foreign copy is replaced atomically through a private temporary file
    /// renamed into place, so path existence never stands in for the hook.
    pub fn install(&self) -> io::Result<()> {
        if fs::read(&self.path).is_ok_and(|bytes| bytes == self.source.as_bytes()) {
            return Ok(());
        }
        let directory = self.path.parent().unwrap_or(Path::new("/"));
        fs::create_dir_all(directory)?;
        let staging = directory.join(format!(".install-{}-{}", std::process::id(), mint()?));
        crate::config::write_private(&staging, self.source.as_bytes())?;
        fs::rename(&staging, &self.path)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// A hook module the CLI loads; launching without it would leave tool
    /// calls unintercepted, so its absence refuses the launch.
    pub requires: Option<HookModule>,
}

pub trait Cli {
    fn name(&self) -> &'static str;
    fn permission(&self) -> Permission;
    fn assigns_id(&self) -> bool;
    fn command(&self, context: &LaunchContext<'_>) -> LaunchCommand;
    fn transcripts(&self, home: &Path, project: &Path) -> PathBuf;
    fn session_id(&self, transcript: &Path) -> Option<String>;
    fn belongs(&self, transcript: &Path, project: &Path) -> bool;
}

pub trait ProcessSpawner {
    type Handle: Send;

    fn launch(
        &self,
        project: &Path,
        command: &LaunchCommand,
    ) -> impl Future<Output = io::Result<Self::Handle>> + Send;
    fn terminal(&self, handle: &Self::Handle) -> String;
    /// Wait for the process to show progress; `false` once `deadline` passes.
    fn changed(
        &self,
        handle: &mut Self::Handle,
        deadline: Instant,
    ) -> impl Future<Output = io::Result<bool>> + Send;
    fn send(
        &self,
        handle: &Self::Handle,
        text: &str,
    ) -> impl Future<Output = io::Result<()>> + Send;
    fn stop(&self, handle: Self::Handle) -> impl Future<Output = io::Result<()>> + Send;
    /// Re-own a terminal this client launched before a restart, only if it
    /// is observed live now.
    fn reclaim(
        &self,
        terminal: &str,
    ) -> impl Future<Output = io::Result<Option<Self::Handle>>> + Send;
}

/// Implementations deny on any transport or decoding error.
pub trait PermissionRelay {
    fn decide(
        &self,
        request: AgentPermissionRequest,
    ) -> impl Future<Output = AgentPermissionDecision> + Send;
}

#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    #[error(transparent)]
    Registry(#[from] RegistryError),
    #[error("CLI session I/O: {0}")]
    Io(#[from] io::Error),
    #[error("session is not owned by this client")]
    NotOwned,
    #[error("session_not_available")]
    SessionNotAvailable,
    /// The module is absent or differs from the embedded source and could
    /// not be replaced with it.
    #[error("permission hook module unavailable: {0}")]
    HookUnavailable(PathBuf),
}

pub fn refused(request: &AgentPermissionRequest, timeout: bool) -> AgentPermissionDecision {
    oni_protocol::decode(json!({
        "status": "refused",
        "sessionId": request.session_id.as_str(),
        "requestId": request.request_id.as_str(),
        "reason": if timeout { "timeout" } else { "denied" },
    }))
    .expect("generated refusal matches the wire schema")
}

/// Keep the relay's verdict only when it answers exactly this request.
#[must_use]
pub fn correlate(
    request: &AgentPermissionRequest,
    decision: AgentPermissionDecision,
) -> AgentPermissionDecision {
    let (session_id, request_id) = match &decision {
        AgentPermissionDecision::Allowed {
            request_id,
            session_id,
        } => (session_id.as_str(), request_id.as_str()),
        AgentPermissionDecision::Refused {
            request_id,
            session_id,
            ..
        } => (session_id.as_str(), request_id.as_str()),
    };
    if session_id == request.session_id.as_str() && request_id == request.request_id.as_str() {
        decision
    } else {
        refused(request, false)
    }
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn mint() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

struct Found {
    id: String,
    path: PathBuf,
    modified: SystemTime,
}

fn discover(cli: &impl Cli, home: &Path, project: &Path) -> Vec<Found> {
    let mut found = Vec::new();
    let mut pending = vec![(cli.transcripts(home, project), 0)];
    while let Some((directory, depth)) = pending.pop() {
        let entries = fs::read_dir(&directory).into_iter().flatten().flatten();
        for (path, meta) in entries.filter_map(|entry| Some((entry.path(), entry.metadata().ok()?)))
        {
            if meta.is_dir() {
                pending.extend((depth < 4).then_some((path, depth + 1)));
            } else if path.extension().is_some_and(|ext| ext == "jsonl")
                && cli.belongs(&path, project)
            {
                found.extend(
                    cli.session_id(&path)
                        .zip(meta.modified().ok())
                        .map(|(id, modified)| Found { id, path, modified }),
                );
            }
        }
    }
    found
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Opened {
    pub session: Session,
    pub owned: bool,
    pub launched: bool,
}

pub struct Settings {
    pub exports: Vec<PathBuf>,
    pub home: PathBuf,
    pub hook: HookTarget,
    pub ready: Duration,
    pub decide: Duration,
}

type Key = (PathBuf, String, String);

struct Owned<H> {
    handle: H,
    session: Session,
    permission: Permission,
}

pub struct Launcher<P: ProcessSpawner> {
    registry: Registry,
    spawner: P,
    settings: Settings,
    owned: BTreeMap<Key, Owned<P::Handle>>,
    /// Processes spawned but not yet persisted and owned. A launch whose
    /// future is dropped leaves its process here; the next open stops it.
    launching: Vec<P::Handle>,
}

fn key(project: PathBuf, cli: &str, session_id: &str) -> Key {
    (project, cli.to_owned(), session_id.to_owned())
}

impl<P: ProcessSpawner> Launcher<P> {
    pub fn new(registry: Registry, spawner: P, settings: Settings) -> Self {
        Self {
            registry,
            spawner,
            settings,
            owned: BTreeMap::new(),
            launching: Vec::new(),
        }
    }

    /// Whether this client currently owns the session's process.
    pub fn owns(&self, session: &Session) -> bool {
        self.owned.contains_key(&key(
            session.project.clone(),
            &session.cli,
            &session.session_id,
        ))
    }

    /// Stop every process an abandoned launch left behind.
    async fn reap(&mut self) -> Result<(), LaunchError> {
        while let Some(handle) = self.launching.pop() {
            self.spawner.stop(handle).await?;
        }
        Ok(())
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    pub fn spawner(&self) -> &P {
        &self.spawner
    }

    fn confine(&self, project: &Path) -> Result<PathBuf, LaunchError> {
        Ok(Registry::project(project, &self.settings.exports)?)
    }

    /// Adopt an owned, reclaimable, or discovered session; launch only when
    /// none matches.
    pub async fn start(
        &mut self,
        cli: &impl Cli,
        project: &Path,
        requested: Option<&str>,
    ) -> Result<Opened, LaunchError> {
        let project = self.confine(project)?;
        self.reap().await?;
        if let Some(opened) = self.existing(cli, &project, requested).await? {
            return Ok(opened);
        }
        if requested.is_some() && !cli.assigns_id() {
            return Err(LaunchError::SessionNotAvailable);
        }
        self.launch(cli, project, requested).await
    }

    /// Adopt an existing session; never launches.
    pub async fn attach(
        &mut self,
        cli: &impl Cli,
        project: &Path,
        session_id: &str,
    ) -> Result<Opened, LaunchError> {
        let project = self.confine(project)?;
        self.existing(cli, &project, Some(session_id))
            .await?
            .ok_or(LaunchError::SessionNotAvailable)
    }

    async fn existing(
        &mut self,
        cli: &impl Cli,
        project: &Path,
        requested: Option<&str>,
    ) -> Result<Option<Opened>, LaunchError> {
        let wanted = |session: &Session| {
            session.project == project
                && session.cli == cli.name()
                && requested.is_none_or(|id| session.session_id == id)
        };
        let held: Vec<Session> = self
            .owned
            .values()
            .filter(|owned| wanted(&owned.session))
            .map(|owned| owned.session.clone())
            .collect();
        for session in held {
            // Re-observe the terminal: a process that exited or was closed
            // outside this client is no longer owned.
            let terminal = session.terminal.clone().unwrap_or_default();
            if self.spawner.reclaim(&terminal).await?.is_some() {
                return Ok(Some(Opened {
                    session,
                    owned: true,
                    launched: false,
                }));
            }
            self.owned.remove(&key(
                session.project.clone(),
                &session.cli,
                &session.session_id,
            ));
            self.registry.observe(Session {
                terminal: None,
                ..session
            })?;
        }
        let saved: Vec<(Session, String)> = self
            .registry
            .sessions(project)
            .filter(|session| wanted(session))
            .filter_map(|session| Some((session.clone(), session.terminal.clone()?)))
            .collect();
        for (session, terminal) in saved {
            if let Some(handle) = self.spawner.reclaim(&terminal).await? {
                self.own(cli, session.clone(), handle);
                return Ok(Some(Opened {
                    session,
                    owned: true,
                    launched: false,
                }));
            }
            self.registry.observe(Session {
                terminal: None,
                ..session
            })?;
        }
        let Some(id) = requested else {
            return Ok(None);
        };
        let Some(found) = discover(cli, &self.settings.home, project)
            .into_iter()
            .find(|found| found.id == id)
        else {
            return Ok(None);
        };
        let session = Session {
            project: project.to_owned(),
            cli: cli.name().to_owned(),
            session_id: found.id,
            transcript: found.path,
            terminal: None,
        };
        self.registry.observe(session.clone())?;
        Ok(Some(Opened {
            session,
            owned: false,
            launched: false,
        }))
    }

    fn own(&mut self, cli: &impl Cli, session: Session, handle: P::Handle) {
        let key = key(session.project.clone(), &session.cli, &session.session_id);
        let permission = cli.permission();
        self.owned.insert(
            key,
            Owned {
                handle,
                session,
                permission,
            },
        );
    }

    async fn launch(
        &mut self,
        cli: &impl Cli,
        project: PathBuf,
        requested: Option<&str>,
    ) -> Result<Opened, LaunchError> {
        let session_id = match requested {
            Some(id) => Some(id.to_owned()),
            None if cli.assigns_id() => Some(mint()?),
            None => None,
        };
        let mut command = cli.command(&LaunchContext {
            session_id: session_id.as_deref(),
            hook: &self.settings.hook,
        });
        command.env.push((
            crate::config::AGENT_HOOK_SOCKET_VARIABLE.to_owned(),
            self.settings.hook.socket.to_string_lossy().into_owned(),
        ));
        if let Some(module) = &command.requires {
            module
                .install()
                .map_err(|_| LaunchError::HookUnavailable(module.path.clone()))?;
        }
        let before: HashSet<PathBuf> = discover(cli, &self.settings.home, &project)
            .into_iter()
            .map(|found| found.path)
            .collect();
        let deadline = Instant::now() + self.settings.ready;
        let handle = self.spawner.launch(&project, &command).await?;
        self.launching.push(handle);
        let found = loop {
            let appeared = discover(cli, &self.settings.home, &project)
                .into_iter()
                .filter(|found| {
                    !before.contains(&found.path)
                        && session_id.as_ref().is_none_or(|id| found.id == *id)
                })
                .max_by_key(|found| found.modified);
            if let Some(found) = appeared {
                break found;
            }
            let handle = self.launching.last_mut().expect("pushed above");
            match self.spawner.changed(handle, deadline).await {
                Ok(true) => {}
                Ok(false) => return self.abandon(LaunchError::SessionNotAvailable).await,
                Err(error) => return self.abandon(error.into()).await,
            }
        };
        let handle = self.launching.last().expect("pushed above");
        let session = Session {
            project,
            cli: cli.name().to_owned(),
            session_id: found.id,
            transcript: found.path,
            terminal: Some(self.spawner.terminal(handle)),
        };
        if let Err(error) = self.registry.observe(session.clone()) {
            return self.abandon(error.into()).await;
        }
        let handle = self.launching.pop().expect("pushed above");
        self.own(cli, session.clone(), handle);
        Ok(Opened {
            session,
            owned: true,
            launched: true,
        })
    }

    async fn abandon(&mut self, error: LaunchError) -> Result<Opened, LaunchError> {
        self.reap().await?;
        Err(error)
    }

    pub async fn send(
        &self,
        project: &Path,
        cli: &str,
        session_id: &str,
        text: &str,
    ) -> Result<(), LaunchError> {
        let key = key(self.confine(project)?, cli, session_id);
        let owned = self.owned.get(&key).ok_or(LaunchError::NotOwned)?;
        Ok(self.spawner.send(&owned.handle, text).await?)
    }

    /// Stop only a process this client launched or reclaimed; the transcript
    /// observation stays, without its terminal.
    pub async fn stop(
        &mut self,
        project: &Path,
        cli: &str,
        session_id: &str,
    ) -> Result<Session, LaunchError> {
        let key = key(self.confine(project)?, cli, session_id);
        let owned = self.owned.remove(&key).ok_or(LaunchError::NotOwned)?;
        let session = Session {
            terminal: None,
            ..owned.session
        };
        self.spawner.stop(owned.handle).await?;
        self.registry.observe(session.clone())?;
        Ok(session)
    }

    /// Relay a hook's request only for an owned, hooked session; anything
    /// else, a timeout, or a mismatched verdict is refused, never allowed.
    pub async fn permission(
        &self,
        relay: &impl PermissionRelay,
        request: AgentPermissionRequest,
    ) -> AgentPermissionDecision {
        let hooked = self.owned.values().any(|owned| {
            owned.permission == Permission::Hook
                && owned.session.session_id == request.session_id.as_str()
        });
        if !hooked {
            return refused(&request, false);
        }
        match tokio::time::timeout(self.settings.decide, relay.decide(request.clone())).await {
            Ok(decision) => correlate(&request, decision),
            Err(_) => refused(&request, true),
        }
    }
}

/// The production spawner: each session runs in its own named terminal of
/// the pty module, with the CLI exec'd as the terminal's occupant.
pub struct PtySpawner {
    pty: Arc<Pty>,
    exports: Vec<PathBuf>,
    grace: Duration,
    next: AtomicU64,
}

#[derive(Debug)]
pub struct PtyHandle {
    name: String,
    cursor: Option<String>,
}

fn wire<T: WireRoot>(value: Value) -> io::Result<T> {
    oni_protocol::decode(value).map_err(io::Error::other)
}

fn value<T: Serialize>(outcome: Result<T, PtyError>) -> io::Result<Value> {
    serde_json::to_value(outcome.map_err(io::Error::other)?).map_err(io::Error::other)
}

fn ok<T: Serialize>(outcome: Result<T, PtyError>) -> io::Result<Value> {
    let answer = value(outcome)?;
    match answer["status"].as_str() {
        Some("ok") => Ok(answer),
        _ => Err(io::Error::other(answer["reason"].to_string())),
    }
}

async fn terminate(pid: Pid, grace: Duration) {
    let deadline = Instant::now() + grace;
    kill(pid, Signal::SIGTERM).ok();
    while kill(pid, None).is_ok() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    if kill(pid, None).is_ok() {
        kill(pid, Signal::SIGKILL).ok();
    }
}

impl PtySpawner {
    pub fn new(pty: Arc<Pty>, exports: Vec<PathBuf>, grace: Duration) -> Self {
        Self {
            pty,
            exports,
            grace,
            next: AtomicU64::new(0),
        }
    }

    async fn write(&self, name: &str, text: &str) -> io::Result<()> {
        let request = wire(json!({"name": name, "data": STANDARD.encode(text)}))?;
        ok(self.pty.write(&request).await).map(drop)
    }
}

impl ProcessSpawner for PtySpawner {
    type Handle = PtyHandle;

    async fn launch(&self, project: &Path, command: &LaunchCommand) -> io::Result<PtyHandle> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let name = format!(
            "agent-{nanos:x}-{}",
            self.next.fetch_add(1, Ordering::Relaxed)
        );
        let open = wire(json!({"name": name, "cwd": project}))?;
        ok(self.pty.open(&open, &self.exports).await)?;
        let words: Vec<String> = command
            .env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .chain([command.executable.clone()])
            .chain(command.args.iter().cloned())
            .map(|word| shell_quote(&word))
            .collect();
        self.write(&name, &format!("exec env {}\n", words.join(" ")))
            .await?;
        Ok(PtyHandle { name, cursor: None })
    }

    fn terminal(&self, handle: &PtyHandle) -> String {
        handle.name.clone()
    }

    async fn changed(&self, handle: &mut PtyHandle, deadline: Instant) -> io::Result<bool> {
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(30));
        let mut request = json!({"name": handle.name, "waitMs": wait.as_millis()});
        if let Some(cursor) = &handle.cursor {
            request["cursor"] = cursor.as_str().into();
        }
        let answer = ok(self.pty.read(&wire(request)?).await)?;
        handle.cursor = answer["cursor"].as_str().map(str::to_owned);
        Ok(answer["data"].as_str().is_some_and(|data| !data.is_empty())
            || Instant::now() < deadline)
    }

    async fn send(&self, handle: &PtyHandle, text: &str) -> io::Result<()> {
        self.write(&handle.name, &format!("{text}\r")).await
    }

    async fn stop(&self, handle: PtyHandle) -> io::Result<()> {
        let screen = wire(json!({"name": handle.name, "source": "screen"}))?;
        let screen = value(self.pty.screen(&screen).await)?;
        let pid = screen["occupant"]["pid"]
            .as_i64()
            .and_then(|pid| i32::try_from(pid).ok());
        if let Some(pid) = pid {
            terminate(Pid::from_raw(pid), self.grace).await;
        }
        value(self.pty.close(&wire(json!({"name": handle.name}))?).await).map(drop)
    }

    async fn reclaim(&self, terminal: &str) -> io::Result<Option<PtyHandle>> {
        let listed = value(self.pty.list().await)?;
        let live = listed["sessions"].as_array().is_some_and(|sessions| {
            sessions
                .iter()
                .any(|session| session["name"] == terminal && session["status"] == "live")
        });
        Ok(live.then(|| PtyHandle {
            name: terminal.to_owned(),
            cursor: None,
        }))
    }
}
