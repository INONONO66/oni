//! Inbound machine wire dispatch. A method this client offers is served by
//! its driver once the host's attach grants the capability; every other
//! method answers the protocol's typed refusal, and a method outside the
//! daemon-served wire set is an invalid method.

use std::{
    collections::HashMap,
    fmt::Display,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use oni_protocol::{
    fs_stream_request::FsStreamRequestExclusiveMode, CancelCode, CellRequest, ExecRequest,
    FsRequest, FsStreamRequest, InputWriteRequest, PeekCode, PtyCloseRequest, PtyListRequest,
    PtyOpenRequest, PtyReadRequest, PtyReadScreenRequest, PtyResizeRequest, PtyWriteRequest,
    ScreenReadRequest, WireMethod, WireRoot,
};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::{
    attach::{Hooks, Negotiated, Session},
    budget::{Pressure, Retained},
    config::ClientConfig,
    exec::{Exec, DEFAULT_DEADLINE},
    fs::{FsDriver, FsError},
    pty::ops::Pty,
    transport::client::handler,
};

const FS_READ: &str = "fs.read";
const FS_WRITE: &str = "fs.write";
const SHELL_EXEC: &str = "shell.exec";
const PTY_SESSION: &str = "pty.session";

/// Every capability this client can serve; the enrollment receipt allows all
/// of them so a later attach can offer whatever is available by then.
pub const SUPPORTED: [&str; 4] = [FS_READ, FS_WRITE, SHELL_EXEC, PTY_SESSION];

/// The capabilities offered at attach: the filesystem only with an export,
/// terminals only when tmux answered its probe.
pub fn available(exports: bool, pty: bool) -> Vec<String> {
    SUPPORTED
        .into_iter()
        .filter(|capability| match *capability {
            FS_READ | FS_WRITE => exports,
            PTY_SESSION => pty,
            _ => true,
        })
        .map(str::to_owned)
        .collect()
}

struct Grant {
    capabilities: Vec<String>,
    exports: Vec<String>,
}

pub struct Service {
    offered: Vec<String>,
    exports: HashMap<String, PathBuf>,
    fs: Mutex<FsDriver>,
    exec: Exec,
    pty: Pty,
    grant: Mutex<Option<Grant>>,
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

impl Service {
    pub fn open(config: &ClientConfig, pty: Pty) -> Result<Arc<Self>, FsError> {
        let exports: HashMap<String, PathBuf> = config
            .exports
            .iter()
            .map(|export| (export.name.clone(), PathBuf::from(&export.path)))
            .collect();
        let fs = FsDriver::open(exports.clone())?;
        Ok(Arc::new(Self {
            offered: available(!exports.is_empty(), pty.offered()),
            exports,
            fs: Mutex::new(fs),
            exec: Exec::new(DEFAULT_DEADLINE),
            pty,
            grant: Mutex::new(None),
        }))
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
        match method {
            WireMethod::MachineFsOp => decode(params).map(|request| self.fs_op(&request)),
            WireMethod::MachineFsStream => decode(params).map(|request| self.fs_stream(&request)),
            WireMethod::MachineExec => self.exec(&decode(params)?).await,
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
    fn attached(&self, negotiated: &Negotiated) {
        *self.grant() = Some(Grant {
            capabilities: negotiated.capabilities.clone(),
            exports: negotiated.exports.clone(),
        });
    }

    fn detached(&self) {
        *self.grant() = None;
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
