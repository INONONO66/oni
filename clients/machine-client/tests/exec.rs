use std::path::PathBuf;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use nix::sys::signal::killpg;
use nix::unistd::Pid;
use oni_machine_client::exec::{Exec, DEFAULT_DEADLINE};
use oni_protocol::{ExecRequest, ExecResult};
use tempfile::tempdir;
use tokio::sync::watch;

#[path = "support/blocked_shell.rs"]
mod blocked_shell;
use blocked_shell::BlockedShell;

fn request(cmd: &str, cwd: &str) -> ExecRequest {
    ExecRequest {
        cmd: cmd.parse().expect("valid shell command"),
        cwd: cwd.to_owned(),
    }
}

async fn run(cmd: &str, cwd: &str, exports: &[PathBuf]) -> serde_json::Value {
    let (_sender, receiver) = watch::channel(false);
    let result = Exec::new(DEFAULT_DEADLINE)
        .execute(&request(cmd, cwd), exports, receiver)
        .await
        .expect("typed outcome");
    serde_json::to_value(result).expect("wire result")
}

#[tokio::test]
async fn exec_returns_base64_output_when_cwd_is_confined() {
    let root = tempdir().expect("temp export");
    let cwd = root.path().to_str().expect("utf8 temp path");
    let result = run(
        "printf hello; printf error >&2",
        cwd,
        &[root.path().to_owned()],
    )
    .await;
    assert_eq!(result["status"], "completed");
    assert_eq!(
        STANDARD
            .decode(result["stdout"].as_str().expect("stdout"))
            .expect("base64"),
        b"hello"
    );
    assert_eq!(
        STANDARD
            .decode(result["stderr"].as_str().expect("stderr"))
            .expect("base64"),
        b"error"
    );
    assert_eq!(result["exitCode"], 0);
}

#[tokio::test]
async fn exec_refuses_symlink_escape_and_parent_directory() {
    let root = tempdir().expect("temp export");
    let outside = tempdir().expect("outside");
    std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).expect("symlink");
    for cwd in [root.path().join("escape"), root.path().join("..")] {
        let result = run(
            "printf must-not-run",
            cwd.to_str().expect("utf8"),
            &[root.path().to_owned()],
        )
        .await;
        assert_eq!(result["reason"], "path_escapes_export");
    }
}

#[tokio::test]
async fn exec_refuses_relative_or_missing_export() {
    let root = tempdir().expect("temp export");
    let missing = root.path().join("missing");
    for (cwd, exports) in [
        ("relative", vec![root.path().to_owned()]),
        (root.path().to_str().expect("utf8"), Vec::new()),
        (
            missing.to_str().expect("utf8"),
            vec![root.path().to_owned()],
        ),
    ] {
        let answer = run("printf must-not-run", cwd, &exports).await;
        assert_eq!(answer["reason"], "path_escapes_export");
    }
}

#[tokio::test]
async fn exec_kills_process_group_when_output_overflows() {
    let root = tempdir().expect("temp export");
    let result = run(
        "printf '%s\\n' \"$$\"; while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done",
        root.path().to_str().expect("utf8"),
        &[root.path().to_owned()],
    )
    .await;
    assert_eq!(result["status"], "completed");
    assert_eq!(result["truncated"], true);
    let stdout = STANDARD
        .decode(result["stdout"].as_str().expect("stdout"))
        .expect("base64");
    assert_eq!(stdout.len(), 262_144);
    let line = stdout
        .split(|byte| *byte == b'\n')
        .next()
        .expect("pid line");
    let pid: i32 = std::str::from_utf8(line)
        .expect("utf8 pid")
        .parse()
        .expect("shell pid");
    assert_eq!(
        killpg(Pid::from_raw(pid), None),
        Err(nix::errno::Errno::ESRCH)
    );
}

#[tokio::test]
async fn exec_returns_cancelled_when_signal_is_already_set() {
    let root = tempdir().expect("temp export");
    let (_sender, receiver) = watch::channel(true);
    let result = Exec::new(DEFAULT_DEADLINE)
        .execute(
            &request("printf must-not-run", root.path().to_str().expect("utf8")),
            &[root.path().to_owned()],
            receiver,
        )
        .await
        .expect("typed outcome");
    assert_eq!(
        serde_json::to_value(result).expect("wire")["status"],
        "cancelled"
    );
}

async fn cancel_after_child_starts(close_output: bool) {
    let shell = BlockedShell::new(close_output);
    let (sender, receiver) = watch::channel(false);
    let execution = Exec::new(DEFAULT_DEADLINE);
    let cwd = shell.root.path().to_str().expect("utf8");
    let command_request = request(&shell.command, cwd);
    let exports = [shell.root.path().to_owned()];
    let run = execution.execute(&command_request, &exports, receiver);
    let cancel = async {
        shell.started().await;
        sender.send(true).expect("execution still running");
    };
    let (result, ()) =
        tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(run, cancel) })
            .await
            .expect("child startup and cancellation");
    assert!(matches!(
        result.expect("typed outcome"),
        ExecResult::Variant2 {
            status: oni_protocol::exec_result::ExecResultVariant2Status::Cancelled
        }
    ));
}

#[tokio::test]
async fn exec_cancels_running_child_after_startup_signal() {
    cancel_after_child_starts(false).await;
}

#[tokio::test]
async fn exec_cancels_running_child_after_output_closes() {
    cancel_after_child_starts(true).await;
}

#[tokio::test]
async fn exec_runs_when_cancellation_sender_is_dropped() {
    let root = tempdir().expect("temp export");
    let (sender, receiver) = watch::channel(false);
    drop(sender);
    let result = Exec::new(DEFAULT_DEADLINE)
        .execute(
            &request("printf ready", root.path().to_str().expect("utf8")),
            &[root.path().to_owned()],
            receiver,
        )
        .await
        .expect("typed outcome");
    assert_eq!(
        serde_json::to_value(result).expect("wire")["status"],
        "completed"
    );
}

#[tokio::test]
async fn exec_refuses_when_cwd_is_a_file() {
    let root = tempdir().expect("temp export");
    let file = root.path().join("file");
    std::fs::write(&file, "").expect("file inside export");
    let result = run(
        "printf must-not-run",
        file.to_str().expect("utf8"),
        &[root.path().to_owned()],
    )
    .await;
    assert_eq!(result["status"], "refused");
    assert_eq!(result["reason"], "io_error");
}

#[tokio::test]
async fn exec_does_not_inherit_host_environment() {
    let root = tempdir().expect("temp export");
    let result = run(
        "printf '%s' \"${HOME-unset}:${PATH}\"",
        root.path().to_str().expect("utf8"),
        &[root.path().to_owned()],
    )
    .await;
    let bytes = STANDARD
        .decode(result["stdout"].as_str().expect("stdout"))
        .expect("base64");
    assert_eq!(bytes, b"unset:/usr/bin:/bin");
}
