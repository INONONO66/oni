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
    routes: Arc<Mutex<Vec<Option<u32>>>>,
    cursor: Arc<Mutex<(i32, i32)>>,
}

impl Recorder {
    pub fn cursor(&self) -> (i32, i32) {
        *self.cursor.lock().unwrap_or_else(PoisonError::into_inner)
    }
    pub fn routes(&self) -> Vec<Option<u32>> {
        self.routes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
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
    fn pid_delivery(&self) -> bool {
        true
    }
    fn pointer_pid_delivery(&self) -> bool {
        true
    }

    fn post_to_pid(&mut self, pid: u32, event: &Event) -> Result<(), String> {
        self.record(event, Some(pid))
    }

    fn permitted(&self) -> bool {
        !self.denied.load(Ordering::SeqCst)
    }

    fn inject(&mut self, event: &Event) -> Result<(), String> {
        self.record(event, None)
    }
}

impl Recorder {
    fn record(&self, event: &Event, route: Option<u32>) -> Result<(), String> {
        let mut attempts = self.attempts.lock().unwrap_or_else(PoisonError::into_inner);
        let attempt = *attempts;
        *attempts += 1;
        let failing = self.failing.lock().unwrap_or_else(PoisonError::into_inner);
        if failing.contains(&attempt) {
            return Err(format!("scripted failure at attempt {attempt}"));
        }
        if let (None, Event::Move { x, y, .. }) = (route, event) {
            *self.cursor.lock().unwrap_or_else(PoisonError::into_inner) = (*x, *y);
        }
        self.events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(event.clone());
        self.routes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(route);
        Ok(())
    }
}
