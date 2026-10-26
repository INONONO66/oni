use std::{
    path::PathBuf,
    process::Stdio,
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};

use nix::{
    sys::signal::{kill, Signal},
    unistd::Pid,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

pub const OUTPUT_LIMIT: usize = 65_536;
const SOURCE: &str = include_str!("driver.py");

#[derive(Debug, thiserror::Error)]
pub enum CodeError {
    #[error("python driver spawn failed: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("invalid python driver frame: {0}")]
    Frame(String),
    #[error("python driver exited mid-cell")]
    Exited,
    #[error("cell {0} is already running")]
    Duplicate(String),
    #[error("python driver I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

/// Every malformed JSON, schema refusal or lost tool-call task is one
/// `Frame` failure: the driver protocol, not the cell, is at fault.
impl From<serde_json::Error> for CodeError {
    fn from(error: serde_json::Error) -> Self {
        Self::Frame(error.to_string())
    }
}

impl From<oni_protocol::DecodeError> for CodeError {
    fn from(error: oni_protocol::DecodeError) -> Self {
        Self::Frame(error.to_string())
    }
}

impl From<tokio::task::JoinError> for CodeError {
    fn from(error: tokio::task::JoinError) -> Self {
        Self::Frame(error.to_string())
    }
}

/// A closed request pipe means the interpreter is gone; anything else is I/O.
fn write_failure(error: std::io::Error) -> CodeError {
    if error.kind() == std::io::ErrorKind::BrokenPipe {
        CodeError::Exited
    } else {
        CodeError::Io(error)
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Frame {
    Output {
        #[serde(rename = "cellId")]
        cell_id: String,
        stream: Stream,
        text: String,
        #[serde(rename = "originalBytes")]
        original_bytes: usize,
    },
    ToolCall {
        #[serde(rename = "cellId")]
        cell_id: String,
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        arguments: Value,
    },
    Result {
        result: Value,
    },
    Lifecycle,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

pub struct Driver {
    pub child: Child,
    pub stdin: ChildStdin,
    pub lines: Lines<BufReader<ChildStdout>>,
}

impl Driver {
    pub fn available() -> bool {
        std::process::Command::new("python3")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    pub fn signal(pid: &AtomicU32, kind: Signal) {
        let pid = i32::try_from(pid.load(Ordering::Acquire)).unwrap_or(0);
        if pid > 0 {
            let _ = kill(Pid::from_raw(pid), kind);
        }
    }

    pub async fn spawn(command: &PathBuf) -> Result<Self, CodeError> {
        let mut child = Command::new(command)
            .args(["-u", "-c", SOURCE])
            .env("ONI_CELL_OUTPUT_MAX_BYTES", OUTPUT_LIMIT.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(CodeError::Spawn)?;
        let stdin = child.stdin.take().ok_or(CodeError::Exited)?;
        let stdout = child.stdout.take().ok_or(CodeError::Exited)?;
        Ok(Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
        })
    }

    pub async fn send(&mut self, frame: &Value) -> Result<(), CodeError> {
        let mut bytes = serde_json::to_vec(frame)?;
        bytes.push(b'\n');
        self.stdin.write_all(&bytes).await.map_err(write_failure)
    }

    /// Closes the request pipe so an idle driver leaves on EOF, then kills
    /// one that is still inside a cell when the grace runs out.
    pub async fn reap(self, grace: Duration) {
        let Self {
            mut child,
            stdin,
            lines,
        } = self;
        drop(stdin);
        drop(lines);
        if timeout(grace, child.wait()).await.is_err() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    pub async fn next(&mut self) -> Result<Frame, CodeError> {
        let line = self.lines.next_line().await?.ok_or(CodeError::Exited)?;
        Ok(serde_json::from_str(&line)?)
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn a_lost_tool_call_task_is_a_frame_failure() {
        let mut calls = tokio::task::JoinSet::new();
        calls.spawn(std::future::pending::<()>());
        calls.abort_all();
        let error = calls
            .join_next()
            .await
            .expect("one task")
            .expect_err("aborted");
        assert!(matches!(
            super::CodeError::from(error),
            super::CodeError::Frame(_)
        ));
    }

    use std::io::{Error, ErrorKind};

    use super::{write_failure, CodeError};

    #[test]
    fn only_a_closed_pipe_means_the_driver_exited() {
        assert!(matches!(
            write_failure(Error::from(ErrorKind::BrokenPipe)),
            CodeError::Exited
        ));
        assert!(matches!(
            write_failure(Error::from(ErrorKind::PermissionDenied)),
            CodeError::Io(error) if error.kind() == ErrorKind::PermissionDenied
        ));
    }
}
