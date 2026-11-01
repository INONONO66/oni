use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    sync::Mutex,
};

use super::*;
use crate::screen::{
    ax::{ActFault, Action, Admit, Segment, Walk, WindowIdentity},
    Fault,
};

#[derive(Clone)]
struct Element {
    id: u32,
    proxy: u32,
    window: Option<u32>,
}

struct Fake {
    now: Cell<Instant>,
    granted_at: Instant,
    tree: RefCell<HashMap<u32, Vec<Element>>>,
    registered: RefCell<Vec<u32>>,
    resolved: RefCell<HashMap<u32, u32>>,
    fail: Option<u32>,
    open_error: Option<Unsupported>,
    events: RefCell<Vec<Event<Element>>>,
    sample_event: bool,
    stopped: Option<Sender<()>>,
}

fn element(id: u32) -> Element {
    Element {
        id,
        proxy: id,
        window: Some(7),
    }
}

fn fake(start: Instant) -> Fake {
    Fake {
        now: Cell::new(start),
        granted_at: start,
        tree: RefCell::new(HashMap::new()),
        registered: RefCell::new(Vec::new()),
        resolved: RefCell::new(HashMap::new()),
        fail: None,
        open_error: None,
        events: RefCell::new(Vec::new()),
        sample_event: false,
        stopped: None,
    }
}

thread_local! {
    static NEXT_FAKE: RefCell<Option<Fake>> = const { RefCell::new(None) };
}

fn make_fake(_: Arc<Mutex<u64>>) -> Result<Fake, Unsupported> {
    Ok(NEXT_FAKE.with(|next| next.borrow_mut().take().expect("configured driver")))
}

impl Drop for Fake {
    fn drop(&mut self) {
        if let Some(sender) = &self.stopped {
            sender.send(()).expect("drop acknowledgement");
        }
    }
}

fn empty() -> Sample {
    Sample {
        windows: vec![],
        private: false,
        walk: Walk {
            nodes: vec![],
            focused: None,
            complete: true,
        },
    }
}

impl Driver for Fake {
    type Element = Element;
    fn now(&self) -> Instant {
        self.now.get()
    }
    fn granted(&self) -> bool {
        self.now() >= self.granted_at
    }
    fn open(&mut self, _: u32, _: u32, _: Instant) -> Result<Element, Unsupported> {
        self.open_error.map_or(Ok(element(0)), Err)
    }
    fn same(&self, left: &Element, right: &Element) -> bool {
        left.id == right.id
    }
    fn window(&self, element: &Element, _: Instant) -> Option<u32> {
        self.resolved
            .borrow()
            .get(&element.id)
            .copied()
            .or(element.window)
    }
    fn children(&self, element: &Element, _: Instant) -> Result<Vec<Element>, Unsupported> {
        Ok(self
            .tree
            .borrow()
            .get(&element.id)
            .cloned()
            .unwrap_or_default())
    }
    fn register(&self, element: &Element, _: Instant) -> Result<Registration, Unsupported> {
        self.registered.borrow_mut().push(element.id);
        let mut registration = Registration::default();
        for kind in [Kind::Changed, Kind::Structure, Kind::Destroyed] {
            registration.record(kind, self.fail != Some(element.id));
        }
        Ok(registration)
    }
    fn pump(&mut self, until: Instant) -> Vec<Event<Element>> {
        self.now.set(self.now().max(until));
        std::mem::take(&mut *self.events.borrow_mut())
    }
    fn sample(
        &self,
        _: &dyn Observer,
        _: u32,
        _: u32,
        _: Instant,
    ) -> Result<Sample, observe::Refusal> {
        if self.sample_event {
            self.events.borrow_mut().push(Event {
                at: self.now(),
                element: element(0),
                kind: Kind::Destroyed,
            });
        }
        Ok(empty())
    }
}

struct Source {
    windows: Vec<WindowIdentity>,
    fault: Option<Fault>,
    focus_fault: Option<Fault>,
    budget: Mutex<Option<Duration>>,
}

impl Observer for Source {
    fn focused(
        &self,
        _: &WindowIdentity,
    ) -> Result<Option<crate::screen::private::Focused>, Fault> {
        if let Some(fault) = &self.focus_fault {
            return Err(fault.clone());
        }
        Ok(Some(crate::screen::private::Focused {
            role: "AXButton".into(),
            secure: false,
        }))
    }
    fn windows(&self) -> Result<Vec<WindowIdentity>, Fault> {
        self.fault
            .clone()
            .map_or_else(|| Ok(self.windows.clone()), Err)
    }
    fn walk(&self, _: &WindowIdentity, bounds: &Bounds) -> Result<Walk, Fault> {
        *self.budget.lock().expect("budget") = Some(bounds.budget);
        Ok(empty().walk)
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

fn source() -> Arc<dyn Observer> {
    Arc::new(Source {
        windows: vec![],
        fault: None,
        focus_fault: None,
        budget: Mutex::new(None),
    })
}

#[test]
fn grant_regain_and_expiry_use_the_same_clock_and_absolute_budget() {
    let start = Instant::now();
    let mut driver = fake(start);
    driver.granted_at = start + Duration::from_millis(150);
    assert_eq!(
        grant(&mut driver, start, start + Duration::from_secs(5)),
        Ok(())
    );
    assert_eq!(driver.now(), start + Duration::from_millis(200));
    for timeout in [Duration::from_millis(50), Duration::from_secs(5)] {
        let mut driver = fake(start);
        driver.granted_at = start + Duration::from_secs(10);
        assert_eq!(
            grant(&mut driver, start, start + timeout),
            Err(Unsupported::AccessibilityNotGranted)
        );
        assert_eq!(driver.now(), start + timeout.min(Duration::from_secs(2)));
    }
}

#[test]
fn reconciliation_registers_inserted_descendants_before_their_value_changes() {
    let start = Instant::now();
    let end = start + Duration::from_secs(5);
    let driver = fake(start);
    let mut coverage = Coverage::new(element(0));
    coverage.reconcile(&driver, end).expect("initial root");
    driver.tree.borrow_mut().insert(0, vec![element(1)]);
    let changes = coverage.events(
        &driver,
        vec![Event {
            at: start,
            element: element(0),
            kind: Kind::Structure,
        }],
        7,
        end,
    );
    assert_eq!(
        changes,
        vec![
            (start, Notification::Changed),
            (start, Notification::Resolved)
        ]
    );
    assert_eq!(*driver.registered.borrow(), vec![0, 1]);
    let mut child = element(1);
    child.window = None;
    assert_eq!(
        coverage.events(
            &driver,
            vec![Event {
                at: start,
                element: child,
                kind: Kind::Changed
            }],
            7,
            end
        ),
        vec![(start, Notification::Changed)]
    );
    driver.tree.borrow_mut().insert(1, vec![element(0)]);
    coverage
        .reconcile(&driver, end)
        .expect("cycles and duplicates are visited once");
    assert_eq!(*driver.registered.borrow(), vec![0, 1]);
}

#[test]
fn incomplete_or_expired_or_unregistered_coverage_is_never_ready() {
    let start = Instant::now();
    let end = start + Duration::from_secs(1);
    let mut driver = fake(start);
    driver.fail = Some(0);
    assert_eq!(
        Coverage::new(element(0)).reconcile(&driver, end),
        Err(Unsupported::NoObserver)
    );
    driver.fail = None;
    assert_eq!(
        Coverage::new(element(0)).reconcile(&driver, start),
        Err(Unsupported::NoObserver)
    );
    driver
        .tree
        .borrow_mut()
        .insert(0, (1..=5000).map(element).collect());
    assert_eq!(
        Coverage::new(element(0)).reconcile(&driver, end),
        Err(Unsupported::NoObserver)
    );
}

#[test]
fn root_identity_not_proxy_address_classifies_destruction() {
    let start = Instant::now();
    let driver = fake(start);
    let mut coverage = Coverage::new(element(0));
    coverage
        .reconcile(&driver, start + Duration::from_secs(1))
        .expect("root");
    let root_proxy = Element {
        proxy: 99,
        ..element(0)
    };
    assert_ne!(root_proxy.proxy, coverage.root.proxy);
    assert_eq!(
        coverage.events(
            &driver,
            vec![Event {
                at: start,
                element: root_proxy,
                kind: Kind::Destroyed
            }],
            7,
            start
        ),
        vec![(start, Notification::Destroyed)]
    );
}

#[test]
fn unrelated_windows_are_ignored_and_unresolved_attribution_blocks() {
    let start = Instant::now();
    let end = start + Duration::from_secs(1);
    let driver = fake(start);
    let mut coverage = Coverage::new(element(0));
    coverage.reconcile(&driver, end).expect("root");
    let foreign = Element {
        window: Some(8),
        ..element(1)
    };
    assert!(coverage
        .events(
            &driver,
            vec![Event {
                at: start,
                element: foreign,
                kind: Kind::Structure
            }],
            7,
            end
        )
        .is_empty());
    let unresolved = Element {
        window: None,
        ..element(1)
    };
    assert_eq!(
        coverage.events(
            &driver,
            vec![Event {
                at: start,
                element: unresolved.clone(),
                kind: Kind::Changed
            }],
            7,
            end
        ),
        vec![(start, Notification::Unresolved)]
    );
    driver.tree.borrow_mut().insert(0, vec![unresolved]);
    assert_eq!(
        coverage.events(
            &driver,
            vec![Event {
                at: start,
                element: element(0),
                kind: Kind::Structure
            }],
            7,
            end
        ),
        vec![
            (start, Notification::Changed),
            (start, Notification::Changed),
            (start, Notification::Resolved)
        ]
    );
}

#[test]
fn unresolved_event_resolving_to_another_window_is_discarded() {
    let start = Instant::now();
    let end = start + Duration::from_secs(1);
    let driver = fake(start);
    let mut coverage = Coverage::new(element(0));
    coverage.reconcile(&driver, end).expect("root");
    let pending = Element {
        window: None,
        ..element(1)
    };
    assert_eq!(
        coverage.events(
            &driver,
            vec![Event {
                at: start,
                element: pending,
                kind: Kind::Changed
            }],
            7,
            end
        ),
        vec![(start, Notification::Unresolved)]
    );

    driver.resolved.borrow_mut().insert(1, 8);
    assert_eq!(
        coverage.events(
            &driver,
            vec![Event {
                at: start,
                element: element(0),
                kind: Kind::Structure
            }],
            7,
            end
        ),
        vec![
            (start, Notification::Changed),
            (start, Notification::Resolved)
        ]
    );
}

#[test]
fn child_destruction_is_change_and_failed_reconciliation_loses_coverage() {
    let start = Instant::now();
    let end = start + Duration::from_secs(1);
    let mut driver = fake(start);
    let mut coverage = Coverage::new(element(0));
    coverage.reconcile(&driver, end).expect("root");
    assert_eq!(
        coverage.events(
            &driver,
            vec![Event {
                at: start,
                element: element(1),
                kind: Kind::Destroyed
            }],
            7,
            end
        ),
        vec![
            (start, Notification::Changed),
            (start, Notification::Resolved)
        ]
    );
    driver.fail = Some(2);
    driver.tree.borrow_mut().insert(0, vec![element(2)]);
    assert_eq!(
        coverage.events(
            &driver,
            vec![Event {
                at: start,
                element: element(0),
                kind: Kind::Structure
            }],
            7,
            end
        ),
        vec![(start, Notification::Changed), (start, Notification::Lost)]
    );
}

#[test]
fn sample_requires_an_in_budget_target_and_propagates_faults() {
    let now = Instant::now();
    assert!(matches!(
        sample(source().as_ref(), 42, 7, now, || now),
        Err(observe::Refusal::NotAvailable)
    ));
    assert!(matches!(
        sample(
            source().as_ref(),
            42,
            7,
            now + Duration::from_secs(1),
            || now
        ),
        Err(observe::Refusal::WindowNotFound)
    ));
    let failing = Source {
        windows: vec![],
        fault: Some(Fault::Permission),
        focus_fault: None,
        budget: Mutex::new(None),
    };
    assert!(matches!(
        sample(&failing, 42, 7, now + Duration::from_secs(1), || now),
        Err(observe::Refusal::Permission)
    ));
}

#[test]
fn sample_refuses_an_unreadable_focus_before_walking() {
    let now = Instant::now();
    let observer = Source {
        windows: vec![WindowIdentity {
            pid: 42,
            window_id: 7,
            owner_pid: 42,
            title: "Editor".into(),
            app: crate::screen::ax::AppIdentity {
                bundle_id: None,
                path: "/fixture/editor".into(),
            },
            token: 0,
            origin: (0, 0),
            minimized: false,
        }],
        fault: None,
        focus_fault: Some(Fault::Permission),
        budget: Mutex::new(None),
    };
    assert!(matches!(
        sample(&observer, 42, 7, now + Duration::from_secs(1), || now),
        Err(observe::Refusal::AccessibilityUnavailable)
    ));
    assert_eq!(*observer.budget.lock().expect("walk budget"), None);
}

#[test]
fn worker_fences_destruction_before_returning_a_sample_and_stops() {
    let start = Instant::now();
    let end = start + Duration::from_secs(1);
    let (events_tx, events) = mpsc::channel();
    let (ready_tx, ready) = mpsc::channel();
    let (commands, requests) = mpsc::channel();
    let (reply, sample) = mpsc::channel();
    commands
        .send(Command::Sample(end, reply))
        .expect("sample command");
    commands.send(Command::Stop).expect("stop command");
    let mut driver = fake(start);
    driver.sample_event = true;
    NEXT_FAKE.with(|next| *next.borrow_mut() = Some(driver));
    serve(
        make_fake,
        Watch {
            pid: 42,
            window: 7,
            started: start,
            end,
            finish: end,
            observer: source(),
            events: events_tx,
            ready: ready_tx,
            requests,
            revision: Arc::new(Mutex::new(0)),
        },
    );
    assert_eq!(ready.recv().expect("ready"), Ok(()));
    assert!(sample.recv().expect("sample").is_ok());
    assert_eq!(
        events.recv().expect("fenced event").1,
        Notification::Destroyed
    );
}

#[test]
fn worker_setup_errors_and_abandoned_receivers_terminate() {
    let start = Instant::now();
    let end = start + Duration::from_secs(1);
    let mut denied = fake(start);
    denied.granted_at = end + Duration::from_secs(1);
    let mut missing = fake(start);
    missing.open_error = Some(Unsupported::WindowNotFound);
    let mut unregistered = fake(start);
    unregistered.fail = Some(0);
    for (driver, error) in [
        (denied, Unsupported::AccessibilityNotGranted),
        (missing, Unsupported::WindowNotFound),
        (unregistered, Unsupported::NoObserver),
    ] {
        let (events_tx, _) = mpsc::channel();
        let (ready_tx, ready) = mpsc::channel();
        let (_, requests) = mpsc::channel();
        NEXT_FAKE.with(|next| *next.borrow_mut() = Some(driver));
        serve(
            make_fake,
            Watch {
                pid: 42,
                window: 7,
                started: start,
                end,
                finish: end,
                observer: source(),
                events: events_tx,
                ready: ready_tx,
                requests,
                revision: Arc::new(Mutex::new(0)),
            },
        );
        assert_eq!(ready.recv().expect("refusal"), Err(error));
    }
    for abandon_ready in [false, true] {
        let (events_tx, _) = mpsc::channel();
        let (ready_tx, ready) = mpsc::channel();
        let (commands, requests) = mpsc::channel();
        if abandon_ready {
            drop(ready);
        } else {
            drop(commands);
        }
        NEXT_FAKE.with(|next| *next.borrow_mut() = Some(fake(start)));
        serve(
            make_fake,
            Watch {
                pid: 42,
                window: 7,
                started: start,
                end,
                finish: end,
                observer: source(),
                events: events_tx,
                ready: ready_tx,
                requests,
                revision: Arc::new(Mutex::new(0)),
            },
        );
    }
}

#[test]
fn worker_deadline_bounds_idle_lifetime() {
    let start = Instant::now();
    let end = start + Duration::from_millis(20);
    let (events_tx, _) = mpsc::channel();
    let (ready_tx, ready) = mpsc::channel();
    let (_commands, requests) = mpsc::channel();
    NEXT_FAKE.with(|next| *next.borrow_mut() = Some(fake(start)));
    serve(
        make_fake,
        Watch {
            pid: 42,
            window: 7,
            started: start,
            end,
            finish: end,
            observer: source(),
            events: events_tx,
            ready: ready_tx,
            requests,
            revision: Arc::new(Mutex::new(0)),
        },
    );
    assert_eq!(ready.recv().expect("ready"), Ok(()));
}

#[test]
fn threaded_subscription_and_channel_failures_are_typed_and_bounded() {
    let start = Instant::now();
    let end = start + Duration::from_secs(30);
    assert!(matches!(
        subscribe(
            |_| Err::<Fake, _>(Unsupported::NoObserver),
            42,
            7,
            start,
            end,
            source()
        ),
        Err(Unsupported::NoObserver)
    ));
    let mut subscription =
        subscribe(move |_| Ok(fake(start)), 42, 7, start, end, source()).expect("ready");
    assert!(subscription.now() >= start);
    assert_eq!(subscription.receive_until(start), None);
    assert!(matches!(
        subscription.sample(start),
        Err(observe::Refusal::NotAvailable)
    ));
}

#[test]
fn armed_sample_waits_for_its_exact_reply() {
    let (events_tx, events) = mpsc::channel();
    let (commands, requests) = mpsc::channel();
    let (done, finished) = mpsc::channel();
    let end = Instant::now() + Duration::from_secs(30);
    let thread = thread::spawn(move || {
        let Command::Sample(_, reply) = requests.recv().expect("request") else {
            panic!("sample");
        };
        reply.send(Ok((empty(), 7))).ok();
        assert!(matches!(requests.recv().expect("stop"), Command::Stop));
        done.send(()).expect("finished");
    });
    let revision = Arc::new(Mutex::new(7));
    let mut armed = Armed {
        events,
        commands,
        finished,
        finish: end,
        revision: Arc::clone(&revision),
        sampled: 0,
    };
    events_tx
        .send((Instant::now(), Notification::Changed))
        .expect("event");
    assert_eq!(
        armed.receive_until(end).expect("change").1,
        Notification::Changed
    );
    assert!(armed.sample(end).is_ok());
    assert_eq!(
        armed.commit_if_current(Box::new(|| Value::Bool(true))),
        Some(Value::Bool(true))
    );
    *revision.lock().expect("revision") += 1;
    assert_eq!(
        armed.commit_if_current(Box::new(|| panic!("stale sample committed"))),
        None
    );
    drop(armed);
    thread.join().expect("joined");
}

#[test]
fn expired_setup_never_joins_a_stalled_worker_and_releases_after_cancellation() {
    let start = Instant::now() - Duration::from_secs(2);
    let (entered, entering) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let (done, stopped) = mpsc::channel();
    let result = subscribe(
        move |_| {
            entered.send(()).expect("entered setup");
            released.recv().expect("release setup");
            let mut driver = fake(start);
            driver.stopped = Some(done);
            Ok(driver)
        },
        42,
        7,
        start,
        start,
        source(),
    );
    assert!(matches!(result, Err(Unsupported::NoObserver)));
    entering
        .recv_timeout(Duration::from_secs(5))
        .expect("worker entered");
    release.send(()).expect("release stalled setup");
    stopped
        .recv_timeout(Duration::from_secs(5))
        .expect("worker released its resources");
}
