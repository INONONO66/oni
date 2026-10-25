//! One tmux control-mode client; command replies are FIFO, output is routed by pane.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};

use super::registry::Registry;

const COMMAND_TIMEOUT: Duration = Duration::from_millis(10_000);
const MAX_LINE: usize = 4_194_304;

#[derive(Debug, Error)]
pub enum ControlError {
    #[error("tmux control client unavailable: {0}")]
    Io(#[from] std::io::Error),
    #[error("tmux control client did not answer")]
    Timeout,
    #[error("tmux control client exited")]
    Gone,
    #[error("tmux command refused: {0}")]
    Refused(String),
}

fn octal(data: &[u8]) -> Option<Vec<u8>> {
    let mut decoded = Vec::with_capacity(data.len());
    let mut at = 0;
    while at < data.len() {
        if data[at] == b'\\' {
            let digits = data.get(at + 1..at + 4)?;
            if !digits.iter().all(|byte| (b'0'..=b'7').contains(byte)) {
                return None;
            }
            let value = u16::from(digits[0] - b'0') * 64
                + u16::from(digits[1] - b'0') * 8
                + u16::from(digits[2] - b'0');
            decoded.push(u8::try_from(value).ok()?);
            at += 4;
        } else {
            decoded.push(data[at]);
            at += 1;
        }
    }
    Some(decoded)
}

async fn read_output(
    stdout: &mut (dyn AsyncRead + Unpin + Send),
    tx: mpsc::Sender<Result<Vec<String>, String>>,
    registry: Arc<Mutex<Registry>>,
) {
    let mut reader = BufReader::new(stdout);
    let mut pending = Vec::new();
    let mut inside = false;
    loop {
        let mut line = Vec::new();
        let Ok(length) = reader.read_until(b'\n', &mut line).await else {
            break;
        };
        if length == 0 || line.len() > MAX_LINE {
            break;
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        let text = String::from_utf8_lossy(&line);
        if text.starts_with("%begin ") {
            inside = true;
        } else if text.starts_with("%end ") || text.starts_with("%error ") {
            let ok = text.starts_with("%end ");
            let lines = std::mem::take(&mut pending);
            if tx
                .send(if ok { Ok(lines) } else { Err(lines.join("\n")) })
                .await
                .is_err()
            {
                break;
            }
            inside = false;
        } else if inside {
            pending.push(text.into_owned());
        } else if let Some(rest) = line.strip_prefix(b"%output ") {
            if let Some(space) = rest.iter().position(|byte| *byte == b' ') {
                let (pane, tail) = rest.split_at(space);
                let data = &tail[1..];
                let mut records = registry.lock().await;
                let pane = String::from_utf8_lossy(pane);
                match octal(data) {
                    Some(data) => records.append(&pane, &data),
                    None => {
                        if let Some(record) = records
                            .records
                            .values_mut()
                            .find(|record| record.pane.as_deref() == Some(pane.as_ref()))
                        {
                            record.poisoned = true;
                            record.notify.notify_waiters();
                        }
                    }
                }
            }
        } else if text.starts_with("%exit") {
            break;
        }
    }
    registry.lock().await.lost();
}

pub struct Control {
    child: Child,
    stdin: ChildStdin,
    replies: mpsc::Receiver<Result<Vec<String>, String>>,
}

impl Control {
    pub async fn start(
        tmux: &str,
        socket: Option<&str>,
        registry: Arc<Mutex<Registry>>,
    ) -> Result<Self, ControlError> {
        Self::start_with_deadline(
            tmux,
            socket,
            registry,
            std::pin::pin!(tokio::time::sleep(COMMAND_TIMEOUT)),
        )
        .await
    }

    async fn start_with_deadline(
        tmux: &str,
        socket: Option<&str>,
        registry: Arc<Mutex<Registry>>,
        deadline: Pin<&mut (dyn Future<Output = ()> + Send)>,
    ) -> Result<Self, ControlError> {
        let mut command = Command::new(tmux);
        if let Some(socket) = socket {
            command.args(["-L", socket]);
        }
        command.args(["-C", "new-session", "-A", "-s", "oni-pty-control"]);
        command.kill_on_drop(true);
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        // Successful spawn with Stdio::piped always supplies both handles.
        let stdin = child.stdin.take().expect("stdin configured as piped");
        let mut stdout = child.stdout.take().expect("stdout configured as piped");
        let (tx, replies) = mpsc::channel(32);
        tokio::spawn(async move { read_output(&mut stdout, tx, registry).await });
        let mut control = Self {
            child,
            stdin,
            replies,
        };
        control.reply(deadline).await?;
        Ok(control)
    }

    pub async fn command(&mut self, line: &str) -> Result<Vec<String>, ControlError> {
        self.command_with_deadline(line, std::pin::pin!(tokio::time::sleep(COMMAND_TIMEOUT)))
            .await
    }

    async fn command_with_deadline(
        &mut self,
        line: &str,
        deadline: Pin<&mut (dyn Future<Output = ()> + Send)>,
    ) -> Result<Vec<String>, ControlError> {
        self.stdin.write_all(format!("{line}\n").as_bytes()).await?;
        self.reply(deadline).await
    }

    async fn reply(
        &mut self,
        deadline: Pin<&mut (dyn Future<Output = ()> + Send)>,
    ) -> Result<Vec<String>, ControlError> {
        tokio::select! {
            reply = self.replies.recv() => match reply {
                Some(Ok(lines)) => Ok(lines),
                Some(Err(message)) => Err(ControlError::Refused(message)),
                None => Err(ControlError::Gone),
            },
            () = deadline => self
                .child
                .start_kill()
                .map_err(ControlError::from)
                .and(Err(ControlError::Timeout)),
        }
    }

    pub fn close(&mut self) -> Result<(), ControlError> {
        self.child.start_kill().map_err(ControlError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::{octal, read_output, Control, ControlError};
    use crate::pty::fixture::script;
    use crate::pty::registry::Registry;
    use std::sync::Arc;
    use tokio::sync::{mpsc, Mutex};

    struct FailedReader;

    impl tokio::io::AsyncRead for FailedReader {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buffer: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(std::io::Error::other("broken pipe")))
        }
    }

    #[tokio::test]
    async fn reader_marks_sessions_lost_on_io_failure_or_dropped_receiver() {
        let registry = Arc::new(Mutex::new(Registry::new("g".into())));
        registry.lock().await.register("sample").expect("space");
        let (sender, mut receiver) = mpsc::channel(1);
        read_output(&mut FailedReader, sender, registry.clone()).await;
        assert_eq!(receiver.recv().await, None);
        assert!(registry.lock().await.records["sample"].lost);

        registry
            .lock()
            .await
            .records
            .get_mut("sample")
            .expect("sample")
            .lost = false;
        let (sender, receiver) = mpsc::channel(1);
        drop(receiver);
        read_output(
            &mut &b"%begin 1 1 1\n%end 1 1 1\n"[..],
            sender,
            registry.clone(),
        )
        .await;
        assert!(registry.lock().await.records["sample"].lost);
    }

    #[tokio::test]
    async fn reader_ignores_unaddressed_output_and_closes_replies_at_eof() {
        let registry = Arc::new(Mutex::new(Registry::new("g".into())));
        registry
            .lock()
            .await
            .register("sample")
            .expect("space")
            .pane = Some("%1".into());
        let (sender, mut receiver) = mpsc::channel(1);
        read_output(&mut &b"%output %1"[..], sender, registry.clone()).await;
        assert_eq!(receiver.recv().await, None);
        let registry = registry.lock().await;
        assert!(registry.records["sample"].read("g", None).data.is_empty());
        assert!(registry.records["sample"].lost);
    }

    #[test]
    fn output_decodes_octal_bytes_and_rejects_invalid_escape() {
        assert_eq!(octal(br"a\000\134b"), Some(b"a\0\\b".to_vec()));
        for invalid in [&br"\9ab"[..], br"a\1", br"\777"] {
            assert_eq!(octal(invalid), None);
        }
    }

    #[tokio::test]
    async fn control_reports_missing_executable_and_closed_input() {
        let registry = Arc::new(Mutex::new(Registry::new("g".into())));
        let missing = Control::start("/definitely/missing/tmux", None, registry.clone())
            .await
            .err()
            .expect("spawn failure");
        assert!(missing
            .to_string()
            .starts_with("tmux control client unavailable: "));

        let root = tempfile::tempdir().expect("script directory");
        let closed = script(
            root.path(),
            "closed",
            "#!/bin/sh\nexec 0<&-\nprintf '%%begin 1 1 1\\n%%end 1 1 1\\n'\nexec sleep 60\n",
        );
        let mut control = Control::start(closed.to_str().expect("utf8"), None, registry)
            .await
            .expect("startup reply after closing input");
        let refused = control.command("emit").await.expect_err("broken pipe");
        assert!(
            refused
                .to_string()
                .starts_with("tmux control client unavailable: "),
            "{refused}"
        );
    }

    #[tokio::test]
    async fn control_routes_pane_output_and_rejects_failed_commands() {
        let root = tempfile::tempdir().expect("script directory");
        let script = script(
            root.path(),
            "control",
            "#!/bin/sh\n\
             printf '%%begin 1 1 1\\n%%end 1 1 1\\n'\n\
             while IFS= read -r line; do\n\
               case \"$line\" in\n\
                 emit) printf '%%output %%1 hi\\\\040there\\n%%begin 2 1 1\\n%%end 2 1 1\\n' ;;\n\
                 bad) printf '%%output %%1 \\\\9ab\\n%%begin 3 1 1\\nfailed\\n%%error 3 1 1\\n' ;;\n\
                 unknown) printf '%%output %%2 \\\\9ab\\n%%begin 4 1 1\\n%%end 4 1 1\\n' ;;\n\
                 big) /usr/bin/yes x | /usr/bin/tr -d '\\n' | /usr/bin/head -c 4194305; printf '\\n' ;;\n\
                 silent) : ;;\n\
                 exit) printf '%%exit\\n'; exit 0 ;;\n\
               esac\n\
             done\n",
        );
        let registry = Arc::new(Mutex::new(Registry::new("g".into())));
        registry
            .lock()
            .await
            .register("sample")
            .expect("space")
            .pane = Some("%1".into());
        let mut control = Control::start(
            script.to_str().expect("utf8"),
            Some("isolated-socket"),
            registry.clone(),
        )
        .await
        .expect("startup reply");
        assert!(control.command("emit").await.expect("reply").is_empty());
        assert_eq!(
            registry
                .lock()
                .await
                .records
                .get("sample")
                .expect("sample")
                .read("g", None)
                .data,
            b"hi there"
        );
        assert_eq!(
            control
                .command("bad")
                .await
                .expect_err("refusal")
                .to_string(),
            ControlError::Refused("failed".into()).to_string()
        );
        assert!(
            registry
                .lock()
                .await
                .records
                .get("sample")
                .expect("sample")
                .poisoned
        );
        assert!(control.command("unknown").await.expect("reply").is_empty());
        assert_eq!(
            control.command("exit").await.expect_err("exit").to_string(),
            ControlError::Gone.to_string()
        );
        let mut oversized = Control::start(script.to_str().expect("utf8"), None, registry.clone())
            .await
            .expect("new client");
        assert_eq!(
            oversized
                .command("big")
                .await
                .expect_err("oversized line")
                .to_string(),
            ControlError::Gone.to_string()
        );
        assert!(
            registry
                .lock()
                .await
                .records
                .get("sample")
                .expect("sample")
                .lost
        );
        let mut stalled = Control::start(script.to_str().expect("utf8"), None, registry)
            .await
            .expect("third startup");
        assert_eq!(
            stalled
                .command_with_deadline("silent", std::pin::pin!(std::future::ready(())))
                .await
                .expect_err("deadline")
                .to_string(),
            ControlError::Timeout.to_string()
        );
    }

    #[tokio::test]
    async fn control_times_out_when_startup_has_no_reply() {
        let root = tempfile::tempdir().expect("script directory");
        let silent = script(
            root.path(),
            "silent",
            "#!/bin/sh\nwhile IFS= read -r line; do :; done\n",
        );
        let registry = Arc::new(Mutex::new(Registry::new("g".into())));
        assert_eq!(
            Control::start_with_deadline(
                silent.to_str().expect("utf8"),
                None,
                registry.clone(),
                std::pin::pin!(std::future::ready(()))
            )
            .await
            .err()
            .expect("startup deadline")
            .to_string(),
            ControlError::Timeout.to_string()
        );
    }
}
