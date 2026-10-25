use std::{collections::HashMap, sync::Mutex, time::Duration};

use serde_json::Value;
use tokio::sync::oneshot;

pub const CALL_TIMEOUT: Duration = Duration::from_millis(30_000);

#[derive(Debug, thiserror::Error)]
pub enum CallError {
    #[error("request timeout: {0}")]
    Timeout(String),
    #[error("IPC connection closed")]
    Disconnected,
    #[error("IPC remote error: {0}")]
    Remote(String),
}

#[derive(Default)]
pub struct RequestTable {
    next_id: u64,
    pending: HashMap<String, oneshot::Sender<Value>>,
}

pub struct Pending<'a> {
    pub id: String,
    table: &'a Mutex<RequestTable>,
}

impl<'a> Pending<'a> {
    pub fn new(id: String, table: &'a Mutex<RequestTable>) -> Self {
        Self { id, table }
    }
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if let Ok(mut table) = self.table.lock() {
            table.remove(&self.id);
        }
    }
}

impl RequestTable {
    pub fn register(&mut self) -> (String, oneshot::Receiver<Value>) {
        self.next_id += 1;
        let id = format!("c{}", self.next_id);
        let (sender, receiver) = oneshot::channel();
        self.pending.insert(id.clone(), sender);
        (id, receiver)
    }

    pub fn resolve(&mut self, id: &str, response: Value) {
        if let Some(sender) = self.pending.remove(id) {
            let _delivered = sender.send(response);
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.pending.remove(id);
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}
