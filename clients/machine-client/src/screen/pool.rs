//! The fixed-capacity frame pool. A lease holds one slot's buffers for one
//! capture; at capacity a capture is refused rather than queued. A slot goes
//! back to the idle set only when its capture succeeded and no release
//! happened meanwhile, so a failed capture, a detach or a memory shed always
//! frees the buffers.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// The buffers of one capture: the raw frame, the resample scratch and the
/// encoded output. Their capacity is what the pool retains between captures.
#[derive(Default)]
pub struct Slot {
    pub pixels: Vec<u8>,
    pub scratch: Vec<u8>,
    pub encoded: Vec<u8>,
}

impl Slot {
    fn bytes(&self) -> usize {
        self.pixels.capacity() + self.scratch.capacity() + self.encoded.capacity()
    }
}

struct State {
    idle: Vec<Slot>,
    busy: usize,
    epoch: u64,
    windows: HashMap<u32, u64>,
    next: u64,
}

pub struct Pool {
    capacity: usize,
    state: Mutex<State>,
}

pub struct Lease<'a> {
    pool: &'a Pool,
    pub slot: Slot,
    epoch: u64,
    keep: bool,
}

pub struct Ticket<'a> {
    pool: &'a Pool,
    window: u32,
    sequence: u64,
}

impl Ticket<'_> {
    pub fn current(&self) -> bool {
        self.pool.state().windows.get(&self.window) == Some(&self.sequence)
    }

    pub fn publish<T>(&self, publish: impl FnOnce() -> T) -> Option<T> {
        let mut state = self.pool.state();
        if state.windows.get(&self.window) != Some(&self.sequence) {
            return None;
        }
        state.windows.remove(&self.window);
        Some(publish())
    }
}

impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        let mut state = self.pool.state();
        if state.windows.get(&self.window) == Some(&self.sequence) {
            state.windows.remove(&self.window);
        }
    }
}

impl Pool {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            state: Mutex::new(State {
                idle: Vec::new(),
                busy: 0,
                epoch: 0,
                windows: HashMap::new(),
                next: 0,
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn begin(&self, window: u32) -> Ticket<'_> {
        let mut state = self.state();
        state.next += 1;
        let next = state.next;
        state.windows.insert(window, next);
        Ticket {
            pool: self,
            window,
            sequence: next,
        }
    }

    pub fn acquire(&self) -> Option<Lease<'_>> {
        let mut state = self.state();
        if state.busy >= self.capacity {
            return None;
        }
        state.busy += 1;
        Some(Lease {
            pool: self,
            slot: state.idle.pop().unwrap_or_default(),
            epoch: state.epoch,
            keep: false,
        })
    }

    /// Frees every idle slot and disowns the leased ones, which are then
    /// dropped instead of returned when their capture ends.
    pub fn release(&self) {
        let mut state = self.state();
        state.epoch += 1;
        state.idle.clear();
        state.windows.clear();
    }

    pub fn retained(&self) -> usize {
        self.state().idle.iter().map(Slot::bytes).sum()
    }
}

impl Lease<'_> {
    pub fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let slot = std::mem::take(&mut self.slot);
        let mut state = self.pool.state();
        state.busy -= 1;
        if self.keep && self.epoch == state.epoch {
            state.idle.push(slot);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_latest_window_ticket_publishes_and_release_invalidates_it() {
        let pool = Pool::new(2);
        let first = pool.begin(7);
        let second = pool.begin(7);
        assert_eq!(first.publish(|| 1), None);
        assert_eq!(second.publish(|| 2), Some(2));
        let third = pool.begin(7);
        pool.release();
        assert_eq!(third.publish(|| 3), None);
        drop(pool.begin(8));
        assert!(pool.state().windows.is_empty());
    }
}
