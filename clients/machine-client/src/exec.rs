//! Confined shell execution with bounded output and process-group cleanup.

use std::future::Future;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;
#[cfg(target_os = "macos")]
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, PoisonError},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use oni_protocol::{ExecRequest, ExecResult};
use serde_json::json;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::watch;
#[cfg(target_os = "macos")]
use tokio::sync::Notify;

const MAX_OUTPUT: usize = 262_144;
pub const DEFAULT_DEADLINE: Duration = Duration::from_millis(30_000);

/// The pre-exec hook of a Linux child: arm the parent-death signal, then
/// confirm the parent is still the process that forked us, because a parent
/// that died in between never triggers the signal.
#[cfg(target_os = "linux")]
fn death_guard(
    parent: Pid,
    signal: i32,
) -> impl FnMut() -> std::io::Result<()> + Send + Sync + 'static {
    move || {
        // SAFETY: prctl takes integer arguments only and retains no Rust pointers.
        if unsafe { nix::libc::prctl(nix::libc::PR_SET_PDEATHSIG, signal) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
        if nix::unistd::getppid() != parent {
            return Err(std::io::Error::from_raw_os_error(nix::libc::ESRCH));
        }
        Ok(())
    }
}

pub struct Exec {
    deadline: Duration,
    #[cfg(target_os = "macos")]
    groups: Arc<Groups>,
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct Groups {
    pids: Mutex<HashSet<Pid>>,
    finished: Notify,
}

impl Exec {
    pub fn new(deadline: Duration) -> Self {
        Self {
            deadline,
            #[cfg(target_os = "macos")]
            groups: Arc::new(Groups::default()),
        }
    }

    pub async fn shutdown(&self) {
        #[cfg(target_os = "macos")]
        loop {
            // macOS has no parent-death signal: graceful detach kills recorded
            // groups, but SIGKILL of the client cannot run this cleanup.
            let notified = self.groups.finished.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let pids = self
                .groups
                .pids
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if pids.is_empty() {
                break;
            }
            for pid in pids {
                let _ = killpg(pid, Signal::SIGKILL);
            }
            if tokio::time::timeout(Duration::from_secs(2), &mut notified)
                .await
                .is_err()
            {
                break;
            }
        }
    }

    pub fn detach(&self) {
        #[cfg(target_os = "macos")]
        for pid in self
            .groups
            .pids
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
        {
            let _ = killpg(*pid, Signal::SIGKILL);
        }
    }
}

#[derive(Debug, Error)]
pub enum ExecError {
    #[error("could not encode execution result: {0}")]
    Result(#[from] serde_json::Error),
    #[error("could not wait for shell: {0}")]
    Wait(#[from] std::io::Error),
}

fn result(value: serde_json::Value) -> Result<ExecResult, ExecError> {
    serde_json::from_value(value).map_err(ExecError::from)
}

#[derive(Debug)]
struct Captured {
    out: Vec<u8>,
    err: Vec<u8>,
    truncated: bool,
}

/// Drain both streams under one shared byte budget; stop at the first overflow.
async fn read_streams(
    stdout: &mut (dyn AsyncRead + Unpin + Send),
    stderr: &mut (dyn AsyncRead + Unpin + Send),
) -> std::io::Result<Captured> {
    let mut captured = Captured {
        out: Vec::new(),
        err: Vec::new(),
        truncated: false,
    };
    let mut out_done = false;
    let mut err_done = false;
    let mut out_buffer = [0u8; 8192];
    let mut err_buffer = [0u8; 8192];
    while !out_done || !err_done {
        let (is_stdout, read) = tokio::select! {
            read = stdout.read(&mut out_buffer), if !out_done => (true, read?),
            read = stderr.read(&mut err_buffer), if !err_done => (false, read?),
        };
        if read == 0 {
            if is_stdout {
                out_done = true;
            } else {
                err_done = true;
            }
            continue;
        }
        let remaining = MAX_OUTPUT.saturating_sub(captured.out.len() + captured.err.len());
        if is_stdout {
            captured
                .out
                .extend_from_slice(&out_buffer[..read.min(remaining)]);
        } else {
            captured
                .err
                .extend_from_slice(&err_buffer[..read.min(remaining)]);
        }
        if read > remaining {
            captured.truncated = true;
            break;
        }
    }
    Ok(captured)
}

/// A dropped execution still kills its detached process group.
struct ProcessGroup {
    pid: Option<Pid>,
    #[cfg(target_os = "macos")]
    groups: Arc<Groups>,
}

impl ProcessGroup {
    fn kill(&self) {
        if let Some(pid) = self.pid {
            let _ = killpg(pid, Signal::SIGKILL);
        }
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.kill();
        #[cfg(target_os = "macos")]
        if let Some(pid) = self.pid {
            self.groups
                .pids
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&pid);
            self.groups.finished.notify_waiters();
        }
    }
}

pub(crate) fn confined(cwd: &str, exports: &[PathBuf]) -> Option<PathBuf> {
    let requested = Path::new(cwd);
    if !requested.is_absolute()
        || requested
            .components()
            .any(|part| part == std::path::Component::ParentDir)
    {
        return None;
    }
    let canonical = requested.canonicalize().ok()?;
    exports
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| canonical.starts_with(root))
        .then_some(canonical)
}

/// Run a shell only inside an effective attached export. The caller owns the
/// cancellation sender; dropping this future also kills its process group.
impl Exec {
    pub async fn execute(
        &self,
        request: &ExecRequest,
        exports: &[PathBuf],
        cancelled: watch::Receiver<bool>,
    ) -> Result<ExecResult, ExecError> {
        execute(
            request,
            exports,
            cancelled,
            std::pin::pin!(tokio::time::sleep(self.deadline)),
            #[cfg(target_os = "macos")]
            self.groups.clone(),
        )
        .await
    }
}

async fn execute(
    request: &ExecRequest,
    exports: &[PathBuf],
    mut cancelled: watch::Receiver<bool>,
    deadline: Pin<&mut (dyn Future<Output = ()> + Send)>,
    #[cfg(target_os = "macos")] groups: Arc<Groups>,
) -> Result<ExecResult, ExecError> {
    let Some(cwd) = confined(&request.cwd, exports) else {
        return result(json!({"status":"refused","reason":"path_escapes_export"}));
    };
    if *cancelled.borrow() {
        return result(json!({"status":"cancelled"}));
    }
    let mut command = shell_command(&cwd, request.cmd.as_str());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return result(json!({"status":"refused","reason":"io_error"})),
    };
    let pid = child
        .id()
        .and_then(|id| i32::try_from(id).ok())
        .map(Pid::from_raw);
    #[cfg(target_os = "macos")]
    if let Some(pid) = pid {
        groups
            .pids
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(pid);
    }
    let mut guard = ProcessGroup {
        pid,
        #[cfg(target_os = "macos")]
        groups,
    };
    // Successful spawn with Stdio::piped always supplies both handles.
    let mut stdout = child.stdout.take().expect("stdout configured as piped");
    let mut stderr = child.stderr.take().expect("stderr configured as piped");
    let capture = async {
        let captured = read_streams(&mut stdout, &mut stderr).await;
        // Overflow and a failed read both end the shell's process group.
        if captured
            .as_ref()
            .map_or(true, |captured| captured.truncated)
        {
            guard.kill();
        }
        let status = child.wait().await;
        captured.and_then(|captured| status.map(|status| (captured, status)))
    };
    let cancellation = async {
        if cancelled.wait_for(|value| *value).await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    let outcome = tokio::select! {
        () = deadline => {
            guard.kill();
            return child
                .wait()
                .await
                .map_err(ExecError::from)
                .and_then(|_| result(json!({"status":"timed_out"})));
        }
        () = cancellation => {
            guard.kill();
            return child
                .wait()
                .await
                .map_err(ExecError::from)
                .and_then(|_| result(json!({"status":"cancelled"})));
        }
        outcome = capture => outcome,
    };
    outcome
        .map_err(ExecError::from)
        .and_then(|(captured, status)| {
            // A clean exit leaves the shell's own process group alone. Cancellation,
            // overflow, and deadline paths kill the group before waiting.
            if !captured.truncated {
                guard.pid = None;
                #[cfg(target_os = "macos")]
                if let Some(pid) = pid {
                    guard
                        .groups
                        .pids
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .remove(&pid);
                    guard.groups.finished.notify_waiters();
                }
            }
            let signal = match status.signal() {
                Some(9) => Some("SIGKILL".to_owned()),
                Some(number) => Some(format!("SIG{number}")),
                None => None,
            };
            result(json!({
                "status": "completed",
                "stdout": STANDARD.encode(captured.out),
                "stderr": STANDARD.encode(captured.err),
                "exitCode": status.code(),
                "signal": signal,
                "truncated": captured.truncated
            }))
        })
}

fn shell_command(cwd: &Path, cmd: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(cmd)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.process_group(0);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = nix::unistd::getpid();
        // SAFETY: pre_exec runs in the forked child. The hook only invokes
        // async-signal-safe syscalls, with no allocation or acquired locks.
        unsafe {
            command
                .as_std_mut()
                .pre_exec(death_guard(parent, nix::libc::SIGKILL))
        };
    }
    command
}

#[cfg(test)]
#[path = "../tests/support/blocked_shell.rs"]
pub(crate) mod blocked_shell;

#[cfg(test)]
mod tests {
    use super::*;
    use blocked_shell::BlockedShell;

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn shutdown_stops_waiting_when_a_tracked_group_never_finishes() {
        let exec = Exec::new(DEFAULT_DEADLINE);
        exec.groups
            .pids
            .lock()
            .expect("groups")
            .insert(Pid::from_raw(i32::MAX));
        tokio::time::timeout(Duration::from_secs(5), exec.shutdown())
            .await
            .expect("shutdown's bounded wait");
        assert_eq!(exec.groups.pids.lock().expect("groups").len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn detach_sends_kill_to_tracked_groups_without_clearing_them() {
        let exec = Exec::new(DEFAULT_DEADLINE);
        exec.groups
            .pids
            .lock()
            .expect("groups")
            .insert(Pid::from_raw(i32::MAX));

        exec.detach();

        assert_eq!(exec.groups.pids.lock().expect("groups").len(), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parent_death_guard_reports_syscall_and_parent_races() {
        // Signal 0 clears a parent-death signal this process never armed, so
        // the hook runs in-process without side effects.
        let parent = nix::unistd::getppid();
        let mut invalid = death_guard(parent, -1);
        assert_eq!(
            invalid().expect_err("invalid signal").raw_os_error(),
            Some(nix::libc::EINVAL)
        );
        let mut changed = death_guard(Pid::from_raw(i32::MAX), 0);
        assert_eq!(
            changed().expect_err("parent changed").raw_os_error(),
            Some(nix::libc::ESRCH)
        );
        let mut alive = death_guard(parent, 0);
        alive().expect("parent still alive");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn shutdown_kills_and_reaps_tracked_shell_group() {
        let shell = BlockedShell::new(false);
        let request = ExecRequest {
            cmd: shell.command.parse().expect("command"),
            cwd: shell.root.path().to_str().expect("utf8").into(),
        };
        let exec = Exec::new(DEFAULT_DEADLINE);
        let (_sender, receiver) = watch::channel(false);
        let exports = [shell.root.path().to_owned()];
        let run = exec.execute(&request, &exports, receiver);
        let shutdown = async {
            shell.started().await;
            exec.shutdown().await;
        };
        let (_result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(run, shutdown)
        })
        .await
        .expect("shell shutdown");
        assert!(exec.groups.pids.lock().expect("groups").is_empty());
    }

    #[tokio::test]
    async fn exec_reports_nonzero_exit_and_signal() {
        let root = tempfile::tempdir().expect("export");
        for (cmd, code, signal) in [
            ("printf out; printf err >&2; exit 7", Some(7), None),
            ("kill -TERM $$", None, Some("SIG15")),
            ("kill -KILL $$", None, Some("SIGKILL")),
            (
                "while :; do printf 'xxxxxxxxxxxxxxxx'; done",
                None,
                Some("SIGKILL"),
            ),
        ] {
            let request = ExecRequest {
                cmd: cmd.parse().expect("command"),
                cwd: root.path().to_str().expect("utf8").into(),
            };
            let (_sender, receiver) = watch::channel(false);
            let outcome = Exec::new(DEFAULT_DEADLINE)
                .execute(&request, &[root.path().to_owned()], receiver)
                .await
                .expect("execution");
            let body = serde_json::to_value(outcome).expect("wire");
            assert_eq!(body["exitCode"], json!(code));
            assert_eq!(body["signal"], json!(signal));
        }
    }

    #[tokio::test]
    async fn exec_inherits_client_path() {
        let root = tempfile::tempdir().expect("export");
        let request = ExecRequest {
            cmd: "printf '%s' \"$PATH\"".parse().expect("command"),
            cwd: root.path().to_str().expect("utf8").into(),
        };
        let (_sender, receiver) = watch::channel(false);
        let result = Exec::new(DEFAULT_DEADLINE)
            .execute(&request, &[root.path().to_owned()], receiver)
            .await
            .expect("execution");
        let wire = serde_json::to_value(result).expect("wire");
        let output = STANDARD
            .decode(wire["stdout"].as_str().expect("stdout"))
            .expect("base64 stdout");
        assert_eq!(
            output,
            std::env::var_os("PATH")
                .unwrap_or_default()
                .as_encoded_bytes()
        );
    }

    #[tokio::test]
    async fn deadline_kills_started_shell_with_open_or_closed_output() {
        for close_output in [false, true] {
            let shell = BlockedShell::new(close_output);
            let request = ExecRequest {
                cmd: shell.command.parse().expect("command"),
                cwd: shell.root.path().to_str().expect("utf8").into(),
            };
            let (_sender, receiver) = watch::channel(false);
            let outcome = tokio::time::timeout(
                Duration::from_secs(5),
                execute(
                    &request,
                    &[shell.root.path().to_owned()],
                    receiver,
                    std::pin::pin!(shell.started()),
                    #[cfg(target_os = "macos")]
                    Arc::new(Groups::default()),
                ),
            )
            .await
            .expect("startup and deadline")
            .expect("execution");
            assert_eq!(
                serde_json::to_value(outcome).expect("wire"),
                json!({"status":"timed_out"})
            );
        }
    }

    #[tokio::test]
    async fn execute_refuses_or_cancels_around_spawn() {
        let shell = BlockedShell::new(false);
        let root = shell.root.path();
        let file = root.join("file");
        std::fs::write(&file, "").expect("file inside export");
        let exports = [root.to_owned()];
        for (cwd, preset, expected) in [
            (
                "relative",
                false,
                json!({"status":"refused","reason":"path_escapes_export"}),
            ),
            (
                root.to_str().expect("utf8"),
                true,
                json!({"status":"cancelled"}),
            ),
            (
                file.to_str().expect("utf8"),
                false,
                json!({"status":"refused","reason":"io_error"}),
            ),
        ] {
            let request = ExecRequest {
                cmd: "printf must-not-run".parse().expect("command"),
                cwd: cwd.into(),
            };
            let (_sender, receiver) = watch::channel(preset);
            let outcome = execute(
                &request,
                &exports,
                receiver,
                std::pin::pin!(std::future::pending()),
                #[cfg(target_os = "macos")]
                Arc::new(Groups::default()),
            )
            .await
            .expect("execution");
            assert_eq!(serde_json::to_value(outcome).expect("wire"), expected);
        }
        let request = ExecRequest {
            cmd: shell.command.parse().expect("command"),
            cwd: root.to_str().expect("utf8").into(),
        };
        let (sender, receiver) = watch::channel(false);
        let deadline = std::pin::pin!(std::future::pending());
        let run = execute(
            &request,
            &exports,
            receiver,
            deadline,
            #[cfg(target_os = "macos")]
            Arc::new(Groups::default()),
        );
        let cancel = async {
            shell.started().await;
            sender.send(true).expect("execution still running");
        };
        let (outcome, ()) =
            tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(run, cancel) })
                .await
                .expect("startup and cancellation");
        assert_eq!(
            serde_json::to_value(outcome.expect("execution")).expect("wire"),
            json!({"status":"cancelled"})
        );
    }

    struct FailedReader;

    impl AsyncRead for FailedReader {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buffer: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(std::io::Error::other("broken pipe")))
        }
    }

    #[tokio::test]
    async fn capture_reports_read_failure_on_either_stream() {
        let stdout_failure = read_streams(&mut FailedReader, &mut &b""[..]).await;
        let stderr_failure = read_streams(&mut &b""[..], &mut FailedReader).await;
        for outcome in [stdout_failure, stderr_failure] {
            assert_eq!(
                outcome.expect_err("read failure").to_string(),
                "broken pipe"
            );
        }
    }
}
