pub mod fixture;
#[cfg(target_os = "macos")]
mod native;

use std::{
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    time::{Duration, Instant},
};

use oni_protocol::AppLaunchRequest;
use serde_json::{json, Value};

use crate::screen::{ax::AppIdentity, observe::Target, Screen};

pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
pub const MAX_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, PartialEq, Eq)]
pub enum Fault {
    NotFound,
    ProcessNotFound,
    Permission,
    Excluded,
    Unsupported(&'static str),
    Failed(String),
    Timeout,
}

impl Fault {
    pub fn value(&self) -> Value {
        match self {
            Self::NotFound => json!({"status":"refused","reason":"app_not_found"}),
            Self::ProcessNotFound => json!({"status":"refused","reason":"process_not_found"}),
            Self::Permission => json!({"status":"refused","reason":"permission_denied"}),
            Self::Excluded => json!({"status":"refused","reason":"excluded"}),
            Self::Unsupported(blocker) => {
                json!({"status":"refused","reason":"unsupported","blocker":blocker})
            }
            Self::Failed(message) => {
                json!({"status":"refused","reason":"unsupported","blocker":"launch_failed","message":message.chars().take(256).collect::<String>()})
            }
            Self::Timeout => {
                json!({"status":"refused","reason":"unsupported","blocker":"launch_timeout"})
            }
        }
    }
}

pub trait Launcher: Send + Sync {
    fn resolve(&self, request: &AppLaunchRequest) -> Result<Resolved, Fault>;
    fn start(
        &self,
        request: &AppLaunchRequest,
        resolved: &Resolved,
        reply: Sender<Result<u32, Fault>>,
    ) -> Result<(), Fault>;
    fn identity(&self, pid: u32) -> Result<AppIdentity, Fault>;
    fn quit(&self, pid: u32) -> Result<bool, Fault>;
}

pub struct Unavailable;

pub struct Resolved {
    pub identity: AppIdentity,
    pub running_pid: Option<u32>,
    pub bundle_path: String,
}

impl Launcher for Unavailable {
    fn resolve(&self, _: &AppLaunchRequest) -> Result<Resolved, Fault> {
        Err(Fault::Unsupported("platform"))
    }
    fn identity(&self, _: u32) -> Result<AppIdentity, Fault> {
        Err(Fault::Unsupported("platform"))
    }
    fn start(
        &self,
        _: &AppLaunchRequest,
        _: &Resolved,
        _: Sender<Result<u32, Fault>>,
    ) -> Result<(), Fault> {
        Err(Fault::Unsupported("platform"))
    }

    fn quit(&self, _: u32) -> Result<bool, Fault> {
        Err(Fault::Unsupported("platform"))
    }
}

pub fn platform() -> Box<dyn Launcher> {
    #[cfg(target_os = "macos")]
    {
        Box::new(native::Native)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(Unavailable)
    }
}

pub fn timeout(milliseconds: Option<u64>) -> Duration {
    Duration::from_millis(
        milliseconds
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, MAX_TIMEOUT_MS),
    )
}

pub fn completed(
    receiver: &Receiver<Result<u32, Fault>>,
    remaining: Duration,
) -> Result<u32, Fault> {
    match receiver.recv_timeout(remaining) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(Fault::Timeout),
        Err(RecvTimeoutError::Disconnected) => {
            Err(Fault::Failed("launch completion disconnected".into()))
        }
    }
}

pub fn completion(pid: Option<u32>, error: Option<String>) -> Result<u32, Fault> {
    match error {
        Some(error) => Err(Fault::Failed(error)),
        None => pid
            .filter(|pid| *pid > 0)
            .ok_or_else(|| Fault::Failed("launch returned no process".into())),
    }
}

pub fn excluded(pid: u32, app: &AppIdentity, owners: &[String]) -> bool {
    pid == std::process::id()
        || owners
            .iter()
            .any(|owner| app.bundle_id.as_ref() == Some(owner) || app.path == *owner)
}

pub trait Clock {
    fn now(&self) -> Instant;
    fn wait(&self, duration: Duration);
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn wait(&self, duration: Duration) {
        std::thread::park_timeout(duration);
    }
}

pub fn discover(
    clock: &impl Clock,
    deadline: Instant,
    mut windows: impl FnMut() -> Result<Vec<Value>, Fault>,
) -> Result<Vec<Value>, Fault> {
    loop {
        let found = windows()?;
        let remaining = deadline.saturating_duration_since(clock.now());
        if !found.is_empty() || remaining.is_zero() {
            return Ok(found);
        }
        clock.wait(remaining.min(Duration::from_millis(50)));
    }
}

pub fn launch(screen: &Screen, request: &AppLaunchRequest) -> Value {
    let attempt = || {
        let resolved = screen.launcher.resolve(request)?;
        if excluded(
            resolved.running_pid.unwrap_or(0),
            &resolved.identity,
            &screen.excluded_owners,
        ) {
            return Err(Fault::Excluded);
        }
        screen.windows_for_pid(0).map_err(|error| match error {
            crate::screen::observe::Refusal::Permission => Fault::Permission,
            crate::screen::observe::Refusal::NotAvailable => Fault::Unsupported("platform"),
            other => Fault::Failed(other.reason().to_owned()),
        })?;
        let deadline = Instant::now() + timeout(request.timeout_ms.map(|value| value.get()));
        let (sender, receiver) = mpsc::channel();
        screen.launcher.start(request, &resolved, sender)?;
        let pid = completed(
            &receiver,
            deadline.saturating_duration_since(Instant::now()),
        )?;
        let windows = discover(&SystemClock, deadline, || {
            screen.windows_for_pid(pid).map_err(|error| match error {
                crate::screen::observe::Refusal::Permission => Fault::Permission,
                other => Fault::Failed(other.reason().to_owned()),
            })
        })
        .unwrap_or_default();
        Ok(json!({"status":"ok","pid":pid,"windows":windows}))
    };
    attempt().unwrap_or_else(|fault| fault.value())
}

pub fn quit(screen: &Screen, pid: u32) -> Value {
    let attempt = || {
        let identity = screen.launcher.identity(pid)?;
        if excluded(pid, &identity, &screen.excluded_owners) {
            return Err(Fault::Excluded);
        }
        screen.launcher.quit(pid)
    };
    attempt().map_or_else(
        |fault| fault.value(),
        |exited| json!({"status":"ok","exited":exited}),
    )
}

pub fn window(screen: &Screen, target: Target, park: bool) -> Value {
    let (window, _) = match screen.window_target(target) {
        Ok(window) => window,
        Err(crate::screen::observe::Refusal::NotAvailable) => {
            return Fault::Unsupported("platform").value()
        }
        Err(crate::screen::observe::Refusal::Failed(message)) => {
            return Fault::Failed(message).value()
        }
        Err(fault) => return fault.acted(),
    };
    if excluded(window.pid, &window.app, &screen.excluded_owners) {
        return Fault::Excluded.value();
    }
    let result = screen.lifecycle(&window, park);
    if park {
        return json!({"status":"ok","parked":result.is_ok()});
    }
    result.map_or_else(
        |fault| match fault {
            crate::screen::ax::ActFault::Permission => Fault::Permission.value(),
            crate::screen::ax::ActFault::NotFound => {
                json!({"status":"refused","reason":"window_not_found"})
            }
            crate::screen::ax::ActFault::Unsupported => Fault::Unsupported("platform").value(),
            crate::screen::ax::ActFault::Failed(message) => Fault::Failed(message).value(),
        },
        |()| json!({"status":"ok","closed":true}),
    )
}

pub fn termination(
    clock: &impl Clock,
    mut signal: impl FnMut(bool) -> Result<(), nix::errno::Errno>,
) -> Result<bool, Fault> {
    use nix::errno::Errno;
    signal(true).map_err(|error| match error {
        Errno::ESRCH => Fault::ProcessNotFound,
        Errno::EPERM => Fault::Permission,
        other => Fault::Failed(other.to_string()),
    })?;
    let deadline = clock.now() + Duration::from_secs(2);
    loop {
        match signal(false) {
            Err(Errno::ESRCH) => return Ok(true),
            Err(Errno::EPERM) => return Err(Fault::Permission),
            Err(error) => return Err(Fault::Failed(error.to_string())),
            Ok(()) => {}
        }
        let remaining = deadline.saturating_duration_since(clock.now());
        if remaining.is_zero() {
            return Ok(false);
        }
        clock.wait(remaining.min(Duration::from_millis(50)));
    }
}

#[cfg(test)]
mod tests;
