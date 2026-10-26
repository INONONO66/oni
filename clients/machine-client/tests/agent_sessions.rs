#[path = "support/tmux.rs"]
mod tmux_server;

use std::{
    fs, io,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use oni_machine_client::agent::{
    claude, codex,
    launcher::{
        correlate, refused, Cli, HookModule, HookTarget, LaunchCommand, LaunchContext, LaunchError,
        Launcher, Opened, Permission, PermissionRelay, ProcessSpawner, PtySpawner, Settings,
        PERMISSION_FILE, PERMISSION_MODULE,
    },
    manifest::{self, Dialect, DIALECTS},
    omp, pi,
    registry::{Registry, RegistryError, Session},
};
use oni_machine_client::pty::ops::Pty;
use oni_protocol::{AgentPermissionDecision, AgentPermissionRequest};
use serde_json::{json, Value};
use tempfile::{tempdir, TempDir};

const DISCOVERED: &str = "01a13a97-ae35-7672-bd24-274ca5f9404b";

type Appear = Box<dyn Fn(&LaunchCommand, &Path) -> Vec<(PathBuf, String)> + Send + Sync>;

struct Fake {
    appear: Appear,
    live: Mutex<Vec<String>>,
    fail_changed: bool,
    /// After writing its transcripts, `changed` never resolves again.
    hang: AtomicBool,
    /// Signalled when a hanging `changed` starts waiting.
    waiting: Arc<tokio::sync::Notify>,
    launches: Mutex<Vec<LaunchCommand>>,
    log: Mutex<Vec<String>>,
}

struct FakeHandle {
    terminal: String,
    pending: Vec<(PathBuf, String)>,
}

impl Fake {
    fn new(appear: Appear) -> Self {
        Self {
            appear,
            live: Mutex::new(Vec::new()),
            fail_changed: false,
            hang: AtomicBool::new(false),
            waiting: Arc::new(tokio::sync::Notify::new()),
            launches: Mutex::new(Vec::new()),
            log: Mutex::new(Vec::new()),
        }
    }

    fn silent() -> Self {
        Self::new(Box::new(|_, _| Vec::new()))
    }

    fn launches(&self) -> Vec<LaunchCommand> {
        self.launches.lock().expect("launch log").clone()
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().expect("event log").clone()
    }

    /// The process behind `terminal` exits outside the launcher.
    fn exit(&self, terminal: &str) {
        self.live
            .lock()
            .expect("live terminals")
            .retain(|live| live != terminal);
    }
}

impl ProcessSpawner for Fake {
    type Handle = FakeHandle;

    async fn launch(&self, project: &Path, command: &LaunchCommand) -> io::Result<FakeHandle> {
        let pending = (self.appear)(command, project);
        let mut launches = self.launches.lock().expect("launch log");
        launches.push(command.clone());
        let terminal = format!("fake-{}", launches.len());
        self.live
            .lock()
            .expect("live terminals")
            .push(terminal.clone());
        Ok(FakeHandle { terminal, pending })
    }

    fn terminal(&self, handle: &FakeHandle) -> String {
        handle.terminal.clone()
    }

    async fn changed(&self, handle: &mut FakeHandle, _: Instant) -> io::Result<bool> {
        if self.fail_changed {
            return Err(io::Error::other("terminal lost"));
        }
        let pending = std::mem::take(&mut handle.pending);
        for (path, body) in &pending {
            fs::create_dir_all(path.parent().expect("transcript directory"))?;
            fs::write(path, body)?;
        }
        if pending.is_empty() && self.hang.load(Ordering::SeqCst) {
            self.waiting.notify_one();
            return std::future::pending().await;
        }
        Ok(!pending.is_empty())
    }

    async fn send(&self, handle: &FakeHandle, text: &str) -> io::Result<()> {
        let event = format!("send {} {text}", handle.terminal);
        self.log.lock().expect("event log").push(event);
        Ok(())
    }

    async fn stop(&self, handle: FakeHandle) -> io::Result<()> {
        self.exit(&handle.terminal);
        let event = format!("stop {}", handle.terminal);
        self.log.lock().expect("event log").push(event);
        Ok(())
    }

    async fn reclaim(&self, terminal: &str) -> io::Result<Option<FakeHandle>> {
        Ok(self
            .live
            .lock()
            .expect("live terminals")
            .iter()
            .any(|live| live == terminal)
            .then(|| FakeHandle {
                terminal: terminal.to_owned(),
                pending: Vec::new(),
            }))
    }
}

struct Relay {
    answer: Option<Value>,
    asked: AtomicUsize,
}

impl Relay {
    fn answering(answer: Option<Value>) -> Self {
        Self {
            answer,
            asked: AtomicUsize::new(0),
        }
    }
}

impl PermissionRelay for Relay {
    async fn decide(&self, _: AgentPermissionRequest) -> AgentPermissionDecision {
        self.asked.fetch_add(1, Ordering::SeqCst);
        match &self.answer {
            Some(answer) => oni_protocol::decode(answer.clone()).expect("valid decision"),
            None => std::future::pending().await,
        }
    }
}

struct World {
    _root: TempDir,
    home: PathBuf,
    export: PathBuf,
    registry: PathBuf,
    hooks: PathBuf,
}

impl World {
    fn new() -> Self {
        let root = tempdir().expect("world");
        let base = root.path().canonicalize().expect("canonical world");
        let home = base.join("home");
        let export = home.join("work");
        let hooks = base.join("hooks");
        for directory in [&export, &hooks] {
            fs::create_dir_all(directory).expect("world directory");
        }
        Self {
            registry: base.join("registry"),
            _root: root,
            home,
            export,
            hooks,
        }
    }

    fn project(&self, name: &str) -> PathBuf {
        let project = self.export.join(name);
        fs::create_dir_all(&project).expect("project");
        project
    }

    fn settings(&self, decide: Duration) -> Settings {
        Settings {
            exports: vec![self.export.clone()],
            home: self.home.clone(),
            hook: HookTarget {
                program: PathBuf::from("/opt/mclient"),
                modules: self.hooks.clone(),
                socket: self.hooks.join("hook.sock"),
            },
            ready: Duration::from_secs(5),
            decide,
        }
    }

    fn launcher<P: ProcessSpawner>(&self, spawner: P) -> Launcher<P> {
        let registry = Registry::open(&self.registry).expect("registry");
        Launcher::new(registry, spawner, self.settings(Duration::from_secs(5)))
    }
}

fn transcript(dialect: Dialect, home: &Path, project: &Path, id: &str) -> PathBuf {
    let directory = dialect.transcripts(home, project);
    match dialect.cli {
        "claude-code" => directory.join(format!("{id}.jsonl")),
        "codex" => directory.join(format!("2026/10/25/rollout-2026-10-25T00-00-00-{id}.jsonl")),
        _ => directory.join(format!("2026-10-25T00-00-00_{id}.jsonl")),
    }
}

fn body(cwd: &Path) -> String {
    format!(
        "{}\n",
        json!({"type": "session_meta", "payload": {"cwd": cwd}})
    )
}

fn writes(dialect: Dialect, home: &Path, cwd: Option<PathBuf>) -> Appear {
    writes_as(dialect, home, cwd, DISCOVERED)
}

/// Like [`writes`], with `discovered` as the id a CLI that mints its own uses.
fn writes_as(dialect: Dialect, home: &Path, cwd: Option<PathBuf>, discovered: &str) -> Appear {
    let home = home.to_owned();
    let discovered = discovered.to_owned();
    Box::new(move |command, project| {
        let id = command
            .args
            .iter()
            .position(|arg| arg == "--session-id")
            .map_or(discovered.as_str(), |index| {
                command.args[index + 1].as_str()
            });
        let cwd = cwd.as_deref().unwrap_or(project);
        vec![(transcript(dialect, &home, project, id), body(cwd))]
    })
}

fn dialect(cli: &str) -> Dialect {
    manifest::select(cli).expect("supported CLI")
}

fn request(session_id: &str, request_id: &str) -> AgentPermissionRequest {
    oni_protocol::decode(json!({
        "sessionId": session_id,
        "requestId": request_id,
        "tool": "bash",
        "description": "run a command",
    }))
    .expect("valid request")
}

fn wire(decision: &AgentPermissionDecision) -> Value {
    serde_json::to_value(decision).expect("wire decision")
}

#[tokio::test]
async fn launches_once_then_adopts_for_every_dialect() {
    let world = World::new();
    for (index, dialect) in DIALECTS.into_iter().enumerate() {
        let project = world.project(dialect.cli);
        // Session ids are unique across projects and CLIs.
        let discovered = format!("{}{index}", &DISCOVERED[..DISCOVERED.len() - 1]);
        let mut launcher = world.launcher(Fake::new(writes_as(
            dialect,
            &world.home,
            None,
            &discovered,
        )));
        let first = launcher
            .start(&dialect, &project, None)
            .await
            .expect("launch");
        assert!(first.launched && first.owned, "{}", dialect.cli);
        assert_eq!(first.session.cli, dialect.cli);
        assert_eq!(
            first.session.transcript,
            transcript(dialect, &world.home, &project, &first.session.session_id)
        );
        let again = launcher
            .start(&dialect, &project, None)
            .await
            .expect("adopt");
        let attached = launcher
            .attach(&dialect, &project, &first.session.session_id)
            .await
            .expect("attach");
        for opened in [again, attached] {
            assert_eq!(
                opened,
                Opened {
                    launched: false,
                    ..first.clone()
                }
            );
        }
        let launches = launcher_launches(&launcher);
        assert_eq!(launches, 1, "{}", dialect.cli);
        let saved = launcher
            .registry()
            .find(&project, dialect.cli, &first.session.session_id)
            .expect("persisted");
        assert_eq!(saved, &first.session);
        assert_eq!(saved.terminal.as_deref(), Some("fake-1"));
    }
}

fn launcher_launches(launcher: &Launcher<Fake>) -> usize {
    launcher_spawner(launcher).launches().len()
}

fn launcher_spawner(launcher: &Launcher<Fake>) -> &Fake {
    launcher.spawner()
}

#[tokio::test]
async fn launch_argv_and_hooks_stay_in_dialect_data() {
    let world = World::new();
    let hook = HookTarget {
        program: PathBuf::from("/opt/it's/mclient"),
        modules: world.hooks.clone(),
        socket: world.hooks.join("hook.sock"),
    };
    let context = LaunchContext {
        session_id: Some("chosen"),
        hook: &hook,
    };
    let claude = dialect("claude-code").command(&context);
    assert_eq!(claude.executable, "claude");
    assert_eq!(claude.args[0], "--settings");
    let settings: Value = serde_json::from_str(&claude.args[1]).expect("settings JSON");
    assert_eq!(
        settings["hooks"]["PreToolUse"][0]["hooks"][0],
        json!({
            "type": "command",
            "command": "/opt/it's/mclient",
            "args": ["hook", "permission", "--cli", "claude-code"],
            "onFailure": "block",
            "timeout": 170,
        })
    );
    assert_eq!(claude.args[2..], ["--session-id", "chosen"]);
    assert_eq!(claude.requires, None);

    let codex = dialect("codex").command(&context);
    assert_eq!((codex.executable.as_str(), codex.args.len()), ("codex", 0));
    assert_eq!(dialect("codex").permission(), Permission::CliPrompt);

    for (cli, flag) in [("pi", "--extension"), ("omp", "--hook")] {
        let command = dialect(cli).command(&context);
        let module = world.hooks.join(PERMISSION_FILE);
        assert_eq!(command.executable, cli);
        assert_eq!(
            command.args,
            [flag.to_owned(), module.display().to_string()]
        );
        assert_eq!(
            command.requires.expect("hook module"),
            HookModule {
                path: module,
                source: PERMISSION_MODULE,
            }
        );
        assert_eq!(
            command.env,
            [
                ("ONI_MCLIENT".to_owned(), "/opt/it's/mclient".to_owned()),
                ("ONI_MCLIENT_CLI".to_owned(), cli.to_owned()),
            ]
        );
        assert_eq!(dialect(cli).permission(), Permission::Hook);
        assert!(!dialect(cli).assigns_id());
    }
    assert!(dialect("claude-code").assigns_id());
    assert_eq!(dialect("pi").name(), "pi");
}

#[test]
fn transcript_layouts_follow_each_dialect() {
    let home = Path::new("/home/user");
    let project = Path::new("/srv/a.b/c");
    assert_eq!(
        claude::transcripts(home, project),
        Path::new("/home/user/.claude/projects/-srv-a-b-c")
    );
    assert_eq!(
        codex::transcripts(home),
        Path::new("/home/user/.codex/sessions")
    );
    assert_eq!(
        pi::transcripts(home, Path::new("/srv/x:y/z")),
        Path::new("/home/user/.pi/agent/sessions/--srv-x-y-z--")
    );
    for (project, encoded) in [
        ("/home/user/src/app", "-src-app"),
        ("/tmp/scratch/app", "-tmp-scratch-app"),
        ("/srv/app", "--srv-app--"),
    ] {
        assert_eq!(
            omp::transcripts(home, Path::new(project)),
            home.join(".omp/agent/sessions").join(encoded),
            "{project}"
        );
    }
    let codex_file = Path::new(&format!(
        "/s/rollout-2026-10-25T00-00-00-{DISCOVERED}.jsonl"
    ))
    .to_owned();
    assert_eq!(codex::session_id(&codex_file).as_deref(), Some(DISCOVERED));
    assert_eq!(codex::session_id(Path::new("/s/short.jsonl")), None);
    assert_eq!(
        pi::session_id(Path::new("/s/2026_abc.jsonl")).as_deref(),
        Some("abc")
    );
    assert_eq!(pi::session_id(Path::new("/s/plain.jsonl")), None);
    assert_eq!(
        claude::session_id(Path::new("/s/abc.jsonl")).as_deref(),
        Some("abc")
    );
    assert!(!codex::belongs(
        Path::new("/definitely/missing.jsonl"),
        project
    ));
}

#[tokio::test]
async fn attach_adopts_existing_transcript_without_launching_or_owning() {
    let world = World::new();
    let project = world.project("adopt");
    let claude = dialect("claude-code");
    let existing = transcript(claude, &world.home, &project, "existing");
    fs::create_dir_all(existing.parent().expect("layout")).expect("layout");
    fs::write(&existing, "{}\n").expect("transcript");
    fs::write(existing.with_file_name("notes.txt"), "").expect("non-transcript");
    let mut launcher = world.launcher(Fake::silent());

    let attached = launcher
        .attach(&claude, &project, "existing")
        .await
        .expect("attach");
    assert!(!attached.owned && !attached.launched);
    assert_eq!(attached.session.transcript, existing);
    assert_eq!(attached.session.terminal, None);
    let started = launcher
        .start(&claude, &project, Some("existing"))
        .await
        .expect("adopt on start");
    assert_eq!(started, attached);
    assert!(launcher.spawner().launches().is_empty());

    assert!(matches!(
        launcher.attach(&claude, &project, "absent").await,
        Err(LaunchError::SessionNotAvailable)
    ));
    assert!(matches!(
        launcher.send(&project, claude.cli, "existing", "hi").await,
        Err(LaunchError::NotOwned)
    ));
    assert!(matches!(
        launcher.stop(&project, claude.cli, "existing").await,
        Err(LaunchError::NotOwned)
    ));
    assert!(launcher.spawner().log().is_empty());
}

#[tokio::test]
async fn sessions_are_isolated_per_project_and_confined_to_exports() {
    let world = World::new();
    let claude = dialect("claude-code");
    let (left, right) = (world.project("left"), world.project("right"));
    let mut launcher = world.launcher(Fake::new(writes(claude, &world.home, None)));
    let a = launcher.start(&claude, &left, None).await.expect("left");
    let b = launcher.start(&claude, &right, None).await.expect("right");
    assert_ne!(a.session.session_id, b.session.session_id);
    assert!(a.launched && b.launched);
    let only_left: Vec<_> = launcher.registry().sessions(&left).collect();
    assert_eq!(only_left, [&a.session]);
    assert!(matches!(
        launcher
            .attach(&claude, &right, &a.session.session_id)
            .await,
        Err(LaunchError::SessionNotAvailable)
    ));

    let outside = tempdir().expect("outside export");
    assert!(matches!(
        launcher.start(&claude, outside.path(), None).await,
        Err(LaunchError::Registry(RegistryError::OutsideExport))
    ));
    assert!(matches!(
        launcher
            .start(&claude, &world.export.join("missing"), None)
            .await,
        Err(LaunchError::Registry(RegistryError::Io(_)))
    ));

    let codex = dialect("codex");
    let mut foreign = world.launcher(Fake::new(writes(codex, &world.home, Some(right.clone()))));
    assert!(matches!(
        foreign.start(&codex, &left, None).await,
        Err(LaunchError::SessionNotAvailable)
    ));
    assert_eq!(foreign.spawner().log(), ["stop fake-1"]);
}

#[tokio::test]
async fn launch_refusals_are_typed_and_never_leave_a_process() {
    let world = World::new();
    let project = world.project("refuse");

    let mut silent = world.launcher(Fake::silent());
    assert!(matches!(
        silent.start(&dialect("claude-code"), &project, None).await,
        Err(LaunchError::SessionNotAvailable)
    ));
    assert_eq!(silent.spawner().log(), ["stop fake-1"]);
    assert!(matches!(
        silent
            .start(&dialect("codex"), &project, Some("chosen"))
            .await,
        Err(LaunchError::SessionNotAvailable)
    ));
    fs::remove_dir(&world.hooks).expect("unblock hooks");
    fs::write(&world.hooks, "not a directory").expect("block hooks");
    assert!(matches!(
        silent.start(&dialect("pi"), &project, None).await,
        Err(LaunchError::HookUnavailable(module)) if module == world.hooks.join(PERMISSION_FILE)
    ));
    assert_eq!(silent.spawner().launches().len(), 1);
    fs::remove_file(&world.hooks).expect("unblock hooks");
    fs::create_dir(&world.hooks).expect("hooks directory");
    let installed = world.hooks.join(PERMISSION_FILE);
    for cli in ["pi", "omp"] {
        // A stale or foreign module at the path is replaced, never trusted.
        fs::write(&installed, "export {}\n").expect("stale module");
        assert!(matches!(
            silent.start(&dialect(cli), &project, None).await,
            Err(LaunchError::SessionNotAvailable)
        ));
        assert_eq!(
            fs::read_to_string(&installed).expect("installed"),
            PERMISSION_MODULE
        );
        assert_eq!(
            fs::metadata(&installed)
                .expect("installed")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_eq!(silent.spawner().launches().len(), 3);
    assert!(matches!(
        silent.start(&dialect("pi"), &project, None).await,
        Err(LaunchError::SessionNotAvailable)
    ));
    // A stale module that cannot be replaced refuses the launch, typed.
    fs::write(&installed, "export {}\n").expect("stale module");
    fs::set_permissions(&world.hooks, fs::Permissions::from_mode(0o500)).expect("seal hooks");
    assert!(matches!(
        silent.start(&dialect("omp"), &project, None).await,
        Err(LaunchError::HookUnavailable(module)) if module == installed
    ));
    fs::set_permissions(&world.hooks, fs::Permissions::from_mode(0o700)).expect("unseal hooks");
    assert_eq!(silent.spawner().launches().len(), 4);

    let mut broken = Fake::silent();
    broken.fail_changed = true;
    let mut broken = world.launcher(broken);
    assert!(matches!(
        broken.start(&dialect("codex"), &project, None).await,
        Err(LaunchError::Io(_))
    ));
    assert_eq!(broken.spawner().log(), ["stop fake-1"]);

    let claude = dialect("claude-code");
    let mut unsaved = world.launcher(Fake::new(writes(claude, &world.home, None)));
    fs::write(&world.registry, "not a directory").expect("block registry");
    assert!(matches!(
        unsaved.start(&claude, &project, None).await,
        Err(LaunchError::Registry(RegistryError::Io(_)))
    ));
    assert_eq!(unsaved.spawner().log(), ["stop fake-1"]);
}

#[tokio::test]
async fn stop_and_send_reach_only_owned_sessions() {
    let world = World::new();
    let project = world.project("own");
    let claude = dialect("claude-code");
    let mut launcher = world.launcher(Fake::new(writes(claude, &world.home, None)));
    let opened = launcher
        .start(&claude, &project, Some("chosen-id"))
        .await
        .expect("launch with chosen id");
    assert_eq!(opened.session.session_id, "chosen-id");
    launcher
        .send(&project, claude.cli, "chosen-id", "hello")
        .await
        .expect("send");
    let stopped = launcher
        .stop(&project, claude.cli, "chosen-id")
        .await
        .expect("stop");
    assert_eq!(stopped.terminal, None);
    assert_eq!(
        launcher.registry().find(&project, claude.cli, "chosen-id"),
        Some(&stopped)
    );
    assert_eq!(
        launcher.spawner().log(),
        ["send fake-1 hello", "stop fake-1"]
    );
    assert!(matches!(
        launcher.stop(&project, claude.cli, "chosen-id").await,
        Err(LaunchError::NotOwned)
    ));
    assert!(matches!(
        launcher
            .send(&project, claude.cli, "chosen-id", "again")
            .await,
        Err(LaunchError::NotOwned)
    ));
}

#[tokio::test]
async fn restart_reowns_only_terminals_observed_live() {
    let world = World::new();
    let project = world.project("restart");
    let claude = dialect("claude-code");
    let mut first = world.launcher(Fake::new(writes(claude, &world.home, None)));
    let opened = first.start(&claude, &project, None).await.expect("launch");
    let id = opened.session.session_id.clone();

    let mut live = Fake::silent();
    live.live = Mutex::new(vec!["fake-1".to_owned()]);
    let mut reclaimed = world.launcher(live);
    let back = reclaimed
        .start(&claude, &project, None)
        .await
        .expect("reclaim");
    assert!(back.owned && !back.launched);
    assert_eq!(back.session, opened.session);
    reclaimed
        .stop(&project, claude.cli, &id)
        .await
        .expect("stop reclaimed");

    let mut again = world.launcher(Fake::new(writes(claude, &world.home, None)));
    let relaunched = again
        .start(&claude, &project, None)
        .await
        .expect("relaunch");
    assert!(relaunched.launched);

    let mut gone = world.launcher(Fake::silent());
    let observed = gone
        .attach(&claude, &project, &relaunched.session.session_id)
        .await
        .expect("observed after restart");
    assert!(!observed.owned);
    assert_eq!(observed.session.terminal, None);
    assert!(gone.spawner().launches().is_empty());
    assert_eq!(
        gone.registry()
            .find(&project, claude.cli, &relaunched.session.session_id)
            .and_then(|session| session.terminal.clone()),
        None
    );
}

#[tokio::test]
async fn a_cancelled_launch_leaves_no_process_behind() {
    let world = World::new();
    let project = world.project("cancelled");
    let claude = dialect("claude-code");
    let mut launcher = world.launcher(Fake::silent());
    launcher.spawner().hang.store(true, Ordering::SeqCst);
    // The request future is dropped while it waits for the session to
    // appear, as a transport loss drops it; biased polling fixes the point.
    tokio::select! {
        biased;
        _ = launcher.start(&claude, &project, Some("dropped")) => panic!("readiness never resolves"),
        () = std::future::ready(()) => {}
    }
    released_after_abandoned_readiness(&mut launcher, &project).await;
}

#[tokio::test]
async fn a_transport_loss_during_readiness_leaves_no_process_behind() {
    use oni_machine_client::transport::{
        client::{handler, Client},
        envelope,
        framing::write_frame,
    };

    let world = World::new();
    let project = world.project("disconnected");
    let fake = Fake::silent();
    fake.hang.store(true, Ordering::SeqCst);
    let waiting = fake.waiting.clone();
    let launcher = Arc::new(tokio::sync::Mutex::new(world.launcher(fake)));
    let serving = launcher.clone();
    let (mut host, peer) = tokio::io::duplex(1 << 16);
    let mut client = Client::from_stream(
        peer,
        handler(move |_, _| {
            let launcher = serving.clone();
            let project = project.clone();
            async move {
                let claude = dialect("claude-code");
                let opened = launcher
                    .lock()
                    .await
                    .start(&claude, &project, Some("lost"))
                    .await;
                opened
                    .map(|_| Value::Null)
                    .map_err(|error| format!("{error:?}"))
            }
        }),
    );
    write_frame(
        &mut host,
        &envelope::request("open-1", "agent.session.open", None),
    )
    .await
    .expect("request frame");
    waiting.notified().await;
    drop(host);
    assert!(client.closed().await.is_err(), "the connection ended");
    // The aborted request releases the launcher only once its future is dropped.
    let mut launcher = launcher.lock().await;
    let project = world.project("disconnected");
    released_after_abandoned_readiness(&mut launcher, &project).await;
}

#[tokio::test]
async fn an_owned_session_whose_process_exited_is_released() {
    let world = World::new();
    let project = world.project("exited");
    let claude = dialect("claude-code");
    let mut launcher = world.launcher(Fake::new(writes(claude, &world.home, None)));
    let opened = launcher
        .start(&claude, &project, Some("exits"))
        .await
        .expect("launch");
    assert!(launcher.owns(&opened.session));
    assert!(launcher.spawner().launches()[0].env.contains(&(
        "ONI_MCLIENT_HOOK_SOCKET".to_owned(),
        world.hooks.join("hook.sock").display().to_string()
    )));
    launcher.spawner().exit("fake-1");
    let after = launcher
        .attach(&claude, &project, "exits")
        .await
        .expect("observed");
    assert!(!after.owned && !after.launched);
    assert_eq!(after.session.terminal, None);
    assert!(!launcher.owns(&after.session));
    assert_eq!(
        launcher
            .registry()
            .find(&project, claude.cli, "exits")
            .and_then(|session| session.terminal.clone()),
        None
    );
    assert!(matches!(
        launcher.stop(&project, claude.cli, "exits").await,
        Err(LaunchError::NotOwned)
    ));
}

#[tokio::test]
async fn permission_relays_only_for_owned_hooked_sessions_and_never_allows_implicitly() {
    let world = World::new();
    let project = world.project("permission");
    let claude = dialect("claude-code");
    let mut launcher = world.launcher(Fake::new(writes(claude, &world.home, None)));
    launcher
        .start(&claude, &project, Some("hooked"))
        .await
        .expect("launch");
    let allow = json!({"status": "allowed", "sessionId": "hooked", "requestId": "r1"});
    let relay = Relay::answering(Some(allow.clone()));
    assert_eq!(
        wire(&launcher.permission(&relay, request("hooked", "r1")).await),
        allow
    );

    let stray = Relay::answering(Some(
        json!({"status": "allowed", "sessionId": "hooked", "requestId": "other"}),
    ));
    let denied =
        json!({"status": "refused", "sessionId": "hooked", "requestId": "r2", "reason": "denied"});
    assert_eq!(
        wire(&launcher.permission(&stray, request("hooked", "r2")).await),
        denied
    );

    let unknown = Relay::answering(Some(allow.clone()));
    assert_eq!(
        wire(
            &launcher
                .permission(&unknown, request("stranger", "r3"))
                .await
        )["reason"],
        "denied"
    );
    assert_eq!(unknown.asked.load(Ordering::SeqCst), 0);

    let codex = dialect("codex");
    let mut prompts = world.launcher(Fake::new(writes(codex, &world.home, None)));
    prompts
        .start(&codex, &project, None)
        .await
        .expect("codex launch");
    let never = Relay::answering(Some(
        json!({"status": "allowed", "sessionId": DISCOVERED, "requestId": "r4"}),
    ));
    assert_eq!(
        wire(&prompts.permission(&never, request(DISCOVERED, "r4")).await)["reason"],
        "denied"
    );
    assert_eq!(never.asked.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn permission_times_out_to_a_refusal() {
    let world = World::new();
    let project = world.project("timeout");
    let claude = dialect("claude-code");
    let registry = Registry::open(&world.registry).expect("registry");
    let mut launcher = Launcher::new(
        registry,
        Fake::new(writes(claude, &world.home, None)),
        world.settings(Duration::ZERO),
    );
    launcher
        .start(&claude, &project, Some("slow"))
        .await
        .expect("launch");
    let relay = Relay::answering(None);
    let decision = launcher.permission(&relay, request("slow", "r1")).await;
    assert_eq!(
        wire(&decision),
        json!({"status": "refused", "sessionId": "slow", "requestId": "r1", "reason": "timeout"})
    );
    assert_eq!(
        wire(&refused(&request("s", "r"), false))["reason"],
        "denied"
    );
    let refusal = refused(&request("s", "r"), true);
    assert_eq!(
        wire(&correlate(&request("s", "r"), refusal))["reason"],
        "timeout"
    );
}

#[test]
fn registry_refuses_corrupt_or_unreadable_state() {
    let root = tempdir().expect("registry root");
    fs::write(root.path().join("agent-sessions.json"), "{").expect("corrupt");
    assert!(matches!(
        Registry::open(root.path()),
        Err(RegistryError::Json(_))
    ));
    let nested = root.path().join("nested");
    fs::create_dir_all(nested.join("agent-sessions.json")).expect("directory in place of file");
    assert!(matches!(Registry::open(&nested), Err(RegistryError::Io(_))));
    let fresh = Registry::open(&root.path().join("fresh")).expect("empty registry");
    assert_eq!(fresh.find(Path::new("/p"), "pi", "id"), None);
    let session = Session {
        project: PathBuf::from("/p"),
        cli: "pi".to_owned(),
        session_id: "id".to_owned(),
        transcript: PathBuf::from("/p/t.jsonl"),
        terminal: None,
    };
    let mut fresh = fresh;
    fresh.observe(session.clone()).expect("observe");
    let reopened = Registry::open(&root.path().join("fresh")).expect("reopen");
    assert_eq!(reopened.find(Path::new("/p"), "pi", "id"), Some(&session));
}

#[test]
fn registry_refuses_an_id_shared_by_two_projects() {
    let root = tempdir().expect("registry root");
    let mut registry = Registry::open(root.path()).expect("registry");
    let first = Session {
        project: PathBuf::from("/work/a"),
        cli: "pi".to_owned(),
        session_id: "shared".to_owned(),
        transcript: PathBuf::from("/work/a/session.jsonl"),
        terminal: None,
    };
    registry.observe(first.clone()).expect("first observation");
    assert!(matches!(
        registry.observe(Session {
            project: PathBuf::from("/work/b"),
            transcript: PathBuf::from("/work/b/session.jsonl"),
            ..first.clone()
        }),
        Err(RegistryError::Collision)
    ));
    assert_eq!(registry.by_id("shared"), Some(&first));
    assert_eq!(
        Registry::open(root.path()).expect("reopen").by_id("shared"),
        Some(&first)
    );
    fs::write(
        root.path().join("agent-sessions.json"),
        serde_json::json!({"sessions":[
            first,
            {
                "project": "/work/b",
                "cli": "pi",
                "sessionId": "shared",
                "transcript": "/work/b/session.jsonl",
                "terminal": null
            }
        ]})
        .to_string(),
    )
    .expect("preexisting collision");
    assert!(matches!(
        Registry::open(root.path()),
        Err(RegistryError::Collision)
    ));
}

#[test]
fn hook_target_lives_under_the_client_config_directory() {
    let target = HookTarget::current().expect("current executable");
    assert_eq!(
        target.program,
        std::env::current_exe().expect("current executable")
    );
    assert_eq!(
        target.modules,
        oni_machine_client::config::agent_registry_directory().join("hooks")
    );
    assert_eq!(
        oni_machine_client::config::agent_hook_directory(),
        target.modules
    );
}

static SOCKET: AtomicU64 = AtomicU64::new(0);

struct ScriptCli {
    script: PathBuf,
    transcripts: PathBuf,
}

impl Cli for ScriptCli {
    fn name(&self) -> &'static str {
        "script"
    }

    fn permission(&self) -> Permission {
        Permission::CliPrompt
    }

    fn assigns_id(&self) -> bool {
        true
    }

    fn command(&self, context: &LaunchContext<'_>) -> LaunchCommand {
        LaunchCommand {
            executable: self.script.display().to_string(),
            args: vec![
                self.transcripts.display().to_string(),
                context.session_id.expect("assigned id").to_owned(),
            ],
            env: vec![("PROBE".to_owned(), "it's".to_owned())],
            requires: None,
        }
    }

    fn transcripts(&self, _: &Path, _: &Path) -> PathBuf {
        self.transcripts.clone()
    }

    fn session_id(&self, transcript: &Path) -> Option<String> {
        claude::session_id(transcript)
    }

    fn belongs(&self, _: &Path, _: &Path) -> bool {
        true
    }
}

fn script(directory: &Path, name: &str, body: &str) -> PathBuf {
    use std::io::Write;
    let path = directory.join(name);
    let mut writer = std::process::Command::new("/bin/sh")
        .args(["-c", "cat > \"$1\" && chmod 700 \"$1\"", "sh"])
        .arg(&path)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("script writer");
    writer
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(body.as_bytes())
        .expect("script body");
    assert!(writer.wait().expect("script writer exit").success());
    path
}

async fn terminals(pty: &Pty) -> Value {
    serde_json::to_value(pty.list().await.expect("list")).expect("wire")["sessions"].clone()
}

#[tokio::test]
async fn pty_spawner_launches_reclaims_and_stops_real_terminals() {
    let root = tempdir().expect("root");
    let base = root.path().canonicalize().expect("canonical root");
    let (project, transcripts) = (base.join("project"), base.join("transcripts"));
    for directory in [&project, &transcripts] {
        fs::create_dir_all(directory).expect("directory");
    }
    let ready = "#!/bin/sh\nprintf '{}\\n' > \"$1/$2.jsonl\"\necho \"ready $PROBE\"\nexec cat\n";
    let stubborn =
        "#!/bin/sh\ntrap '' TERM\nprintf '{}\\n' > \"$1/$2.jsonl\"\necho ready\nexec cat\n";
    let cli = ScriptCli {
        script: script(&base, "cli", ready),
        transcripts: transcripts.clone(),
    };
    let stubborn = ScriptCli {
        script: script(&base, "stubborn", stubborn),
        transcripts: transcripts.clone(),
    };
    let mute = ScriptCli {
        script: script(&base, "mute", "#!/bin/sh\nexec cat\n"),
        transcripts: transcripts.clone(),
    };
    let socket = format!(
        "oni-p4-{}-{}",
        std::process::id(),
        SOCKET.fetch_add(1, Ordering::Relaxed)
    );
    let pty = Arc::new(Pty::new("tmux", Some(socket.clone()), "g".into()).await);
    let exports = vec![base.clone()];
    let settings = |ready: Duration| Settings {
        exports: exports.clone(),
        home: base.clone(),
        hook: HookTarget {
            program: PathBuf::from("/opt/mclient"),
            modules: base.clone(),
            socket: base.join("hook.sock"),
        },
        ready,
        decide: Duration::from_secs(1),
    };
    let spawner = || PtySpawner::new(pty.clone(), exports.clone(), Duration::from_millis(200));
    let registry = || Registry::open(&base.join("registry")).expect("registry");

    let mut launcher = Launcher::new(registry(), spawner(), settings(Duration::from_secs(20)));
    let opened = launcher.start(&cli, &project, None).await.expect("launch");
    let id = opened.session.session_id.clone();
    assert!(opened.launched && opened.owned);
    assert_eq!(
        opened.session.transcript,
        transcripts.join(format!("{id}.jsonl"))
    );
    let terminal = opened.session.terminal.clone().expect("terminal");
    launcher
        .send(&project, "script", &id, "hello")
        .await
        .expect("send");

    let mut restarted = Launcher::new(registry(), spawner(), settings(Duration::from_secs(20)));
    let back = restarted
        .attach(&cli, &project, &id)
        .await
        .expect("reclaim");
    assert!(back.owned && !back.launched);
    restarted.stop(&project, "script", &id).await.expect("stop");
    assert!(!terminals(&pty)
        .await
        .to_string()
        .contains(&format!("\"{terminal}\",\"status\":\"live\"")));

    let held = restarted
        .start(&stubborn, &project, None)
        .await
        .expect("stubborn launch");
    restarted
        .stop(&project, "script", &held.session.session_id)
        .await
        .expect("kill after grace");

    let mut hurried = Launcher::new(registry(), spawner(), settings(Duration::ZERO));
    assert!(matches!(
        hurried.start(&mute, &project, None).await,
        Err(LaunchError::SessionNotAvailable)
    ));
    assert_eq!(terminals(&pty).await, json!([]));

    let probe = spawner();
    assert!(probe.reclaim("missing").await.expect("list").is_none());
    let narrow = PtySpawner::new(pty.clone(), vec![transcripts.clone()], Duration::ZERO);
    let command = cli.command(&LaunchContext {
        session_id: Some("x"),
        hook: &HookTarget {
            program: PathBuf::new(),
            modules: PathBuf::new(),
            socket: PathBuf::new(),
        },
    });
    let refused = narrow.launch(&project, &command);
    assert!(refused.await.is_err());

    pty.shutdown().await.expect("stop control");
    tmux_server::kill_server(&socket).await;
}

#[tokio::test]
async fn pty_spawner_closes_dead_pane_without_signaling_an_unobserved_pid() {
    let root = tempdir().expect("fake terminal root");
    let terminal = script(
        root.path(),
        "dead-pane",
        "#!/bin/sh\n\
         if [ \"$1\" = -V ]; then exit 0; fi\n\
         printf '%%begin 1 1 1\\n%%end 1 1 1\\n'\n\
         while IFS= read -r line; do\n\
           printf '%%begin 2 1 1\\n'\n\
           case \"$line\" in\n\
             list-sessions*) printf 'sample\\n' ;;\n\
             list-panes*) printf '@1 %%1\\n' ;;\n\
             capture-pane*) printf 'row\\n' ;;\n\
             display-message*) printf '0 0 1 42 sh\\n' ;;\n\
           esac\n\
           printf '%%end 2 1 1\\n'\n\
         done\n",
    );
    let pty = Arc::new(Pty::new(terminal.to_str().expect("utf8 path"), None, "g".into()).await);
    let spawner = PtySpawner::new(pty.clone(), Vec::new(), Duration::ZERO);
    let handle = spawner
        .reclaim("sample")
        .await
        .expect("list fake terminal")
        .expect("live named terminal");

    spawner.stop(handle).await.expect("close dead pane");
    pty.shutdown().await.expect("stop control");
}

#[tokio::test]
async fn binary_hook_relays_a_correlated_permission_over_the_local_socket() {
    use oni_machine_client::transport::framing::{write_frame, Framed};

    let root = tempdir().expect("hook home");
    // A client run with a non-default config directory: nothing listens on
    // the default socket under HOME, so only the launch variable reaches it.
    let directory = root.path().join("custom-config");
    fs::create_dir_all(&directory).expect("socket directory");
    let socket = directory.join("hook.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("listen before invoking hook");
    let child = permission_hook(root.path(), Some(&socket)).await;

    let serve = async move {
        let (stream, _) = listener.accept().await.expect("hook connected");
        let (read, mut write) = tokio::io::split(stream);
        let value = Framed::new(read)
            .next()
            .await
            .expect("frame")
            .expect("request");
        let request: AgentPermissionRequest = oni_protocol::decode(value).expect("typed request");
        assert_eq!(
            (request.session_id.as_str(), request.request_id.as_str()),
            ("session-1", "call-1")
        );
        assert_eq!(&*request.tool, "Bash");
        write_frame(
            &mut write,
            &json!({"status":"allowed","sessionId":"session-1","requestId":"call-1"}),
        )
        .await
        .expect("answer");
    };
    let server = tokio::spawn(serve);
    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .expect("hook completion")
        .expect("hook exit");
    if !output.status.success() {
        server.abort();
    }
    assert!(output.status.success(), "{output:?}");
    server.await.expect("socket answer");
    let answer: Value = serde_json::from_slice(&output.stdout).expect("CLI hook response");
    assert_eq!(answer["hookSpecificOutput"]["permissionDecision"], "allow");
}

#[tokio::test]
async fn binary_hook_blocks_when_the_machine_client_is_disconnected() {
    let root = tempdir().expect("isolated hook home");
    let child = permission_hook(root.path(), None).await;

    let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .expect("hook completion")
        .expect("hook exit");
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("client not reachable"),
        "{output:?}"
    );
}

#[tokio::test]
async fn hook_listener_refuses_an_empty_socket_path() {
    let result = oni_machine_client::agent::hook::bind(Path::new(""));
    assert!(result.is_err());
}

/// A start abandoned while waiting for readiness left its one launch running
/// and unreaped; the next start reaps it with its own launch and refuses.
async fn released_after_abandoned_readiness(launcher: &mut Launcher<Fake>, project: &Path) {
    assert_eq!(launcher.spawner().launches().len(), 1);
    assert!(launcher.spawner().log().is_empty());
    launcher.spawner().hang.store(false, Ordering::SeqCst);
    assert!(matches!(
        launcher
            .start(&dialect("claude-code"), project, Some("next"))
            .await,
        Err(LaunchError::SessionNotAvailable)
    ));
    assert_eq!(launcher.spawner().log(), ["stop fake-1", "stop fake-2"]);
    assert_eq!(launcher.registry().sessions(project).count(), 0);
}

/// The installed `mclient hook permission` for one Bash call, input already
/// written and closed; `socket` overrides the default hook socket.
async fn permission_hook(home: &Path, socket: Option<&Path>) -> tokio::process::Child {
    use tokio::io::AsyncWriteExt;

    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_mclient"));
    command
        .args(["hook", "permission", "--cli", "claude-code"])
        .env("HOME", home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(socket) = socket {
        command.env(
            oni_machine_client::config::AGENT_HOOK_SOCKET_VARIABLE,
            socket,
        );
    }
    let mut child = command.spawn().expect("hook process");
    let mut input = child.stdin.take().expect("piped input");
    input
        .write_all(
            json!({
                "session_id": "session-1",
                "tool_use_id": "call-1",
                "tool_name": "Bash",
                "tool_input": {"command": "printf ready"}
            })
            .to_string()
            .as_bytes(),
        )
        .await
        .expect("hook input");
    drop(input);
    child
}
