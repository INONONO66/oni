//! Tailscale readiness for a tailnet-mode join (#1837). Before the dial the
//! client finds the `tailscale` CLI, installs it through the platform's
//! recipe when it is absent, starts the daemon when it does not answer, logs
//! the node in when it is not running, and attaches only once Tailscale
//! reports `Running`. Every step lands in the join receipt, and a step the
//! client cannot finish is a typed refusal naming what the Owner does by hand.
//! Domain mode never comes here: its host is a public DNS name.

use std::{
    ffi::{OsStr, OsString},
    io,
    os::fd::AsFd,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::config::JoinOptions;

/// The auth key `tailscale up` presents when the node is logged out: read
/// from `--tailscale-auth-key` or this variable, never persisted or echoed.
pub const AUTH_KEY_VARIABLE: &str = "ONI_MCLIENT_TAILSCALE_AUTH_KEY";
/// How long `tailscale up` may take without an auth key: the browser login
/// it prints a URL for, which the Owner completes.
pub const LOGIN_DEADLINE: Duration = Duration::from_secs(300);
/// How long the daemon may take to report `Running` after a start or login.
pub const READY_DEADLINE: Duration = Duration::from_secs(20);
pub const READY_POLL: Duration = Duration::from_secs(1);

/// One command of a platform recipe: a program on the search path and its
/// arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub program: String,
    pub args: Vec<String>,
}

impl Step {
    pub fn new(program: &str, args: &[&str]) -> Self {
        Self {
            program: program.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        }
    }

    pub fn display(&self) -> String {
        std::iter::once(self.program.as_str())
            .chain(self.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// What this platform can do for an absent, stopped or logged-out Tailscale.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Platform {
    /// Commands that install Tailscale, in order; empty when there is no recipe.
    pub install: Vec<Step>,
    /// Where an install leaves the CLI when it is not on the search path.
    pub installed: Vec<PathBuf>,
    /// Commands that start the daemon when `tailscale status` does not answer.
    pub start: Vec<Step>,
    /// The program (and its flags) that runs `tailscale up` with the rights
    /// it needs: `sudo` on Linux, nothing on macOS.
    pub elevate: Vec<String>,
}

impl Platform {
    pub fn current() -> Self {
        Self::for_os(std::env::consts::OS)
    }

    /// Homebrew's cask and the app on macOS; Tailscale's own install script
    /// and systemd on Linux; no recipe elsewhere.
    pub fn for_os(os: &str) -> Self {
        match os {
            "macos" => Self {
                install: vec![Step::new("brew", &["install", "--cask", "tailscale"])],
                installed: vec![PathBuf::from(
                    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                )],
                start: vec![Step::new("open", &["-a", "Tailscale"])],
                elevate: vec![],
            },
            "linux" => Self {
                install: vec![Step::new(
                    "sh",
                    &["-c", "curl -fsSL https://tailscale.com/install.sh | sh"],
                )],
                installed: vec![
                    PathBuf::from("/usr/bin/tailscale"),
                    PathBuf::from("/usr/sbin/tailscale"),
                ],
                start: vec![Step::new("sudo", &["systemctl", "start", "tailscaled"])],
                elevate: vec!["sudo".to_owned()],
            },
            _ => Self::default(),
        }
    }
}

/// Where a join looks for Tailscale and what it may run to bring it up.
#[derive(Clone, Debug)]
pub struct Setup {
    pub search_path: OsString,
    pub platform: Platform,
    pub auth_key: Option<String>,
    pub login_deadline: Duration,
    pub ready_deadline: Duration,
    pub ready_poll: Duration,
}

impl Setup {
    /// The production setup: the process search path, the platform's own
    /// recipe, and the auth key from the option or the variable.
    pub fn from_env(options: &JoinOptions, env: &dyn Fn(&str) -> Option<String>) -> Self {
        Self {
            search_path: env("PATH").unwrap_or_default().into(),
            platform: Platform::current(),
            auth_key: options
                .tailscale_auth_key
                .clone()
                .or_else(|| env(AUTH_KEY_VARIABLE))
                .filter(|key| !key.is_empty()),
            login_deadline: LOGIN_DEADLINE,
            ready_deadline: READY_DEADLINE,
            ready_poll: READY_POLL,
        }
    }
}

/// `BackendState` as `tailscale status --json` reports it.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum State {
    NoState,
    NeedsLogin,
    NeedsMachineAuth,
    Stopped,
    Starting,
    Running,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize)]
struct Status {
    #[serde(rename = "BackendState")]
    backend_state: State,
}

/// One step the join took, as the receipt records it. `via` names the
/// command, location or state, never a credential.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Receipted {
    pub step: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    pub ok: bool,
}

/// Tailscale is running, and these steps got it there; `cli` is the binary
/// the join resolves a bare peer name through.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub state: State,
    pub steps: Vec<Receipted>,
    #[serde(skip_serializing)]
    pub cli: PathBuf,
}

/// Why the join cannot reach `Running` on its own: the wire reason is the
/// snake_case name, and `next_step` is what the Owner finishes by hand.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Reason {
    #[error("tailscale_absent")]
    Absent,
    #[error("tailscale_install_failed")]
    InstallFailed { via: String },
    #[error("tailscale_down")]
    Down { via: Option<String> },
    #[error("tailscale_login_failed")]
    LoginFailed,
    #[error("tailscale_login_timeout")]
    LoginTimeout,
    #[error("tailscale_not_ready")]
    NotReady { state: State },
}

impl Reason {
    pub fn next_step(&self) -> String {
        match self {
            Self::Absent => {
                "install Tailscale (https://tailscale.com/download) and re-join".to_owned()
            }
            Self::InstallFailed { via } => format!(
                "`{via}` did not leave a tailscale binary; install Tailscale by hand and re-join"
            ),
            Self::Down { via: Some(via) } => format!(
                "`{via}` did not bring tailscaled up; start Tailscale and re-join once `tailscale status` answers"
            ),
            Self::Down { via: None } => {
                "start Tailscale and re-join once `tailscale status` answers".to_owned()
            }
            Self::LoginFailed => {
                "`tailscale up` failed; log the node in (or pass --tailscale-auth-key) and re-join"
                    .to_owned()
            }
            Self::LoginTimeout => {
                "finish the browser login `tailscale up` printed (or pass --tailscale-auth-key) and re-join"
                    .to_owned()
            }
            Self::NotReady { state } => {
                format!("tailscale reports {state:?}; re-join once it reports Running")
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{reason}")]
pub struct Refusal {
    pub reason: Reason,
    pub steps: Vec<Receipted>,
}

/// Where the `tailscale` CLI is: the first hit on the search path, then the
/// platform's own install locations.
pub fn locate(search_path: &OsStr, installed: &[PathBuf]) -> Option<PathBuf> {
    std::env::split_paths(search_path)
        .map(|directory| directory.join("tailscale"))
        .chain(installed.iter().cloned())
        .find(|path| path.is_file())
}

fn program(search_path: &OsStr, name: &str) -> Option<PathBuf> {
    std::env::split_paths(search_path)
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
}

/// A child's stdout goes to this process's stderr: the join's stdout is the
/// receipt, and the Owner still sees what an install or login prints.
fn to_stderr() -> io::Result<Stdio> {
    let stderr = std::io::stderr().as_fd().try_clone_to_owned()?;
    Ok(Stdio::from(stderr))
}

struct Run<'a> {
    setup: &'a Setup,
    steps: Vec<Receipted>,
}

impl Run<'_> {
    fn record(&mut self, step: &'static str, via: Option<String>, ok: bool) {
        self.steps.push(Receipted { step, via, ok });
    }

    async fn step(&mut self, name: &'static str, step: &Step) -> bool {
        let ok = match program(&self.setup.search_path, &step.program) {
            Some(binary) => self.command(&binary, &step.args).await.is_ok(),
            None => false,
        };
        self.record(name, Some(step.display()), ok);
        ok
    }

    async fn command(&self, program: &Path, args: &[String]) -> io::Result<()> {
        let status = Command::new(program)
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(to_stderr()?)
            .stderr(Stdio::inherit())
            .status()
            .await?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| io::Error::other(format!("exit {status}")))
    }

    async fn install(&mut self) -> Result<PathBuf, Reason> {
        let recipe = self.setup.platform.install.clone();
        if recipe.is_empty() {
            return Err(Reason::Absent);
        }
        for step in &recipe {
            if !self.step("install", step).await {
                return Err(Reason::InstallFailed {
                    via: step.display(),
                });
            }
        }
        let found = locate(&self.setup.search_path, &self.setup.platform.installed);
        let via = found.as_ref().map(|path| path.display().to_string());
        self.record("locate", via, found.is_some());
        found.ok_or_else(|| Reason::InstallFailed {
            via: "locate after install".to_owned(),
        })
    }

    async fn status(&mut self, binary: &Path) -> Option<State> {
        let output = Command::new(binary)
            .args(["status", "--json"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await
            .ok()
            .filter(|output| output.status.success())?;
        let status = serde_json::from_slice::<Status>(&output.stdout).ok()?;
        Some(status.backend_state)
    }

    async fn daemon(&mut self, binary: &Path) -> Result<State, Reason> {
        if let Some(state) = self.status(binary).await {
            self.record("status", Some(format!("{state:?}")), true);
            return Ok(state);
        }
        self.record("status", None, false);
        let recipe = self.setup.platform.start.clone();
        if recipe.is_empty() {
            return Err(Reason::Down { via: None });
        }
        for step in &recipe {
            if !self.step("start", step).await {
                return Err(Reason::Down {
                    via: Some(step.display()),
                });
            }
        }
        let via = recipe.iter().map(Step::display).collect::<Vec<_>>();
        self.ready(binary).await.ok_or(Reason::Down {
            via: Some(via.join("; ")),
        })
    }

    async fn ready(&mut self, binary: &Path) -> Option<State> {
        let started = Instant::now();
        loop {
            let state = self.status(binary).await;
            self.record("status", state.map(|state| format!("{state:?}")), state.is_some());
            if state == Some(State::Running) || started.elapsed() >= self.setup.ready_deadline {
                return state;
            }
            tokio::time::sleep(self.setup.ready_poll).await;
        }
    }

    async fn up(&mut self, binary: &Path) -> Result<(), Reason> {
        let (via, mut args) = match &self.setup.auth_key {
            Some(key) => ("auth-key", vec!["up".to_owned(), format!("--auth-key={key}")]),
            None => ("login", vec!["up".to_owned()]),
        };
        let program = match self.setup.platform.elevate.split_first() {
            Some((elevate, flags)) => {
                let prefix = flags.iter().cloned().chain([binary.display().to_string()]);
                args.splice(0..0, prefix);
                program(&self.setup.search_path, elevate)
            }
            None => Some(binary.to_path_buf()),
        };
        let outcome = match program {
            Some(program) => self.login(&program, &args).await,
            None => Err(Reason::LoginFailed),
        };
        self.record("up", Some(via.to_owned()), outcome.is_ok());
        outcome
    }

    async fn login(&self, program: &Path, args: &[String]) -> Result<(), Reason> {
        let stdout = to_stderr().map_err(|_| Reason::LoginFailed)?;
        let child = Command::new(program)
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(stdout)
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| Reason::LoginFailed)?;
        match tokio::time::timeout(self.setup.login_deadline, child.wait_with_output()).await {
            Ok(Ok(output)) if output.status.success() => Ok(()),
            Ok(_) => Err(Reason::LoginFailed),
            Err(_) => Err(Reason::LoginTimeout),
        }
    }

    async fn run(&mut self) -> Result<PathBuf, Reason> {
        let located = locate(&self.setup.search_path, &self.setup.platform.installed);
        let via = located.as_ref().map(|path| path.display().to_string());
        self.record("locate", via, located.is_some());
        let binary = match located {
            Some(binary) => binary,
            None => self.install().await?,
        };
        if self.daemon(&binary).await? == State::Running {
            return Ok(binary);
        }
        self.up(&binary).await?;
        match self.ready(&binary).await {
            Some(State::Running) => Ok(binary),
            Some(state) => Err(Reason::NotReady { state }),
            None => Err(Reason::Down { via: None }),
        }
    }
}

/// Brings Tailscale to `Running` for a tailnet-mode join, or refuses with
/// the step the Owner finishes by hand; the steps taken are in the receipt
/// either way.
pub async fn ensure(setup: &Setup) -> Result<Receipt, Refusal> {
    let mut run = Run {
        setup,
        steps: Vec::new(),
    };
    match run.run().await {
        Ok(cli) => Ok(Receipt {
            state: State::Running,
            steps: run.steps,
            cli,
        }),
        Err(reason) => Err(Refusal {
            reason,
            steps: run.steps,
        }),
    }
}
