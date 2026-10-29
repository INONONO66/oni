use std::sync::Mutex;

use super::*;
use crate::screen::{
    ax::{ActFault, Action, Admit, AppIdentity, Bounds, Observer, Segment, Walk, WindowIdentity},
    fixture::Fixture,
    Fault,
};

#[derive(Default)]
struct Model {
    clock: Option<Instant>,
    events: Vec<(Instant, Notification)>,
    walks: usize,
    during: Vec<(usize, Duration, Notification)>,
    tokens: Vec<u64>,
    fault: Option<Fault>,
    budgets: Vec<Duration>,
    before_commit: Option<Notification>,
}

struct FakeObserver(Arc<Mutex<Model>>);

impl Observer for FakeObserver {
    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
        let mut model = self.0.lock().expect("model");
        if let Some(fault) = &model.fault {
            return Err(fault.clone());
        }
        let token = if model.tokens.len() > 1 {
            model.tokens.remove(0)
        } else {
            model.tokens.first().copied().unwrap_or(0)
        };
        Ok(vec![WindowIdentity {
            pid: 42,
            window_id: 7,
            owner_pid: 42,
            title: "Test".into(),
            app: AppIdentity {
                bundle_id: None,
                path: "/fixture/42".into(),
            },
            token,
            origin: (0, 0),
            minimized: false,
        }])
    }
    fn walk(&self, _: &WindowIdentity, bounds: &Bounds) -> Result<Walk, Fault> {
        let mut model = self.0.lock().expect("model");
        model.walks += 1;
        model.budgets.push(bounds.budget);
        let during = std::mem::take(&mut model.during);
        for (walk, delay, event) in during {
            if walk == model.walks {
                let now = model.clock.expect("armed clock") + delay;
                model.clock = Some(now);
                model.events.push((now, event));
            } else {
                model.during.push((walk, delay, event));
            }
        }
        Ok(Walk {
            nodes: vec![],
            focused: None,
            complete: true,
        })
    }
    fn act(
        &self,
        _: &WindowIdentity,
        _: &[Segment],
        _: Admit<'_>,
        _: &Action,
    ) -> Result<(), ActFault> {
        Err(ActFault::Unsupported)
    }
}

struct Feed {
    model: Arc<Mutex<Model>>,
    observer: Arc<dyn Observer>,
}

impl Subscription for Feed {
    fn now(&self) -> Instant {
        self.model.lock().expect("model").clock.expect("clock")
    }
    fn receive_until(&mut self, deadline: Instant) -> Option<(Instant, Notification)> {
        let mut model = self.model.lock().expect("model");
        if model.events.first().is_some_and(|(at, _)| *at <= deadline) {
            let event = model.events.remove(0);
            model.clock = Some(model.clock.expect("clock").max(event.0));
            Some(event)
        } else {
            model.clock = Some(model.clock.expect("clock").max(deadline));
            None
        }
    }
    fn sample(&mut self, deadline: Instant) -> Result<Sample, observe::Refusal> {
        observer::sample(self.observer.as_ref(), 42, 7, deadline, || self.now())
    }
    fn commit_if_current(&mut self, commit: Box<dyn FnOnce() -> Value + '_>) -> Option<Value> {
        let mut model = self.model.lock().expect("model");
        if let Some(event) = model.before_commit.take() {
            let now = model.clock.expect("clock");
            model.events.push((now, event));
            None
        } else {
            Some(commit())
        }
    }
}

struct FakeNotifications {
    model: Arc<Mutex<Model>>,
    delay: Duration,
    events: Vec<(Duration, Notification)>,
    blocker: Option<Unsupported>,
}

impl Notifications for FakeNotifications {
    fn subscribe(
        &self,
        _: u32,
        _: u32,
        start: Instant,
        _: Instant,
        observer: Arc<dyn Observer>,
    ) -> Result<Box<dyn Subscription>, Unsupported> {
        if let Some(blocker) = self.blocker {
            return Err(blocker);
        }
        {
            let mut model = self.model.lock().expect("model");
            model.clock = Some(start + self.delay);
            model.events = self
                .events
                .iter()
                .map(|(at, kind)| (start + *at, *kind))
                .collect();
        }
        Ok(Box::new(Feed {
            model: Arc::clone(&self.model),
            observer,
        }))
    }
}

fn setup(
    model: Model,
    delay: u64,
    events: Vec<(u64, Notification)>,
    blocker: Option<Unsupported>,
) -> (Screen, Arc<Mutex<Model>>) {
    let model = Arc::new(Mutex::new(model));
    let screen = Screen::new(Box::new(Fixture::display(100, 100, 1.0)), 1)
        .observing(Box::new(FakeObserver(Arc::clone(&model))))
        .notifying(Box::new(FakeNotifications {
            model: Arc::clone(&model),
            delay: Duration::from_millis(delay),
            events: events
                .into_iter()
                .map(|(ms, event)| (Duration::from_millis(ms), event))
                .collect(),
            blocker,
        }));
    (screen, model)
}

fn request(quiet: u64, timeout: u64) -> ScreenSettleRequest {
    oni_protocol::decode(json!({
        "target": {"pid": 42, "windowId": 7, "epoch": 0}, "quietMs": quiet, "timeoutMs": timeout
    }))
    .expect("valid settle")
}

fn since(screen: &Screen, id: &str) -> Value {
    screen.observe(
        &oni_protocol::decode(json!({
            "target": {"pid": 42, "windowId": 7}, "since": id, "screenshot": false
        }))
        .expect("valid observe"),
    )
}

#[test]
fn settle_commits_fresh_observation_usable_as_since() {
    let (screen, model) = setup(Model::default(), 0, vec![], None);
    assert_eq!(
        screen.settle(&request(50, 100)),
        json!({"status":"settled", "observationId":"o2"})
    );
    assert_eq!(model.lock().expect("model").walks, 2);
    assert_eq!(since(&screen, "o2")["diff"]["since"], "o2");
}

#[test]
fn delayed_readiness_never_counts_unobserved_time_as_quiet() {
    let (screen, _) = setup(Model::default(), 70, vec![], None);
    assert_eq!(
        screen.settle(&request(50, 100)),
        json!({"status":"pending", "observationId":"o2", "changesInWindow":0})
    );
}

#[test]
fn changes_including_equal_deadline_reset_quiet_and_count() {
    for (events, quiet, expected) in [
        (
            vec![(20, Notification::Changed), (40, Notification::Changed)],
            50,
            "settled",
        ),
        (vec![(100, Notification::Changed)], 100, "pending"),
    ] {
        let (screen, _) = setup(Model::default(), 0, events, None);
        let result = screen.settle(&request(quiet, 100));
        assert_eq!(result["status"], expected);
        if expected == "pending" {
            assert_eq!(result["changesInWindow"], 1);
        }
    }
}

#[test]
fn events_during_final_sample_are_processed_before_commit() {
    for (event, expected) in [
        (Notification::Changed, "pending"),
        (Notification::Destroyed, "destroyed"),
        (Notification::Unresolved, "pending"),
        (Notification::Lost, "unsupported"),
    ] {
        let model = Model {
            during: vec![(2, Duration::from_millis(60), event)],
            ..Model::default()
        };
        let (screen, _) = setup(model, 0, vec![], None);
        let result = screen.settle(&request(50, 100));
        assert_eq!(result["status"], expected);
        if event == Notification::Changed {
            assert_eq!(result["changesInWindow"], 1);
        }
        if matches!(event, Notification::Destroyed | Notification::Lost) {
            assert!(result.get("observationId").is_none());
        }
    }
}

#[test]
fn changed_sample_is_discarded_and_a_new_quiet_interval_is_required() {
    let model = Model {
        during: vec![(2, Duration::ZERO, Notification::Changed)],
        ..Model::default()
    };
    let (screen, model) = setup(model, 0, vec![], None);
    assert_eq!(screen.settle(&request(50, 200))["status"], "settled");
    assert_eq!(model.lock().expect("model").walks, 3);
}

#[test]
fn a_notification_between_sample_drain_and_commit_cannot_settle() {
    let (screen, _) = setup(
        Model {
            before_commit: Some(Notification::Destroyed),
            ..Model::default()
        },
        0,
        vec![],
        None,
    );
    assert_eq!(
        screen.settle(&request(50, 100)),
        json!({"status":"destroyed"})
    );
}

#[test]
fn unresolved_attribution_blocks_quiet_until_resolved() {
    for (events, expected) in [
        (vec![(20, Notification::Unresolved)], "pending"),
        (
            vec![(20, Notification::Unresolved), (30, Notification::Resolved)],
            "settled",
        ),
    ] {
        let (screen, _) = setup(Model::default(), 0, events, None);
        assert_eq!(screen.settle(&request(50, 100))["status"], expected);
    }
}

#[test]
fn destroyed_target_invalidates_old_epoch_and_snapshot_even_with_same_identity() {
    let (screen, _) = setup(
        Model::default(),
        0,
        vec![(20, Notification::Destroyed)],
        None,
    );
    assert_eq!(
        screen.settle(&request(50, 100)),
        json!({"status":"destroyed"})
    );
    assert_eq!(since(&screen, "o1")["reason"], "stale_observation");
    assert_eq!(screen.settle(&request(50, 100))["reason"], "epoch_changed");
}

#[test]
fn event_armed_before_baseline_is_counted() {
    let model = Model {
        during: vec![(1, Duration::ZERO, Notification::Changed)],
        ..Model::default()
    };
    let (screen, _) = setup(model, 0, vec![], None);
    assert_eq!(
        screen.settle(&request(200, 100)),
        json!({"status":"pending", "observationId":"o2", "changesInWindow":1})
    );
}

#[test]
fn destruction_during_baseline_still_invalidates_the_target() {
    let model = Model {
        during: vec![(1, Duration::ZERO, Notification::Destroyed)],
        ..Model::default()
    };
    let (screen, _) = setup(model, 0, vec![], None);
    assert_eq!(screen.settle(&request(50, 100))["status"], "destroyed");
    assert_eq!(screen.settle(&request(50, 100))["reason"], "epoch_changed");
}

#[test]
fn subscription_blockers_and_absent_sources_remain_distinct() {
    for (blocker, expected) in [
        (
            Unsupported::AccessibilityNotGranted,
            json!({"status":"unsupported","blocker":"accessibility_not_granted"}),
        ),
        (
            Unsupported::NoObserver,
            json!({"status":"unsupported","blocker":"no_observer"}),
        ),
        (
            Unsupported::WindowNotFound,
            json!({"status":"refused","reason":"window_not_found"}),
        ),
    ] {
        let (screen, _) = setup(Model::default(), 0, vec![], Some(blocker));
        assert_eq!(screen.settle(&request(50, 100)), expected);
    }
    assert_eq!(
        Screen::absent().settle(&request(50, 100))["blocker"],
        "no_observer"
    );
}

#[test]
fn oversized_target_and_sample_faults_are_typed() {
    let (screen, _) = setup(Model::default(), 0, vec![], None);
    let oversized = oni_protocol::decode(json!({
        "target":{"pid":4294967296_u64,"windowId":7,"epoch":0}, "quietMs":50,"timeoutMs":100
    }))
    .expect("wire target");
    assert_eq!(screen.settle(&oversized)["reason"], "window_not_found");
    for (fault, field, expected) in [
        (Fault::Permission, "reason", "permission_denied"),
        (Fault::WindowNotFound, "reason", "window_not_found"),
        (Fault::Absent, "blocker", "no_observer"),
    ] {
        let (screen, _) = setup(
            Model {
                fault: Some(fault),
                ..Model::default()
            },
            0,
            vec![],
            None,
        );
        assert_eq!(screen.settle(&request(50, 100))[field], expected);
    }
}

#[test]
fn final_sample_refuses_recreated_epoch() {
    let (screen, _) = setup(
        Model {
            tokens: vec![1, 2],
            ..Model::default()
        },
        0,
        vec![],
        None,
    );
    assert_eq!(screen.settle(&request(50, 100))["reason"], "epoch_changed");
}

#[test]
fn observation_budget_and_overrun_are_bounded() {
    let (screen, model) = setup(Model::default(), 0, vec![], None);
    screen.settle(&request(50, 100));
    assert_eq!(
        model.lock().expect("model").budgets,
        vec![Duration::from_millis(100), Duration::from_millis(500)]
    );
    let (screen, _) = setup(
        Model {
            during: vec![(1, Duration::from_millis(101), Notification::Changed)],
            ..Model::default()
        },
        0,
        vec![],
        None,
    );
    assert_eq!(screen.settle(&request(50, 100))["blocker"], "no_observer");
    let (screen, _) = setup(Model::default(), 100, vec![], None);
    assert_eq!(screen.settle(&request(50, 100))["blocker"], "no_observer");
}
