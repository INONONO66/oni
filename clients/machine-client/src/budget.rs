use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BudgetAction {
    Healthy,
    Shed,
    Exit,
}

pub struct Budget {
    limit_bytes: u64,
    over: u8,
    under: u8,
    restricted: bool,
}

impl Budget {
    pub fn new(megabytes: u64) -> Self {
        Self {
            limit_bytes: megabytes.saturating_mul(1024 * 1024),
            over: 0,
            under: 0,
            restricted: false,
        }
    }

    pub fn sample(&mut self, rss_bytes: u64) -> BudgetAction {
        if rss_bytes > self.limit_bytes {
            self.over = self.over.saturating_add(1);
            self.under = 0;
            let shed = !self.restricted;
            self.restricted = true;
            if self.over >= 3 {
                BudgetAction::Exit
            } else if shed {
                BudgetAction::Shed
            } else {
                BudgetAction::Healthy
            }
        } else {
            self.over = 0;
            self.under = self.under.saturating_add(1);
            if self.under >= 2 {
                self.restricted = false;
            }
            BudgetAction::Healthy
        }
    }

    pub fn restricted(&self) -> bool {
        self.restricted
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Retained {
    pub pty_bytes: usize,
    pub transfers: usize,
}

/// The hook the runtime wiring implements so memory pressure can measure and
/// release retained PTY output and open transfer buffers. The attach loop
/// calls `shed` once each time the budget enters the restricted state.
pub trait Pressure: Send + Sync {
    fn retained(&self) -> Retained;
    fn shed(&self);
}

pub struct NoRetention;

impl Pressure for NoRetention {
    fn retained(&self) -> Retained {
        Retained::default()
    }

    fn shed(&self) {}
}

pub fn refusal(method: &str, params: Option<&Value>) -> Option<Value> {
    match method {
        "machine.exec" => Some(json!({"status":"refused","reason":"exec_not_available"})),
        "machine.fs_stream" if params.is_some_and(|value| value["op"] == "begin") => Some(
            json!({"status":"refused","reason":"too_large","message":"memory budget exceeded"}),
        ),
        _ => None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub at: u64,
    pub rss_bytes: u64,
    pub in_flight: usize,
    pub retained_pty_bytes: usize,
    pub transfers: usize,
}
