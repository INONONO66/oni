//! Persistent named terminals backed by one tmux control session.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_protocol::{
    PtyCloseRequest, PtyCloseResult, PtyListResult, PtyOpenRequest, PtyOpenResult, PtyReadRequest,
    PtyReadResult, PtyReadScreenRequest, PtyResizeRequest, PtyResizeResult, PtyScreenResult,
    PtyWriteRequest, PtyWriteResult,
};
use serde::de::DeserializeOwned;
use serde_json::json;
use thiserror::Error;
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;

use super::control::{Control, ControlError};
use super::registry::Registry;

const CONTROL_SESSION: &str = "oni-pty-control";

#[derive(Debug, Error)]
pub enum PtyError {
    #[error(transparent)]
    Control(#[from] ControlError),
    #[error("could not encode terminal result: {0}")]
    Result(#[from] serde_json::Error),
    #[error("invalid terminal input: {0}")]
    Input(#[from] base64::DecodeError),
}

fn result<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, PtyError> {
    serde_json::from_value(value).map_err(PtyError::from)
}

/// The attached pane of one live terminal and its output wakeup.
#[derive(Debug)]
struct Attached {
    pane: String,
    notify: Arc<Notify>,
}

fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && (byte == b'_' || byte == b'-'))
        })
        && name != CONTROL_SESSION
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn observed_at(now: SystemTime) -> Result<u128, PtyError> {
    Ok(now
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ControlError::Refused("invalid system clock".into()))?
        .as_millis())
}

pub struct Pty {
    tmux: String,
    socket: Option<String>,
    available: bool,
    control: Mutex<Option<Control>>,
    registry: Arc<Mutex<Registry>>,
    measured: AtomicUsize,
}

impl Pty {
    /// Probe the executable before advertising `pty.session`.
    pub async fn new(tmux: impl Into<String>, socket: Option<String>, generation: String) -> Self {
        let tmux = tmux.into();
        let available = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::process::Command::new(&tmux)
                .arg("-V")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .is_ok_and(|outcome| outcome.is_ok_and(|output| output.status.success()));
        Self {
            tmux,
            socket,
            available,
            control: Mutex::new(None),
            registry: Arc::new(Mutex::new(Registry::new(generation))),
            measured: AtomicUsize::new(0),
        }
    }

    pub fn offered(&self) -> bool {
        self.available
    }

    /// Replay and live output bytes the registry retains; while another
    /// operation holds the registry, the last measurement.
    pub fn retained(&self) -> usize {
        match self.registry.try_lock() {
            Ok(registry) => {
                let bytes = registry.retained();
                self.measured.store(bytes, Ordering::Relaxed);
                bytes
            }
            Err(_) => self.measured.load(Ordering::Relaxed),
        }
    }

    /// Release the terminal retaining the most output now, or, while another
    /// operation holds the registry, from a task once that operation ends.
    pub fn shed(&self) -> Option<JoinHandle<usize>> {
        match self.registry.try_lock() {
            Ok(mut registry) => {
                registry.shed();
                None
            }
            Err(_) => {
                let registry = self.registry.clone();
                Some(tokio::spawn(async move { registry.lock().await.shed() }))
            }
        }
    }

    async fn command(&self, line: &str) -> Result<Vec<String>, PtyError> {
        let mut guard = self.control.lock().await;
        let control = match &mut *guard {
            Some(control) => control,
            slot @ None => {
                let mut control =
                    Control::start(&self.tmux, self.socket.as_deref(), self.registry.clone())
                        .await?;
                let names = control
                    .command("list-sessions -F \"#{session_name}\"")
                    .await?;
                self.discover(&names).await;
                slot.insert(control)
            }
        };
        let result = control.command(line).await;
        if matches!(result, Err(ControlError::Gone | ControlError::Timeout)) {
            *guard = None;
        }
        result.map_err(Into::into)
    }

    async fn discover(&self, names: &[String]) {
        let mut registry = self.registry.lock().await;
        for name in names.iter().filter(|name| name_valid(name)) {
            if registry.records.get(name).is_some_and(|record| record.lost) {
                registry.remove(name);
            }
            if registry.register(name).is_none() {
                break;
            }
        }
    }

    async fn names(&self) -> Result<Vec<String>, PtyError> {
        let names = self.command("list-sessions -F \"#{session_name}\"").await?;
        Ok(names.into_iter().filter(|name| name_valid(name)).collect())
    }

    async fn attach(&self, name: &str) -> Result<Attached, PtyError> {
        if let Some(attached) = self
            .registry
            .lock()
            .await
            .records
            .get(name)
            .filter(|record| !record.lost)
            .and_then(|record| {
                record.pane.clone().map(|pane| Attached {
                    pane,
                    notify: record.notify.clone(),
                })
            })
        {
            return Ok(attached);
        }
        let panes = self
            .command(&format!(
                "list-panes -t ={name}: -F \"#{{window_id}} #{{pane_id}}\""
            ))
            .await?;
        let ids: Vec<&str> = panes
            .first()
            .map(|line| line.split_whitespace().collect())
            .unwrap_or_default();
        let (Some(window), Some(pane)) = (ids.first(), ids.get(1)) else {
            return Err(ControlError::Refused("expected one terminal pane".into()).into());
        };
        if panes.len() != 1 {
            return Err(ControlError::Refused("expected one terminal pane".into()).into());
        }
        self.command(&format!("link-window -s {window} -t {CONTROL_SESSION}:"))
            .await?;
        let captured = self
            .command(&format!("capture-pane -p -t {pane} -S - -E -"))
            .await?;
        let trimmed = captured
            .iter()
            .rposition(|line| !line.is_empty())
            .map_or(&[][..], |last| &captured[..=last]);
        let replay = if trimmed.is_empty() {
            Vec::new()
        } else {
            format!("{}\n", trimmed.join("\n")).into_bytes()
        };
        let mut registry = self.registry.lock().await;
        let record = registry
            .register(name)
            .ok_or_else(|| ControlError::Refused("terminal registry full".into()))?;
        record.window = Some((*window).to_owned());
        record.pane = Some((*pane).to_owned());
        record.replay = replay;
        record.lost = false;
        Ok(Attached {
            pane: (*pane).to_owned(),
            notify: record.notify.clone(),
        })
    }

    async fn session(&self, name: &str) -> Result<bool, PtyError> {
        if !self.available || !name_valid(name) {
            return Ok(false);
        }
        if self
            .registry
            .lock()
            .await
            .records
            .get(name)
            .is_some_and(|record| !record.lost)
        {
            return Ok(true);
        }
        if !self.names().await?.contains(&name.to_owned()) {
            return Ok(false);
        }
        Ok(self.registry.lock().await.register(name).is_some())
    }

    pub async fn open(
        &self,
        request: &PtyOpenRequest,
        exports: &[PathBuf],
    ) -> Result<PtyOpenResult, PtyError> {
        if !self.available {
            return result(json!({"status":"refused","reason":"pty_not_available"}));
        }
        if !name_valid(&request.name) {
            return result(json!({"status":"refused","reason":"pty_not_found"}));
        }
        let cwd = crate::exec::confined(&request.cwd, exports);
        let Some(cwd) = cwd else {
            return result(json!({"status":"refused","reason":"path_escapes_export"}));
        };
        if !self.session(&request.name).await? {
            if self.registry.lock().await.records.len() >= super::registry::MAX_SESSIONS {
                return result(json!({"status":"refused","reason":"pty_not_available"}));
            }
            self.command(&format!(
                "new-session -d -s {} -c {} -x 80 -y 24",
                *request.name,
                quote(&cwd.to_string_lossy())
            ))
            .await?;
            self.registry
                .lock()
                .await
                .register(&request.name)
                .ok_or_else(|| ControlError::Refused("terminal registry full".into()))?;
        }
        self.attach(&request.name).await?;
        let generation = self.registry.lock().await.generation.clone();
        result(json!({"status":"ok","cursor":format!("p1:{generation}:0")}))
    }

    pub async fn write(&self, request: &PtyWriteRequest) -> Result<PtyWriteResult, PtyError> {
        if !self.session(&request.name).await? {
            return result(json!({"status":"refused","reason":self.refusal(&request.name)}));
        }
        let pane = self.attach(&request.name).await?.pane;
        let data = STANDARD.decode(request.data.as_bytes())?;
        if data.len() > 16_384 {
            return Err(ControlError::Refused("terminal input exceeds 16384 bytes".into()).into());
        }
        for chunk in data.chunks(128) {
            let hex = chunk
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join(" ");
            self.command(&format!("send-keys -t {pane} -H {hex}"))
                .await?;
        }
        result(json!({"status":"ok"}))
    }

    pub async fn read(&self, request: &PtyReadRequest) -> Result<PtyReadResult, PtyError> {
        if !self.session(&request.name).await? {
            return result(json!({"status":"refused","reason":self.refusal(&request.name)}));
        }
        let notify = self.attach(&request.name).await?.notify;
        let wait = request.wait_ms.unwrap_or(0);
        let notified = notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let initial = self
            .view(&request.name, request.cursor.as_deref().map(String::as_str))
            .await?;
        if initial.data.is_empty() && wait > 0 {
            tokio::time::timeout(
                Duration::from_millis(u64::try_from(wait).unwrap_or(0)),
                &mut notified,
            )
            .await
            .ok();
        }
        let view = self
            .view(&request.name, request.cursor.as_deref().map(String::as_str))
            .await?;
        let lost = self
            .registry
            .lock()
            .await
            .records
            .get(request.name.as_str())
            .is_none_or(|record| record.lost);
        if lost {
            return result(json!({"status":"refused","reason":"pty_not_found"}));
        }
        result(
            json!({"status":"ok","data":STANDARD.encode(view.data),"cursor":view.cursor,"truncated":view.truncated}),
        )
    }

    pub async fn screen(
        &self,
        request: &PtyReadScreenRequest,
    ) -> Result<PtyScreenResult, PtyError> {
        if !self.session(&request.name).await? {
            return result(json!({"status":"refused","reason":self.refusal(&request.name)}));
        }
        let pane = self.attach(&request.name).await?.pane;
        let rows = self
            .command(&format!("capture-pane -p -e -t {pane}"))
            .await?;
        let facts = self.command(&format!(
            "display-message -p -t {pane} \"#{{cursor_x}} #{{cursor_y}} #{{pane_dead}} #{{pane_pid}} #{{pane_current_command}}\""
        )).await?;
        let Some(line) = facts.first().filter(|_| facts.len() == 1) else {
            return Err(ControlError::Refused("invalid terminal pane facts".into()).into());
        };
        let mut fields = line.splitn(5, ' ');
        let (Some(x), Some(y), Some(dead), Some(pid), Some(command)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            return Err(ControlError::Refused("invalid terminal pane facts".into()).into());
        };
        let x: u64 = x
            .parse()
            .map_err(|_| ControlError::Refused("invalid cursor x".into()))?;
        let y: u64 = y
            .parse()
            .map_err(|_| ControlError::Refused("invalid cursor y".into()))?;
        let occupant = if dead == "1" {
            serde_json::Value::Null
        } else {
            match pid.parse::<u64>() {
                Ok(pid) if pid > 0 => json!({"pid":pid,"command":command}),
                _ => serde_json::Value::Null,
            }
        };
        observed_at(SystemTime::now()).and_then(|observed| {
            result(json!({"status":"ok","rows":rows,"cursor":{"x":x,"y":y},
                "occupant":occupant,"observedAt":observed}))
        })
    }

    async fn view(
        &self,
        name: &str,
        cursor: Option<&str>,
    ) -> Result<super::registry::View, PtyError> {
        let mut registry = self.registry.lock().await;
        let generation = registry.generation.clone();
        let record = registry.records.get_mut(name).ok_or(ControlError::Gone)?;
        if record.poisoned {
            record.poisoned = false;
            return Err(ControlError::Refused("malformed terminal output".into()).into());
        }
        Ok(record.read(&generation, cursor))
    }

    pub async fn resize(&self, request: &PtyResizeRequest) -> Result<PtyResizeResult, PtyError> {
        if !self.session(&request.name).await? {
            return result(json!({"status":"refused","reason":self.refusal(&request.name)}));
        }
        self.attach(&request.name).await?;
        self.command(&format!(
            "set-option -w -t ={}: window-size manual",
            *request.name
        ))
        .await?;
        self.command(&format!(
            "resize-window -t ={}: -x {} -y {}",
            *request.name, request.cols, request.rows
        ))
        .await?;
        result(json!({"status":"ok"}))
    }

    pub async fn close(&self, request: &PtyCloseRequest) -> Result<PtyCloseResult, PtyError> {
        if !self.available {
            return result(json!({"status":"refused","reason":"pty_not_available"}));
        }
        let recorded = self
            .registry
            .lock()
            .await
            .records
            .contains_key(request.name.as_str());
        if !recorded && !self.session(&request.name).await? {
            return result(json!({"status":"refused","reason":self.refusal(&request.name)}));
        }
        let window = self
            .registry
            .lock()
            .await
            .records
            .get(request.name.as_str())
            .and_then(|record| record.window.clone());
        if let Err(error) = self
            .command(&format!("kill-session -t ={}", *request.name))
            .await
        {
            if self
                .names()
                .await?
                .iter()
                .any(|name| name == request.name.as_str())
            {
                return Err(error);
            }
        }
        if let Some(window) = window {
            if let Err(error) = self.command(&format!("kill-window -t {window}")).await {
                if self
                    .command("list-windows -a -F \"#{window_id}\"")
                    .await?
                    .contains(&window)
                {
                    return Err(error);
                }
            }
        }
        self.registry.lock().await.remove(&request.name);
        result(json!({"status":"ok"}))
    }

    pub async fn list(&self) -> Result<PtyListResult, PtyError> {
        if !self.available {
            return result(json!({"status":"refused","reason":"pty_not_available"}));
        }
        let names = self.names().await?;
        let mut registry = self.registry.lock().await;
        for name in &names {
            if registry.register(name).is_none() {
                break;
            }
        }
        let mut sessions = Vec::with_capacity(registry.records.len());
        for record in registry.records.values_mut() {
            if !names.contains(&record.name) {
                record.lost = true;
                record.notify.notify_waiters();
            }
            sessions
                .push(json!({"name":record.name,"status":if record.lost {"lost"} else {"live"}}));
        }
        result(
            json!({"status":"ok","sessions":sessions,"truncated":names.len()>super::registry::MAX_SESSIONS}),
        )
    }

    fn refusal(&self, _name: &str) -> &'static str {
        if self.available {
            "pty_not_found"
        } else {
            "pty_not_available"
        }
    }

    /// Stop the control client; tmux's detached terminals remain discoverable.
    pub async fn shutdown(&self) -> Result<(), PtyError> {
        let closed = match self.control.lock().await.take() {
            Some(mut control) => control.close(),
            None => Ok(()),
        };
        self.registry.lock().await.lost();
        closed.map_err(PtyError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::fixture::script;
    use std::future::Future;

    async fn terminal(responses: &str) -> (tempfile::TempDir, Pty) {
        let root = tempfile::tempdir().expect("control script directory");
        let script = script(
            root.path(),
            "terminal",
            &format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = -V ]; then exit 0; fi\n\
                 printf '%%begin 1 1 1\\n%%end 1 1 1\\n'\n\
                 while IFS= read -r line; do\n\
                   printf '%%begin 2 1 1\\n'; outcome=end\n\
                   case \"$line\" in {responses} esac\n\
                   printf '%%%s 2 1 1\\n' \"$outcome\"\n\
                 done\n"
            ),
        );
        let pty = Pty::new(script.to_str().expect("utf8"), None, "g".into()).await;
        (root, pty)
    }

    fn failure<T: std::fmt::Debug>(outcome: Result<T, PtyError>) -> String {
        outcome.expect_err("typed failure").to_string()
    }

    fn refused(message: &str) -> String {
        ControlError::Refused(message.into()).to_string()
    }

    fn request<T: oni_protocol::WireRoot>(value: serde_json::Value) -> T {
        oni_protocol::decode(value).expect("valid request")
    }

    enum Op {
        Open,
        Write,
        Read,
        Screen,
        Resize,
        Close,
        List,
    }

    async fn failure_of(pty: &Pty, root: &std::path::Path, op: Op) -> String {
        let name = json!({"name":"sample"});
        match op {
            Op::Open => failure(
                pty.open(
                    &request(json!({"name":"sample","cwd":root})),
                    &[root.to_owned()],
                )
                .await,
            ),
            Op::Write => failure(
                pty.write(&request(json!({"name":"sample","data":"eA=="})))
                    .await,
            ),
            Op::Read => failure(pty.read(&request(name)).await),
            Op::Screen => failure(
                pty.screen(&request(json!({"name":"sample","source":"screen"})))
                    .await,
            ),
            Op::Resize => failure(
                pty.resize(&request(json!({"name":"sample","cols":80,"rows":24})))
                    .await,
            ),
            Op::Close => failure(pty.close(&request(name)).await),
            Op::List => failure(pty.list().await),
        }
    }

    /// A terminal whose `pattern` command answers `%error` with `nope`;
    /// `pane` pre-registers `sample` (attached when the pane is known).
    async fn failing(
        pattern: &str,
        extra: &str,
        pane: Option<Option<&str>>,
    ) -> (tempfile::TempDir, Pty) {
        let (root, pty) = terminal(&format!(
            "{pattern}) printf 'nope\\n'; outcome=error ;; {extra}"
        ))
        .await;
        if let Some(pane) = pane {
            let mut registry = pty.registry.lock().await;
            let record = registry.register("sample").expect("space");
            record.pane = pane.map(str::to_owned);
            record.window = Some("@1".into());
        }
        (root, pty)
    }

    #[tokio::test]
    async fn operations_propagate_session_discovery_failure() {
        let (root, pty) = failing("list-sessions*", "", None).await;
        for op in [
            Op::List,
            Op::Open,
            Op::Write,
            Op::Read,
            Op::Screen,
            Op::Resize,
            Op::Close,
        ] {
            assert_eq!(failure_of(&pty, root.path(), op).await, refused("nope"));
        }
        pty.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn operations_propagate_attach_and_command_failures() {
        let panes = "list-panes*) printf '@1 %%1\\n' ;;";
        let detached = Some(None);
        let attached = Some(Some("%1"));
        let mut cases = Vec::new();
        for stage in ["list-panes*", "link-window*", "capture-pane*"] {
            for op in [Op::Open, Op::Write, Op::Read, Op::Screen, Op::Resize] {
                cases.push((stage, panes, detached, op));
            }
        }
        cases.extend([
            ("new-session*", "", None, Op::Open),
            ("send-keys*", "", attached, Op::Write),
            ("capture-pane*", "", attached, Op::Screen),
            ("display-message*", "", attached, Op::Screen),
            ("set-option*", "", attached, Op::Resize),
            ("resize-window*", "", attached, Op::Resize),
            (
                "list-windows*",
                "kill-window*) printf 'busy\\n'; outcome=error ;;",
                detached,
                Op::Close,
            ),
        ]);
        for (pattern, extra, pane, op) in cases {
            let (root, pty) = failing(pattern, extra, pane).await;
            assert_eq!(
                failure_of(&pty, root.path(), op).await,
                refused("nope"),
                "{pattern}"
            );
            pty.shutdown().await.expect("shutdown");
        }
    }

    #[tokio::test]
    async fn close_propagates_failed_recheck_after_refused_kill() {
        let (root, pty) = failing(
            "kill-session*",
            "list-sessions*) n=$((n + 1)); \
             if [ \"$n\" -gt 1 ]; then printf 'gone\\n'; outcome=error; fi ;;",
            Some(None),
        )
        .await;
        assert_eq!(
            failure_of(&pty, root.path(), Op::Close).await,
            refused("gone")
        );
        pty.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn write_refuses_non_canonical_base64() {
        let (_root, pty) = failing("never", "", Some(Some("%1"))).await;
        let write: PtyWriteRequest = request(json!({"name":"sample","data":"AB=="}));
        assert_eq!(
            failure(pty.write(&write).await),
            PtyError::from(STANDARD.decode("AB==").expect_err("trailing bits")).to_string()
        );
        pty.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn control_that_exits_before_startup_reply_is_gone() {
        let root = tempfile::tempdir().expect("script directory");
        let script = script(
            root.path(),
            "exits",
            "#!/bin/sh\nif [ \"$1\" = -V ]; then exit 0; fi\n",
        );
        let pty = Pty::new(script.to_str().expect("utf8"), None, "g".into()).await;
        assert_eq!(failure(pty.list().await), ControlError::Gone.to_string());
    }

    async fn screen_with_facts(facts: &str) -> Result<PtyScreenResult, PtyError> {
        let (_root, pty) = terminal(&format!(
            "list-sessions*) printf 'sample\\n' ;; \
             capture-pane*) printf 'row\\n' ;; \
             display-message*) printf '%b' '{facts}' ;;"
        ))
        .await;
        pty.registry
            .lock()
            .await
            .register("sample")
            .expect("space")
            .pane = Some("%1".into());
        let request: PtyReadScreenRequest =
            oni_protocol::decode(json!({"name":"sample","source":"screen"}))
                .expect("valid screen request");
        let outcome = pty.screen(&request).await;
        pty.shutdown().await.expect("control cleanup");
        outcome
    }

    async fn attach_with_panes(panes: &str) -> Result<Attached, PtyError> {
        let (_root, pty) = terminal(&format!(
            "list-sessions*) printf 'sample\\n' ;; \
             list-panes*) printf '%b' '{panes}' ;;"
        ))
        .await;
        let outcome = pty.attach("sample").await;
        pty.shutdown().await.expect("control cleanup");
        outcome
    }

    #[tokio::test]
    async fn attach_refuses_missing_or_multiple_panes() {
        let (missing, multiple) =
            tokio::join!(attach_with_panes(""), attach_with_panes("@1 %1\\n@2 %2\\n"));
        for outcome in [missing, multiple] {
            assert_eq!(failure(outcome), refused("expected one terminal pane"));
        }
    }

    #[tokio::test]
    async fn screen_rejects_invalid_pane_facts() {
        let (empty, short, x, y) = tokio::join!(
            screen_with_facts(""),
            screen_with_facts("1 2\\n"),
            screen_with_facts("wrong 2 0 42 sh\\n"),
            screen_with_facts("1 wrong 0 42 sh\\n"),
        );
        for (outcome, expected) in [
            (empty, "invalid terminal pane facts"),
            (short, "invalid terminal pane facts"),
            (x, "invalid cursor x"),
            (y, "invalid cursor y"),
        ] {
            assert_eq!(failure(outcome), refused(expected));
        }
    }

    #[tokio::test]
    async fn screen_reports_dead_or_unknown_pane_occupant() {
        let (dead, unknown, live) = tokio::join!(
            screen_with_facts("1 2 1 42 sh\\n"),
            screen_with_facts("1 2 0 invalid sh\\n"),
            screen_with_facts("1 2 0 42 sh\\n")
        );
        for (outcome, occupant) in [
            (dead, serde_json::Value::Null),
            (unknown, serde_json::Value::Null),
            (live, json!({"pid":42,"command":"sh"})),
        ] {
            let result = outcome.expect("screen");
            let body = serde_json::to_value(result).expect("wire");
            assert_eq!(body["occupant"], occupant);
            assert_eq!(body["rows"][0], "row");
        }
    }

    fn reason<T: serde::Serialize>(outcome: Result<T, PtyError>) -> serde_json::Value {
        serde_json::to_value(outcome.expect("refusal")).expect("wire")["reason"].clone()
    }

    #[tokio::test]
    async fn operations_refuse_unavailable_invalid_escaped_or_missing_terminals() {
        let root = tempfile::tempdir().expect("export");
        let outside = tempfile::tempdir().expect("outside export");
        let exports = [root.path().to_owned()];
        let name = json!({"name":"sample"});
        let screen = json!({"name":"sample","source":"screen"});
        let missing = Pty::new("/definitely/missing/tmux", None, "g".into()).await;
        let (_script, empty) = terminal("list-sessions*) : ;;").await;
        for (pty, expected) in [(&missing, "pty_not_available"), (&empty, "pty_not_found")] {
            assert_eq!(reason(pty.read(&request(name.clone())).await), expected);
            assert_eq!(reason(pty.screen(&request(screen.clone())).await), expected);
            assert_eq!(reason(pty.close(&request(name.clone())).await), expected);
        }
        assert_eq!(reason(missing.list().await), "pty_not_available");
        let open = request(json!({"name":"sample","cwd":root.path()}));
        assert_eq!(
            reason(missing.open(&open, &exports).await),
            "pty_not_available"
        );
        let control = request(json!({"name":CONTROL_SESSION,"cwd":root.path()}));
        assert_eq!(
            reason(empty.open(&control, &exports).await),
            "pty_not_found"
        );
        let escaped = request(json!({"name":"sample","cwd":outside.path()}));
        assert_eq!(
            reason(empty.open(&escaped, &exports).await),
            "path_escapes_export"
        );
        empty.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn list_marks_unseen_record_lost_and_close_kills_its_window() {
        let (_root, pty) = terminal("list-sessions*) printf 'sample\\n' ;;").await;
        pty.registry
            .lock()
            .await
            .register("gone")
            .expect("space")
            .window = Some("@1".into());
        assert_eq!(
            serde_json::to_value(pty.list().await.expect("list")).expect("wire")["sessions"],
            json!([{"name":"gone","status":"lost"},{"name":"sample","status":"live"}])
        );
        let close = pty.close(&request(json!({"name":"gone"}))).await;
        assert_eq!(
            serde_json::to_value(close.expect("close")).expect("wire"),
            json!({"status":"ok"})
        );
        pty.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn control_exit_notice_after_other_notifications_marks_sessions_lost() {
        let (_root, pty) =
            terminal("disconnect) printf '%%end 2 1 1\\n%%sessions-changed\\n%%exit\\n' ;;").await;
        pty.registry.lock().await.register("sample").expect("space");
        assert_eq!(
            pty.command("disconnect").await.expect("reply before exit"),
            Vec::<String>::new()
        );
        assert_eq!(
            failure(pty.command("after").await),
            ControlError::Gone.to_string()
        );
        assert!(pty.registry.lock().await.records["sample"].lost);
    }

    #[tokio::test]
    async fn reconnect_discovers_lost_session_and_replays_capture() {
        let (root, pty) = terminal(
            "list-sessions*) printf 'sample\\n' ;; \
             list-panes*) printf '@1 %%1\\n' ;; \
             capture-pane*) printf 'retained\\n\\n' ;; \
             disconnect) exit 0 ;;",
        )
        .await;
        assert_eq!(
            failure(pty.command("disconnect").await),
            ControlError::Gone.to_string()
        );
        assert!(pty.registry.lock().await.records["sample"].lost);
        let open: PtyOpenRequest =
            oni_protocol::decode(json!({"name":"sample","cwd":root.path()})).expect("open request");
        let opened = pty
            .open(&open, &[root.path().to_owned()])
            .await
            .expect("reopen");
        assert_eq!(serde_json::to_value(opened).expect("wire")["status"], "ok");
        let read: PtyReadRequest =
            oni_protocol::decode(json!({"name":"sample"})).expect("read request");
        let body = serde_json::to_value(pty.read(&read).await.expect("replay")).expect("wire");
        assert_eq!(
            STANDARD
                .decode(body["data"].as_str().expect("data"))
                .expect("base64"),
            b"retained\n"
        );
        assert_eq!(pty.retained(), 9);
        assert!(pty.shed().is_none());
        assert_eq!(pty.retained(), 0);
        let after = serde_json::to_value(pty.read(&read).await.expect("shed")).expect("wire");
        assert_eq!(
            (&after["data"], &after["truncated"]),
            (&json!(""), &json!(true))
        );
        pty.shutdown().await.expect("shutdown");
        pty.shutdown().await.expect("idempotent shutdown");
    }

    #[tokio::test]
    async fn held_registry_reports_last_measurement_and_defers_shed() {
        let pty = Pty::new("/definitely/missing/tmux", None, "g".into()).await;
        assert_eq!(pty.retained(), 0);
        pty.registry
            .lock()
            .await
            .register("sample")
            .expect("space")
            .replay = b"replay".to_vec();
        assert_eq!(pty.retained(), 6);
        let held = pty.registry.lock().await;
        assert_eq!(pty.retained(), 6);
        let deferred = pty.shed().expect("deferred while held");
        drop(held);
        assert_eq!(deferred.await.expect("shed task"), 6);
        assert_eq!(pty.retained(), 0);
    }

    #[tokio::test]
    async fn full_registry_truncates_list_and_refuses_new_terminal() {
        let (root, pty) = terminal(
            "list-sessions*) i=0; while [ \"$i\" -le 1000 ]; do \
             printf 's%s\\n' \"$i\"; i=$((i + 1)); done ;; \
             list-panes*) printf '@1 %%1\\n' ;;",
        )
        .await;
        let listed = serde_json::to_value(pty.list().await.expect("list")).expect("wire");
        assert_eq!(listed["sessions"].as_array().expect("sessions").len(), 1000);
        assert_eq!(listed["truncated"], true);
        let open: PtyOpenRequest =
            oni_protocol::decode(json!({"name":"overflow","cwd":root.path()}))
                .expect("open request");
        let body = serde_json::to_value(
            pty.open(&open, &[root.path().to_owned()])
                .await
                .expect("capacity refusal"),
        )
        .expect("wire");
        assert_eq!(body["reason"], "pty_not_available");
        assert_eq!(
            failure(pty.attach("overflow").await),
            refused("terminal registry full")
        );
        pty.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn open_refuses_when_registry_fills_during_session_creation() {
        let shell = crate::exec::blocked_shell::BlockedShell::new(false);
        let (_root, pty) = terminal(&format!("new-session*) {} ;;", shell.command)).await;
        let request: PtyOpenRequest =
            oni_protocol::decode(json!({"name":"sample","cwd":shell.root.path()}))
                .expect("open request");
        let exports = [shell.root.path().to_owned()];
        let open = pty.open(&request, &exports);
        let fill = async {
            shell.started().await;
            let names = (0..super::super::registry::MAX_SESSIONS)
                .map(|index| format!("s{index}"))
                .collect::<Vec<_>>();
            pty.discover(&names).await;
            shell.release();
        };
        let (outcome, ()) =
            tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(open, fill) })
                .await
                .expect("session creation and concurrent registration");
        assert_eq!(failure(outcome), refused("terminal registry full"));
        pty.shutdown().await.expect("shutdown");
    }

    #[test]
    fn screen_timestamp_refuses_pre_epoch_clock() {
        assert_eq!(
            failure(observed_at(UNIX_EPOCH - Duration::from_secs(1))),
            refused("invalid system clock")
        );
    }

    #[tokio::test]
    async fn pending_read_wakes_on_output_loss_poison_or_removal() {
        for case in ["output", "lost", "poisoned", "removed"] {
            let (_root, pty) = terminal("* ) : ;;").await;
            pty.registry
                .lock()
                .await
                .register("sample")
                .expect("space")
                .pane = Some("%1".into());
            let request: PtyReadRequest =
                oni_protocol::decode(json!({"name":"sample","waitMs":30000}))
                    .expect("read request");
            let mut waiting = std::pin::pin!(pty.read(&request));
            std::future::poll_fn(|cx| {
                assert!(waiting.as_mut().poll(cx).is_pending(), "read subscribed");
                std::task::Poll::Ready(())
            })
            .await;
            let expected = {
                let mut registry = pty.registry.lock().await;
                match case {
                    "output" => {
                        registry.append("%1", b"live");
                        json!({"status":"ok","data":STANDARD.encode(b"live"),
                            "cursor":"p1:g:4","truncated":false})
                    }
                    "lost" => {
                        registry.lost();
                        json!({"status":"refused","reason":"pty_not_found"})
                    }
                    "poisoned" => {
                        let record = registry.records.get_mut("sample").expect("sample");
                        record.poisoned = true;
                        record.notify.notify_waiters();
                        json!({"error": refused("malformed terminal output")})
                    }
                    _ => {
                        registry.remove("sample");
                        json!({"error": ControlError::Gone.to_string()})
                    }
                }
            };
            let observed = match tokio::time::timeout(Duration::from_secs(5), waiting)
                .await
                .expect("notification")
            {
                Ok(response) => serde_json::to_value(response).expect("wire"),
                Err(error) => json!({"error": error.to_string()}),
            };
            assert_eq!(observed, expected, "{case}");
        }
    }

    #[tokio::test]
    async fn malformed_output_refusal_is_consumed_by_one_read() {
        let (_root, pty) = terminal("* ) : ;;").await;
        {
            let mut registry = pty.registry.lock().await;
            let record = registry.register("sample").expect("space");
            record.pane = Some("%1".into());
            record.poisoned = true;
        }
        let request: PtyReadRequest =
            oni_protocol::decode(json!({"name":"sample"})).expect("read request");
        assert_eq!(
            failure(pty.read(&request).await),
            refused("malformed terminal output")
        );
        assert_eq!(
            serde_json::to_value(pty.read(&request).await.expect("next read")).expect("wire")
                ["data"],
            ""
        );
    }

    #[tokio::test]
    async fn close_preserves_refusals_only_while_targets_still_exist() {
        for (session, window, refusal, attached) in [
            ("sample\\n", "", Some("session busy"), true),
            ("", "@1\\n", Some("window busy"), true),
            ("", "", None, true),
            ("", "", None, false),
        ] {
            let (_root, pty) = terminal(&format!(
                "list-sessions*) printf '%b' '{session}' ;; \
                 list-windows*) printf '%b' '{window}' ;; \
                 kill-session*) printf 'session busy\\n'; outcome=error ;; \
                 kill-window*) printf 'window busy\\n'; outcome=error ;;"
            ))
            .await;
            pty.registry
                .lock()
                .await
                .register("sample")
                .expect("space")
                .window = attached.then(|| "@1".into());
            let close: PtyCloseRequest =
                oni_protocol::decode(json!({"name":"sample"})).expect("close request");
            let outcome = pty.close(&close).await;
            match refusal {
                Some(expected) => assert_eq!(failure(outcome), refused(expected)),
                None => assert_eq!(
                    serde_json::to_value(outcome.expect("already gone")).expect("wire")["status"],
                    "ok"
                ),
            }
            pty.shutdown().await.expect("shutdown");
        }
    }
}
