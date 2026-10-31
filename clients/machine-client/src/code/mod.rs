//! Per-tenant Python interpreters behind the machine code-cell wire.

mod driver;
mod output;

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::Duration,
};

use nix::sys::signal::Signal;
use oni_protocol::{CellRequest, CellResult, ToolCall, ToolCallResult, WireMethod};
use serde_json::{json, Value};
use tokio::{
    sync::{watch, Mutex as AsyncMutex},
    task::JoinSet,
    time::{timeout_at, Instant},
};

use crate::transport::client::Caller;
pub use driver::CodeError;
use driver::{Driver, Frame};
use output::{terminal, Captured};

const STOP_GRACE: Duration = Duration::from_secs(2);

struct Tenant {
    driver: AsyncMutex<Option<Driver>>,
    pid: Arc<AtomicU32>,
    users: AtomicU32,
}

#[derive(Clone)]
struct Running {
    stop: watch::Sender<bool>,
    output: Arc<Mutex<Captured>>,
    pid: Arc<AtomicU32>,
    active: Arc<AtomicBool>,
}

pub struct Code {
    command: PathBuf,
    tmux_socket: Option<String>,
    tenants: Mutex<HashMap<String, Arc<Tenant>>>,
    idle: Mutex<VecDeque<String>>,
    running: Arc<Mutex<HashMap<String, Running>>>,
    cleanup: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

struct RunningGuard {
    cells: Arc<Mutex<HashMap<String, Running>>>,
    cell_id: String,
    tenant: Arc<Tenant>,
}

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.cells
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.cell_id);
        self.tenant.users.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Code {
    /// Probes once at service open; an absent Python interpreter is never offered.
    pub fn available() -> bool {
        Driver::available()
    }

    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_socket(tmux_socket: Option<String>) -> Self {
        let mut code = Self::new();
        code.tmux_socket = tmux_socket;
        code
    }

    /// A command override makes spawn and early-exit failures observable in tests.
    pub fn with_command(command: PathBuf) -> Self {
        Self {
            command,
            tmux_socket: None,
            tenants: Mutex::new(HashMap::new()),
            idle: Mutex::new(VecDeque::new()),
            running: Arc::new(Mutex::new(HashMap::new())),
            cleanup: Mutex::new(Vec::new()),
        }
    }

    pub fn peek(&self, cell_id: &str) -> Value {
        let running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        let output = running.get(cell_id).map_or_else(
            || json!({"stdout":"","stderr":""}),
            |cell| {
                cell.output
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .value()
            },
        );
        json!({"running": running.contains_key(cell_id), "output": output})
    }

    pub fn stop(&self, cell_id: &str) -> bool {
        self.running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(cell_id)
            .is_some_and(|cell| {
                let sent = cell.stop.send(true).is_ok();
                if sent && cell.active.load(Ordering::Acquire) {
                    Driver::signal(&cell.pid, Signal::SIGINT);
                }
                sent
            })
    }

    pub fn detach(&self) {
        for cell in self
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
        {
            let _ = cell.stop.send(true);
        }
        let tenants =
            std::mem::take(&mut *self.tenants.lock().unwrap_or_else(PoisonError::into_inner));
        self.idle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        let mut cleanup = self.cleanup.lock().unwrap_or_else(PoisonError::into_inner);
        for tenant in tenants.into_values() {
            cleanup.push(tokio::spawn(async move {
                let mut guard = tenant.driver.lock().await;
                if let Some(driver) = guard.take() {
                    driver.reap(STOP_GRACE).await
                }
            }));
        }
    }

    pub async fn shutdown(&self) {
        self.detach();
        let cleanup =
            std::mem::take(&mut *self.cleanup.lock().unwrap_or_else(PoisonError::into_inner));
        for task in cleanup {
            let _ = task.await;
        }
    }

    pub async fn run(&self, request: CellRequest, caller: Caller) -> Result<Value, CodeError> {
        let cell_id = request.cell_id.to_string();
        let tenant_id = request
            .tenant
            .as_ref()
            .map_or_else(|| "default".to_owned(), |tenant| (**tenant).clone());
        let tenant = {
            let mut tenants = self.tenants.lock().unwrap_or_else(PoisonError::into_inner);
            self.idle
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|id| id != &tenant_id);
            tenants
                .entry(tenant_id.clone())
                .or_insert_with(|| {
                    Arc::new(Tenant {
                        driver: AsyncMutex::new(None),
                        pid: Arc::new(AtomicU32::new(0)),
                        users: AtomicU32::new(0),
                    })
                })
                .clone()
        };
        let (stop, cancelled) = watch::channel(false);
        let running_cell = Running {
            stop,
            output: Arc::new(Mutex::new(Captured::default())),
            pid: tenant.pid.clone(),
            active: Arc::new(AtomicBool::new(false)),
        };
        {
            let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
            if running.contains_key(&cell_id) {
                return Err(CodeError::Duplicate(cell_id));
            }
            running.insert(cell_id.clone(), running_cell.clone());
        }
        tenant.users.fetch_add(1, Ordering::AcqRel);
        let _running_guard = RunningGuard {
            cells: self.running.clone(),
            cell_id: cell_id.clone(),
            tenant: tenant.clone(),
        };
        self.run_registered(request, caller, tenant_id, tenant, running_cell, cancelled)
            .await
    }

    async fn run_registered(
        &self,
        request: CellRequest,
        caller: Caller,
        tenant_id: String,
        tenant: Arc<Tenant>,
        running: Running,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<Value, CodeError> {
        let cell_id = request.cell_id.to_string();
        let output = running.output;
        let active = running.active;
        let result = async {
            let deadline = Instant::now() + Duration::from_millis(request.timeout_ms.get());
            // Cancellation wins over a lock that becomes free in the same poll,
            // so a stop issued while the cell queued is never lost.
            let mut guard = tokio::select! {
                biased;
                _ = cancelled.changed() => return Ok(terminal(&cell_id, "cancelled", &output)),
                lock = timeout_at(deadline, tenant.driver.lock()) => match lock {
                    Ok(guard) => guard,
                    Err(_) => return Ok(terminal(&cell_id, "timed_out", &output)),
                },
            };
            let mut driver = match guard.take() {
                Some(driver) => driver,
                None => {
                    let spawned = Driver::spawn(&self.command, self.tmux_socket.as_deref()).await?;
                    tenant.pid.store(spawned.child.id().unwrap_or(0), Ordering::Release);
                    spawned
                }
            };
            let mut calls = JoinSet::new();
            let duration = Duration::from_millis(request.timeout_ms.get());
            let execution = async {
                driver.send(&json!({"cellId":request.cell_id,"code":request.code,"timeoutMs":request.timeout_ms,"tenant":request.tenant})).await?;
                active.store(true, Ordering::Release);
                loop {
                    tokio::select! {
                        biased;
                        _ = cancelled.changed() => return Ok(terminal(&cell_id, "cancelled", &output)),
                        frame = driver.next() => match frame? {
                            Frame::Output { cell_id, stream, text, original_bytes } => {
                                if cell_id == request.cell_id.to_string() {
                                    output.lock().unwrap_or_else(PoisonError::into_inner).push(stream, &text, original_bytes);
                                }
                            }
                            Frame::ToolCall { cell_id, call_id, name, arguments } => {
                                if cell_id != request.cell_id.to_string() {
                                    return Err(CodeError::Frame(format!("tool call for another cell: {cell_id}")));
                                }
                                let call: ToolCall = oni_protocol::decode(json!({"cellId":cell_id,"name":name,"arguments":arguments}))?;
                                let client = caller.clone();
                                calls.spawn(async move {
                                    let answer: Result<Value, CodeError> = async {
                                        let params = serde_json::to_value(call)?;
                                        let answer = client.call_with_timeout(
                                            &WireMethod::MachineCallTool.to_string(),
                                            Some(params),
                                            duration,
                                        ).await.map_err(|error| CodeError::Frame(error.to_string()))?
                                            .ok_or(CodeError::Exited)?;
                                        let answer: ToolCallResult = oni_protocol::decode(answer)?;
                                        Ok(serde_json::to_value(answer)?)
                                    }.await;
                                    let mut value = answer.unwrap_or_else(|error| json!({"status":"failed","error":error.to_string()}));
                                    value["callId"] = json!(call_id);
                                    value
                                });
                            }
                            Frame::Result { result } => {
                                let answer: CellResult = oni_protocol::decode(result)?;
                                return Ok(serde_json::to_value(answer)?);
                            }
                            Frame::Lifecycle => return Err(CodeError::Exited),
                        },
                        Some(answer) = calls.join_next(), if !calls.is_empty() => {
                            driver.send(&answer?).await?;
                        }
                    }
                }
            };
            let answer = match timeout_at(deadline, execution).await {
                Ok(answer) => answer,
                Err(_) => Ok(terminal(&cell_id, "timed_out", &output)),
            };
            calls.abort_all();
            active.store(false, Ordering::Release);
            // Only a cell the interpreter finished on its own leaves it reusable;
            // a stopped, timed-out or broken one takes the tenant down with it.
            if matches!(&answer, Ok(value) if value["status"] == "completed" || value["status"] == "raised") {
                *guard = Some(driver);
                self.retire_idle(&tenant_id, &tenant);
                drop(guard);
            } else {
                Driver::signal(&tenant.pid, Signal::SIGINT);
                driver.reap(STOP_GRACE).await;
                tenant.pid.store(0, Ordering::Release);
            }
            answer
        }.await;
        result
    }

    fn retire_idle(&self, tenant_id: &str, tenant: &Tenant) {
        let mut tenants = self.tenants.lock().unwrap_or_else(PoisonError::into_inner);
        let mut idle = self.idle.lock().unwrap_or_else(PoisonError::into_inner);
        // A tenant can finish while a later cell is queued for its lock.
        // The queue is cleared when that run begins, so retire only
        // drivers whose mutex is actually free.
        if tenant.users.load(Ordering::Acquire) == 1 {
            idle.push_back(tenant_id.to_owned());
        }
        while idle.len() > 8 {
            let retired = idle.pop_front().and_then(|id| {
                let candidate = tenants.get(&id)?.clone();
                let mut state = candidate.driver.try_lock().ok()?;
                let old = state.take();
                drop(state);
                tenants.remove(&id);
                Some(old)
            });
            if let Some(Some(old)) = retired {
                self.cleanup
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(tokio::spawn(old.reap(STOP_GRACE)));
            }
        }
    }
}

impl Default for Code {
    fn default() -> Self {
        Self::with_command(PathBuf::from("python3"))
    }
}
