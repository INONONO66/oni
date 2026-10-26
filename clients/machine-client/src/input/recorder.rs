//! The headless driver: records every event instead of injecting it, so
//! tests and display-less machines drive the same plan and anchor path as
//! the native driver without moving a real pointer.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, PoisonError,
};

use super::{Driver, Event};

#[derive(Clone, Debug, Default)]
pub struct Recorder {
    events: Arc<Mutex<Vec<Event>>>,
    denied: Arc<AtomicBool>,
    failing: Arc<Mutex<Vec<usize>>>,
    attempts: Arc<Mutex<usize>>,
}

impl Recorder {
    /// Every event injected so far, in order.
    pub fn events(&self) -> Vec<Event> {
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Withdraws (or restores) the platform permission.
    pub fn deny(&self, denied: bool) {
        self.denied.store(denied, Ordering::SeqCst);
    }

    /// Fails the injection attempts numbered in `attempts` from now on.
    pub fn fail(&self, attempts: &[usize]) {
        let base = *self.attempts.lock().unwrap_or_else(PoisonError::into_inner);
        *self.failing.lock().unwrap_or_else(PoisonError::into_inner) =
            attempts.iter().map(|attempt| base + attempt).collect();
    }
}

impl Driver for Recorder {
    fn permitted(&self) -> bool {
        !self.denied.load(Ordering::SeqCst)
    }

    fn inject(&mut self, event: &Event) -> Result<(), String> {
        let mut attempts = self.attempts.lock().unwrap_or_else(PoisonError::into_inner);
        let attempt = *attempts;
        *attempts += 1;
        let failing = self.failing.lock().unwrap_or_else(PoisonError::into_inner);
        if failing.contains(&attempt) {
            return Err(format!("scripted failure at attempt {attempt}"));
        }
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(event.clone());
        Ok(())
    }
}
