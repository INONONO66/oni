use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, PoisonError,
    },
};

use serde_json::{json, Value};

const LIMIT: usize = 4096;

pub struct Entry {
    generation: u64,
    cancelled: AtomicBool,
    started: AtomicBool,
    dispatched: AtomicBool,
    delivered: AtomicUsize,
    finished: AtomicBool,
}

pub struct Completion(pub Arc<Entry>);

impl Drop for Completion {
    fn drop(&mut self) {
        self.0.finish();
    }
}

struct Records {
    entries: HashMap<String, Arc<Entry>>,
    order: VecDeque<String>,
}

pub struct DispatchLedger {
    current: AtomicU64,
    records: Mutex<Records>,
}

impl Default for DispatchLedger {
    fn default() -> Self {
        Self {
            current: AtomicU64::new(0),
            records: Mutex::new(Records {
                entries: HashMap::new(),
                order: VecDeque::new(),
            }),
        }
    }
}

impl DispatchLedger {
    pub fn attach(&self, generation: u64) {
        if self.current.swap(generation, Ordering::SeqCst) != generation {
            self.cancel();
        }
    }

    pub fn cancel(&self) {
        let records = self.records.lock().unwrap_or_else(PoisonError::into_inner);
        for entry in records.entries.values() {
            if !entry.finished.load(Ordering::SeqCst) {
                entry.cancelled.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn start(&self, request_id: &str) -> Result<Arc<Entry>, Value> {
        let mut records = self.records.lock().unwrap_or_else(PoisonError::into_inner);
        if records.entries.contains_key(request_id) {
            return Err(json!({"status":"refused","reason":"request_busy"}));
        }
        while records.entries.len() >= LIMIT {
            let Some(index) = records.order.iter().position(|id| {
                records
                    .entries
                    .get(id)
                    .is_some_and(|entry| entry.finished.load(Ordering::SeqCst))
            }) else {
                return Err(json!({"status":"refused","reason":"request_busy"}));
            };
            if let Some(oldest) = records.order.remove(index) {
                records.entries.remove(&oldest);
            }
        }
        let entry = Arc::new(Entry {
            generation: request_id
                .split_once('-')
                .and_then(|(generation, _)| generation.parse().ok())
                .unwrap_or(0),
            cancelled: AtomicBool::new(false),
            started: AtomicBool::new(false),
            dispatched: AtomicBool::new(false),
            delivered: AtomicUsize::new(0),
            finished: AtomicBool::new(false),
        });
        records.order.push_back(request_id.to_owned());
        records.entries.insert(request_id.to_owned(), entry.clone());
        Ok(entry)
    }

    pub fn status(&self, request_id: &str) -> Value {
        let records = self.records.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = records.entries.get(request_id) else {
            return json!({"status":"refused","reason":"request_unknown"});
        };
        let delivered = entry.delivered.load(Ordering::SeqCst);
        let state =
            if entry.finished.load(Ordering::SeqCst) && entry.cancelled.load(Ordering::SeqCst) {
                "cancelled"
            } else if entry.finished.load(Ordering::SeqCst) {
                "completed"
            } else if entry.started.load(Ordering::SeqCst) {
                "dispatched"
            } else {
                "not_started"
            };
        if state == "cancelled" {
            json!({"status":"ok","requestId":request_id,"dispatched":entry.dispatched.load(Ordering::SeqCst),"state":state,"eventsDelivered":delivered})
        } else {
            json!({"status":"ok","requestId":request_id,"dispatched":entry.dispatched.load(Ordering::SeqCst),"state":state})
        }
    }

    pub fn current(&self) -> u64 {
        self.current.load(Ordering::SeqCst)
    }
}

impl Entry {
    pub fn before_event(&self, current: u64) -> bool {
        !self.cancelled.load(Ordering::SeqCst) && self.generation == current
    }

    pub fn delivered(&self) {
        self.delivered.fetch_add(1, Ordering::SeqCst);
    }

    pub fn dispatching(&self) {
        self.started.store(true, Ordering::SeqCst);
        self.dispatched.store(true, Ordering::SeqCst);
    }

    pub fn dispatched(&self) -> bool {
        self.dispatched.load(Ordering::SeqCst)
    }

    pub fn starting(&self) {
        self.started.store(true, Ordering::SeqCst);
    }

    pub fn finish(&self) {
        self.finished.store(true, Ordering::SeqCst);
    }

    pub fn cancelled_result(&self) -> Value {
        self.cancelled.store(true, Ordering::SeqCst);
        json!({"status":"unverifiable","reason":"cancelled","dispatched":self.dispatched.load(Ordering::SeqCst),"hint":"re_observe"})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{delivery::Route, inject, Driver, Event};

    struct CancellingDriver {
        ledger: Arc<DispatchLedger>,
        cancel_at: usize,
        events: Vec<Event>,
    }

    impl Driver for CancellingDriver {
        fn permitted(&self) -> bool {
            true
        }
        fn inject(&mut self, event: &Event) -> Result<(), String> {
            self.events.push(event.clone());
            if self.events.len() == self.cancel_at {
                self.ledger.cancel();
            }
            Ok(())
        }
        fn pid_delivery(&self) -> bool {
            true
        }
        fn post_to_pid(&mut self, _: u32, event: &Event) -> Result<(), String> {
            self.inject(event)
        }
    }

    fn cutoff(cancel_at: usize, expected: usize) {
        let ledger = Arc::new(DispatchLedger::default());
        ledger.attach(1);
        let entry = ledger.start("1-1").expect("first request");
        let mut driver = CancellingDriver {
            ledger: ledger.clone(),
            cancel_at,
            events: Vec::new(),
        };
        assert!(driver.permitted());
        assert!(driver.pid_delivery());
        let events = [
            Event::Text("a".into()),
            Event::Text("b".into()),
            Event::Text("c".into()),
        ];
        if cancel_at == 0 {
            ledger.cancel();
        }
        let outcome = inject(
            &mut driver,
            &mut Vec::new(),
            Route::Background(42),
            &events,
            Some((&entry, &ledger)),
        );
        assert_eq!(driver.events.len(), expected);
        assert_eq!(
            outcome.err().map(|refusal| refusal.reason),
            Some("cancelled")
        );
        assert_eq!(entry.cancelled_result()["dispatched"], expected > 0);
    }

    #[test]
    fn stops_before_any_native_event_when_cancelled() {
        cutoff(0, 0);
    }

    #[test]
    fn stops_after_first_native_event_when_cancelled() {
        cutoff(1, 1);
    }

    #[test]
    fn stops_before_last_native_event_when_cancelled() {
        cutoff(2, 2);
    }

    #[test]
    fn starts_without_events_and_rejects_duplicate() {
        let ledger = DispatchLedger::default();
        ledger.attach(1);
        let entry = ledger.start("1-1").expect("first request");
        assert_eq!(
            ledger.status("1-1"),
            json!({"status":"ok","requestId":"1-1","dispatched":false,"state":"not_started"})
        );
        assert_eq!(
            ledger.start("1-1").err(),
            Some(json!({"status":"refused","reason":"request_busy"}))
        );
        assert!(entry.before_event(ledger.current()));
        entry.starting();
        assert_eq!(
            ledger.status("1-1"),
            json!({"status":"ok","requestId":"1-1","dispatched":false,"state":"dispatched"})
        );
    }

    #[test]
    fn cancellation_before_first_event_is_not_dispatched() {
        let ledger = DispatchLedger::default();
        ledger.attach(1);
        let entry = ledger.start("1-1").expect("first request");
        ledger.cancel();
        assert!(!entry.before_event(ledger.current()));
        entry.finish();
        assert_eq!(
            ledger.status("1-1"),
            json!({"status":"ok","requestId":"1-1","dispatched":false,"state":"cancelled","eventsDelivered":0})
        );
    }

    #[test]
    fn supersession_after_first_event_preserves_dispatched() {
        let ledger = DispatchLedger::default();
        ledger.attach(1);
        let entry = ledger.start("1-1").expect("first request");
        entry.starting();
        entry.dispatching();
        entry.delivered();
        assert_eq!(
            ledger.status("1-1"),
            json!({"status":"ok","requestId":"1-1","dispatched":true,"state":"dispatched"})
        );
        ledger.attach(2);
        assert!(!entry.before_event(ledger.current()));
        assert_eq!(
            entry.cancelled_result(),
            json!({"status":"unverifiable","reason":"cancelled","dispatched":true,"hint":"re_observe"})
        );
    }

    #[test]
    fn completion_survives_same_generation_reconnect() {
        let ledger = DispatchLedger::default();
        ledger.attach(1);
        let entry = ledger.start("1-1").expect("first request");
        entry.dispatching();
        entry.delivered();
        entry.finish();
        ledger.attach(1);
        assert_eq!(
            ledger.status("1-1"),
            json!({"status":"ok","requestId":"1-1","dispatched":true,"state":"completed"})
        );
        assert_eq!(
            ledger.status("1-2"),
            json!({"status":"refused","reason":"request_unknown"})
        );
    }

    #[test]
    fn oldest_status_expires_when_capacity_is_reached() {
        let ledger = DispatchLedger::default();
        ledger.attach(1);
        for sequence in 1..=LIMIT + 1 {
            ledger
                .start(&format!("1-{sequence}"))
                .expect("unique request")
                .finish();
        }
        assert_eq!(
            ledger.status("1-1"),
            json!({"status":"refused","reason":"request_unknown"})
        );
        assert_eq!(
            ledger.status("1-4097"),
            json!({"status":"ok","requestId":"1-4097","dispatched":false,"state":"completed"})
        );
    }

    #[test]
    fn active_oldest_entry_survives_terminal_evictions_and_remains_cancellable() {
        let ledger = DispatchLedger::default();
        ledger.attach(1);
        let active = ledger.start("1-1").expect("active request");
        active.dispatching();
        for sequence in 2..=LIMIT + 1 {
            ledger
                .start(&format!("1-{sequence}"))
                .expect("new request")
                .finish();
        }
        assert_eq!(ledger.status("1-1")["state"], "dispatched");
        assert_eq!(
            ledger.start("1-1").err(),
            Some(json!({"status":"refused","reason":"request_busy"}))
        );
        ledger.cancel();
        assert!(!active.before_event(ledger.current()));
        active.cancelled_result();
        active.finish();
        assert_eq!(
            ledger.status("1-1"),
            json!({"status":"ok","requestId":"1-1","dispatched":true,"state":"cancelled","eventsDelivered":0})
        );
    }

    #[test]
    fn full_active_capacity_refuses_new_admission_without_eviction() {
        let ledger = DispatchLedger::default();
        ledger.attach(1);
        for sequence in 1..=LIMIT {
            ledger
                .start(&format!("1-{sequence}"))
                .expect("active request");
        }
        assert_eq!(
            ledger.start("1-4097").err(),
            Some(json!({"status":"refused","reason":"request_busy"}))
        );
        assert_eq!(ledger.status("1-1")["state"], "not_started");
        ledger.cancel();
        assert_eq!(
            ledger.start("1-1").err(),
            Some(json!({"status":"refused","reason":"request_busy"}))
        );
    }

    #[test]
    fn a_native_failure_after_dispatch_preserves_the_dispatch_fact() {
        struct FailingDriver;
        impl Driver for FailingDriver {
            fn permitted(&self) -> bool {
                true
            }
            fn inject(&mut self, _: &Event) -> Result<(), String> {
                Err("failed".into())
            }
            fn pid_delivery(&self) -> bool {
                true
            }
            fn post_to_pid(&mut self, _: u32, event: &Event) -> Result<(), String> {
                self.inject(event)
            }
        }
        let ledger = DispatchLedger::default();
        ledger.attach(1);
        let entry = ledger.start("1-1").expect("first request");
        assert!(!entry.dispatched());
        let mut driver = FailingDriver;
        assert!(driver.permitted());
        assert!(driver.pid_delivery());
        let outcome = inject(
            &mut driver,
            &mut Vec::new(),
            Route::Background(42),
            &[Event::Text("hello".into())],
            Some((&entry, &ledger)),
        );
        assert_eq!(
            outcome.err().map(|refusal| refusal.reason),
            Some("input_failed")
        );
        assert!(entry.dispatched());
        assert_eq!(
            ledger.status("1-1"),
            json!({"status":"ok","requestId":"1-1","dispatched":true,"state":"dispatched"})
        );
        entry.finish();
        assert_eq!(ledger.status("1-1")["dispatched"], true);
    }
}
