use std::{
    cell::Cell,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

use super::*;
use crate::screen::{
    ax::{ActFault, Action, Admit, AppIdentity, Bounds, Observer, Segment, Walk, WindowIdentity},
    fixture::Fixture,
    Fault, Window,
};

#[derive(Default)]
struct Model {
    clock: Option<Instant>,
    events: Vec<(Instant, Notification)>,
    walks: usize,
    during: Vec<(usize, Duration, Notification)>,
    tokens: Vec<u64>,
    fault: Option<Fault>,
    fault_after_windows: Option<(usize, Fault)>,
    window_reads: usize,
    budgets: Vec<Duration>,
    before_commit: Option<Notification>,
    private: bool,
}

struct FakeObserver(Arc<Mutex<Model>>);

impl Observer for FakeObserver {
    fn focused(
        &self,
        _: &WindowIdentity,
    ) -> Result<Option<crate::screen::private::Focused>, Fault> {
        Ok(Some(crate::screen::private::Focused {
            role: "AXButton".into(),
            secure: self.0.lock().expect("model").private,
        }))
    }
    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
        let mut model = self.0.lock().expect("model");
        model.window_reads += 1;
        if let Some((after, fault)) = &model.fault_after_windows {
            if model.window_reads >= *after {
                return Err(fault.clone());
            }
        }
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
        json!({"status":"settled", "method":"accessibility", "observationId":"o2"})
    );
    assert_eq!(model.lock().expect("model").walks, 2);
    assert_eq!(since(&screen, "o2")["diff"]["since"], "o2");
}

#[test]
fn settle_private_focus_commits_only_empty_observations_without_walking() {
    let (screen, model) = setup(
        Model {
            private: true,
            ..Model::default()
        },
        0,
        vec![],
        None,
    );
    assert_eq!(
        screen.settle(&request(50, 100)),
        json!({"status":"settled", "method":"accessibility", "observationId":"o2"})
    );
    assert_eq!(model.lock().expect("model").walks, 0);
    let observation = since(&screen, "o2");
    assert_eq!(observation["private"], true);
    assert_eq!(observation["elements"], json!([]));
    assert!(observation.get("diff").is_none());
}

#[test]
fn delayed_readiness_never_counts_unobserved_time_as_quiet() {
    let (screen, _) = setup(Model::default(), 70, vec![], None);
    assert_eq!(
        screen.settle(&request(50, 100)),
        json!({"status":"pending", "method":"accessibility", "observationId":"o2", "changesInWindow":0})
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
        json!({"status":"pending", "method":"accessibility", "observationId":"o2", "changesInWindow":1})
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
fn observer_blockers_fall_back_to_window_capture_when_available() {
    for (blocker, expected) in [
        (
            Unsupported::AccessibilityNotGranted,
            json!({"status":"refused","reason":"window_not_found"}),
        ),
        (
            Unsupported::NoObserver,
            json!({"status":"refused","reason":"window_not_found"}),
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

fn pixel_fixture() -> Fixture {
    let mut fixture = Fixture::display(100, 100, 1.0);
    fixture.windows.push(Window {
        id: 7,
        display: 1,
        title: "Test".into(),
        owner: "fixture".into(),
        pid: Some(42),
        app: None,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
    });
    fixture
}

#[test]
fn pixel_sample_uses_window_capture_and_checks_target_identity() {
    let screen = Screen::new(Box::new(pixel_fixture()), 1);
    let source = screen.source().expect("fixture source");
    assert_eq!(
        screen
            .pixel_sample(source, 42, 7, 0)
            .expect("thumbnail")
            .len(),
        100 * 100 * 4
    );
    assert_eq!(
        screen.pixel_sample(source, 42, 7, 1).expect_err("epoch")["reason"],
        "epoch_changed"
    );
    assert_eq!(
        screen.pixel_sample(source, 43, 7, 0).expect_err("owner")["reason"],
        "window_not_found"
    );
    assert_eq!(
        screen
            .pixel_sample(source, std::process::id(), 7, 0)
            .expect_err("owner")["reason"],
        "window_not_found"
    );
}

#[test]
fn pixel_sample_refuses_excluded_owner_and_private_focus_before_capture() {
    let mut fixture = pixel_fixture();
    fixture.windows[0].pid = Some(std::process::id());
    let screen = Screen::new(Box::new(fixture), 1);
    assert_eq!(
        screen
            .pixel_sample(screen.source().expect("source"), std::process::id(), 7, 0)
            .expect_err("own window")["reason"],
        "excluded"
    );

    let (mut screen, _) = setup(
        Model {
            private: true,
            ..Model::default()
        },
        0,
        vec![],
        None,
    );
    screen.source = Some(Box::new(pixel_fixture()));
    assert_eq!(
        screen
            .pixel_sample(screen.source().expect("source"), 42, 7, 0)
            .expect_err("private focus")["reason"],
        "paused:private"
    );

    assert_eq!(
        screen
            .pixel_sample(screen.source().expect("source"), 42, 7, 1)
            .expect_err("stale window epoch")["reason"],
        "epoch_changed"
    );
}

struct PixelClock(Cell<Instant>);

impl app::Clock for PixelClock {
    fn now(&self) -> Instant {
        self.0.get()
    }

    fn wait(&self, duration: Duration) {
        self.0.set(self.0.get() + duration);
    }
}

#[test]
fn pixel_fallback_returns_fresh_window_capture_without_observer() {
    let screen = Screen::new(Box::new(pixel_fixture()), 1);
    let clock = PixelClock(Cell::new(Instant::now()));
    let result = screen.settle_pixels_with_clock(&request(500, 1000), 42, 7, &clock);
    assert_eq!(
        result,
        json!({"status":"settled","method":"pixels","captureId":"cap-1"})
    );
}

#[test]
fn pixel_fallback_requires_capture_and_reports_disappearing_anchor() {
    let screen = Screen::absent();
    let clock = PixelClock(Cell::new(Instant::now()));
    assert_eq!(
        screen.settle_pixels_with_clock(&request(500, 1000), 42, 7, &clock),
        json!({"status":"unsupported","blocker":"no_observer"})
    );
    let mut fixture = pixel_fixture();
    fixture.blank_windows.push(7);
    let screen = Screen::new(Box::new(fixture), 1);
    let result = screen.settle_pixels_with_clock(&request(500, 1000), 42, 7, &clock);
    assert_eq!(result["reason"], "capture_blank");
}

struct PixelSource {
    fixture: Fixture,
    ready_fault: Option<Fault>,
    invalid_frame: bool,
    vanish_after: Option<usize>,
    window_reads: AtomicUsize,
    change_each_capture: bool,
    captures: AtomicUsize,
    fail_capture_after: Option<usize>,
}

impl PixelSource {
    fn new() -> Self {
        Self {
            fixture: pixel_fixture(),
            ready_fault: None,
            invalid_frame: false,
            vanish_after: None,
            window_reads: AtomicUsize::new(0),
            change_each_capture: false,
            captures: AtomicUsize::new(0),
            fail_capture_after: None,
        }
    }
}

impl Source for PixelSource {
    fn ready(&self) -> Result<(), Fault> {
        self.ready_fault.clone().map_or(Ok(()), Err)
    }

    fn displays(&self) -> Result<Vec<crate::screen::Display>, Fault> {
        self.fixture.displays()
    }

    fn windows(&self) -> Result<Vec<Window>, Fault> {
        let calls = self.window_reads.fetch_add(1, Ordering::Relaxed) + 1;
        if self.vanish_after.is_some_and(|after| calls > after) {
            Ok(vec![])
        } else {
            self.fixture.windows()
        }
    }

    fn capture_display(&self, display: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        self.fixture.capture_display(display, pixels)
    }

    fn capture_window(&self, window: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault> {
        let captures = self.captures.fetch_add(1, Ordering::Relaxed) + 1;
        if self
            .fail_capture_after
            .is_some_and(|after| captures > after)
        {
            return Err(Fault::Permission);
        }
        if self.invalid_frame {
            Ok((0, 0))
        } else {
            let size = self.fixture.capture_window(window, pixels)?;
            if self.change_each_capture {
                let color = u8::try_from(captures % 2).expect("alternating fixture color");
                pixels.fill(color.saturating_mul(255));
            }
            Ok(size)
        }
    }
}

#[test]
fn pixel_fallback_reports_pending_when_window_pixels_keep_changing() {
    let source = PixelSource {
        change_each_capture: true,
        ..PixelSource::new()
    };
    let screen = Screen::new(Box::new(source), 1);
    assert_eq!(
        screen.settle(&request(50, 100)),
        json!({"status":"pending","method":"pixels","changesInWindow":1})
    );
}

#[test]
fn pixel_fallback_on_public_settle_reports_quiet_and_lost_windows() {
    let screen = Screen::new(Box::new(PixelSource::new()), 1);
    assert_eq!(
        screen.settle(&request(50, 100)),
        json!({"status":"settled","method":"pixels","captureId":"cap-1"})
    );

    let vanished = PixelSource {
        vanish_after: Some(1),
        ..PixelSource::new()
    };
    let screen = Screen::new(Box::new(vanished), 1);
    assert_eq!(screen.settle(&request(50, 100))["status"], "destroyed");

    let denied = PixelSource {
        fail_capture_after: Some(1),
        ..PixelSource::new()
    };
    let screen = Screen::new(Box::new(denied), 1);
    assert_eq!(
        screen.settle(&request(50, 100))["reason"],
        "permission_denied"
    );

    let denied_before_baseline = PixelSource {
        fail_capture_after: Some(0),
        ..PixelSource::new()
    };
    let screen = Screen::new(Box::new(denied_before_baseline), 1);
    assert_eq!(
        screen.settle(&request(50, 100))["reason"],
        "permission_denied"
    );

    let vanished_at_anchor = PixelSource {
        vanish_after: Some(2),
        ..PixelSource::new()
    };
    let screen = Screen::new(Box::new(vanished_at_anchor), 1);
    assert_eq!(screen.settle(&request(50, 100))["status"], "destroyed");
}

#[test]
fn pixel_fallback_refuses_capture_failure_after_quiet_window() {
    let source = PixelSource {
        fail_capture_after: Some(2),
        ..PixelSource::new()
    };
    let screen = Screen::new(Box::new(source), 1);
    let clock = PixelClock(Cell::new(Instant::now()));
    assert_eq!(
        screen.settle_pixels_with_clock(&request(50, 100), 42, 7, &clock)["reason"],
        "permission_denied"
    );
}

#[test]
fn pixel_sample_propagates_native_capture_failure() {
    let source = PixelSource {
        fail_capture_after: Some(0),
        ..PixelSource::new()
    };
    let screen = Screen::new(Box::new(source), 1);
    assert_eq!(
        screen
            .pixel_sample(screen.source().expect("source"), 42, 7, 0)
            .expect_err("capture permission")["reason"],
        "permission_denied"
    );
}

#[test]
fn pixel_fallback_handles_capture_permission_bad_frame_and_missing_anchor() {
    let clock = PixelClock(Cell::new(Instant::now()));
    let mut denied = pixel_fixture();
    denied.denied = true;
    let screen = Screen::new(Box::new(denied), 1);
    assert_eq!(
        screen.settle_pixels_with_clock(&request(500, 1000), 42, 7, &clock)["reason"],
        "permission_denied"
    );

    let mut source = PixelSource::new();
    source.ready_fault = Some(Fault::WindowNotFound);
    let screen = Screen::new(Box::new(source), 1);
    assert_eq!(
        screen.settle_pixels_with_clock(&request(500, 1000), 42, 7, &clock)["reason"],
        "window_not_found"
    );

    let mut source = PixelSource::new();
    source.invalid_frame = true;
    let screen = Screen::new(Box::new(source), 1);
    assert_eq!(
        screen.settle_pixels_with_clock(&request(500, 1000), 42, 7, &clock)["reason"],
        "permission_denied"
    );

    let mut source = PixelSource::new();
    source.vanish_after = Some(2);
    let screen = Screen::new(Box::new(source), 1);
    assert_eq!(
        screen.settle_pixels_with_clock(&request(500, 1000), 42, 7, &clock)["status"],
        "destroyed"
    );
}

#[test]
fn pixel_fallback_refuses_unknown_private_state() {
    for fault in [Fault::Permission, Fault::WindowNotFound] {
        let (mut screen, model) = setup(Model::default(), 0, vec![], None);
        screen.source = Some(Box::new(pixel_fixture()));
        model.lock().expect("model").fault_after_windows = Some((2, fault.clone()));
        let result = screen.pixel_sample(screen.source().expect("source"), 42, 7, 0);
        if fault == Fault::Permission {
            assert!(result.is_ok());
        } else {
            assert_eq!(
                result.expect_err("window lost")["reason"],
                "window_not_found"
            );
        }
    }
}
