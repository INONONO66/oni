use std::{
    sync::{
        mpsc::{self, Receiver, Sender},
        Arc, Mutex, PoisonError,
    },
    thread,
    time::{Duration, Instant},
};

use super::{Notification, Sample, Subscription, Unsupported};
use crate::screen::{
    ax::{Bounds, Observer},
    observe,
};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Changed,
    Structure,
    Destroyed,
}

#[derive(Default)]
pub struct Registration {
    change: bool,
    structure: bool,
    destroyed: bool,
}

impl Registration {
    pub fn record(&mut self, kind: Kind, accepted: bool) {
        match kind {
            Kind::Changed => self.change |= accepted,
            Kind::Structure => self.structure |= accepted,
            Kind::Destroyed => self.destroyed |= accepted,
        }
    }
}

pub struct Event<E> {
    pub at: Instant,
    pub element: E,
    pub kind: Kind,
}

/// Platform facts only. The shared worker owns retry, coverage,
/// attribution, sample fencing and the absolute lifetime.
pub trait Driver {
    type Element: Clone;
    fn now(&self) -> Instant;
    fn granted(&self) -> bool;
    fn open(
        &mut self,
        pid: u32,
        window: u32,
        deadline: Instant,
    ) -> Result<Self::Element, Unsupported>;
    fn same(&self, left: &Self::Element, right: &Self::Element) -> bool;
    fn window(&self, element: &Self::Element, deadline: Instant) -> Option<u32>;
    fn children(
        &self,
        element: &Self::Element,
        deadline: Instant,
    ) -> Result<Vec<Self::Element>, Unsupported>;
    fn register(
        &self,
        element: &Self::Element,
        deadline: Instant,
    ) -> Result<Registration, Unsupported>;
    fn pump(&mut self, until: Instant) -> Vec<Event<Self::Element>>;
    fn sample(
        &self,
        observer: &dyn Observer,
        pid: u32,
        window: u32,
        deadline: Instant,
    ) -> Result<Sample, observe::Refusal>;
}

pub fn sample(
    observer: &dyn Observer,
    pid: u32,
    window: u32,
    deadline: Instant,
    now: impl Fn() -> Instant,
) -> Result<Sample, observe::Refusal> {
    if now() >= deadline {
        return Err(observe::Refusal::NotAvailable);
    }
    let windows = observer.windows()?;
    let target = windows
        .iter()
        .find(|row| row.pid == pid && row.window_id == window)
        .ok_or(observe::Refusal::WindowNotFound)?;
    let bounds = Bounds {
        max_elements: observe::MAX_ELEMENTS,
        max_visits: observe::MAX_VISITS,
        budget: deadline
            .saturating_duration_since(now())
            .min(observe::BUDGET),
    };
    let walk = observer.walk(target, &bounds)?;
    if now() > deadline {
        return Err(observe::Refusal::NotAvailable);
    }
    Ok(Sample { windows, walk })
}

pub fn grant(driver: &mut impl Driver, started: Instant, end: Instant) -> Result<(), Unsupported> {
    let end = end.min(started + Duration::from_secs(2));
    while !driver.granted() {
        let now = driver.now();
        if now >= end {
            return Err(Unsupported::AccessibilityNotGranted);
        }
        driver.pump((now + Duration::from_millis(100)).min(end));
    }
    Ok(())
}

pub struct Coverage<E> {
    root: E,
    members: Vec<E>,
    held: Vec<E>,
    unresolved: Vec<Event<E>>,
}

impl<E: Clone> Coverage<E> {
    pub fn new(root: E) -> Self {
        Self {
            root,
            members: Vec::new(),
            held: Vec::new(),
            unresolved: Vec::new(),
        }
    }

    pub fn reconcile<D: Driver<Element = E>>(
        &mut self,
        driver: &D,
        end: Instant,
    ) -> Result<(), Unsupported> {
        let mut pending = vec![self.root.clone()];
        let mut members = Vec::new();
        while let Some(element) = pending.pop() {
            if members.iter().any(|old| driver.same(old, &element)) {
                continue;
            }
            if members.len() == observe::MAX_VISITS || driver.now() >= end {
                return Err(Unsupported::NoObserver);
            }
            if !self.held.iter().any(|old| driver.same(old, &element)) {
                let registered = driver.register(&element, end)?;
                let root = driver.same(&element, &self.root);
                if self.held.len() == observe::MAX_VISITS
                    || !registered.change
                    || !registered.destroyed
                    || (root && !registered.structure)
                {
                    return Err(Unsupported::NoObserver);
                }
                self.held.push(element.clone());
            }
            pending.extend(driver.children(&element, end)?);
            members.push(element);
        }
        self.members = members;
        Ok(())
    }

    fn classify<D: Driver<Element = E>>(
        &self,
        driver: &D,
        event: &Event<E>,
        window: u32,
        end: Instant,
    ) -> Option<Notification> {
        if driver.same(&event.element, &self.root) {
            return Some(if event.kind == Kind::Destroyed {
                Notification::Destroyed
            } else {
                Notification::Changed
            });
        }
        if self
            .members
            .iter()
            .any(|element| driver.same(element, &event.element))
        {
            return Some(Notification::Changed);
        }
        match driver.window(&event.element, end) {
            Some(id) if id == window => Some(Notification::Changed),
            Some(_) => None,
            None => Some(Notification::Unresolved),
        }
    }

    pub fn events<D: Driver<Element = E>>(
        &mut self,
        driver: &D,
        events: Vec<Event<E>>,
        window: u32,
        end: Instant,
    ) -> Vec<(Instant, Notification)> {
        let mut notifications = Vec::new();
        let mut refresh = false;
        for event in events {
            if let Some(kind) = self.classify(driver, &event, window, end) {
                notifications.push((event.at, kind));
                refresh |= event.kind != Kind::Changed || kind == Notification::Unresolved;
                if kind == Notification::Unresolved {
                    self.unresolved.push(event);
                }
                if kind == Notification::Destroyed {
                    return notifications;
                }
            }
        }
        if refresh {
            if self.reconcile(driver, end).is_err() {
                notifications.push((driver.now(), Notification::Lost));
                return notifications;
            }
            let pending = std::mem::take(&mut self.unresolved);
            for event in pending {
                match self.classify(driver, &event, window, end) {
                    Some(Notification::Unresolved) => self.unresolved.push(event),
                    Some(kind) => notifications.push((driver.now(), kind)),
                    None => {}
                }
            }
            if self.unresolved.is_empty() {
                notifications.push((driver.now(), Notification::Resolved));
            }
        }
        notifications
    }
}

type SampleReply = Result<(Sample, u64), observe::Refusal>;

enum Command {
    Sample(Instant, Sender<SampleReply>),
    Stop,
}

struct Armed {
    events: Receiver<(Instant, Notification)>,
    commands: Sender<Command>,
    finished: Receiver<()>,
    finish: Instant,
    revision: Arc<Mutex<u64>>,
    sampled: u64,
}

impl Drop for Armed {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
        let _ = self
            .finished
            .recv_timeout(self.finish.saturating_duration_since(Instant::now()));
    }
}

impl Subscription for Armed {
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn receive_until(&mut self, deadline: Instant) -> Option<(Instant, Notification)> {
        self.events
            .recv_timeout(deadline.saturating_duration_since(self.now()))
            .ok()
    }
    fn sample(&mut self, deadline: Instant) -> Result<Sample, observe::Refusal> {
        let (sender, receiver) = mpsc::channel();
        self.commands
            .send(Command::Sample(deadline, sender))
            .map_err(|_| observe::Refusal::NotAvailable)?;
        let (sample, revision) = receiver
            .recv_timeout(deadline.saturating_duration_since(self.now()))
            .map_err(|_| observe::Refusal::NotAvailable)??;
        self.sampled = revision;
        Ok(sample)
    }
    fn commit_if_current(&mut self, commit: Box<dyn FnOnce() -> Value + '_>) -> Option<Value> {
        let revision = self.revision.lock().unwrap_or_else(PoisonError::into_inner);
        (*revision == self.sampled).then(commit)
    }
}

pub fn subscribe<D: Driver + 'static>(
    make: impl FnOnce(Arc<Mutex<u64>>) -> Result<D, Unsupported> + Send + 'static,
    pid: u32,
    window: u32,
    started: Instant,
    end: Instant,
    observer: Arc<dyn Observer>,
) -> Result<Box<dyn Subscription>, Unsupported> {
    let (events_tx, events) = mpsc::channel();
    let (ready_tx, ready) = mpsc::channel();
    let (commands, requests) = mpsc::channel();
    let (done, finished) = mpsc::channel();
    let finish = end + Duration::from_millis(500);
    let revision = Arc::new(Mutex::new(0));
    let worker_revision = Arc::clone(&revision);
    thread::spawn(move || {
        serve(
            make,
            Watch {
                pid,
                window,
                started,
                end,
                finish,
                observer,
                events: events_tx,
                ready: ready_tx,
                requests,
                revision: worker_revision,
            },
        );
        let _ = done.send(());
    });
    let armed = Armed {
        events,
        commands,
        finished,
        finish,
        revision,
        sampled: 0,
    };
    ready
        .recv_timeout(finish.saturating_duration_since(Instant::now()))
        .map_err(|_| Unsupported::NoObserver)??;
    Ok(Box::new(armed))
}

struct Watch {
    pid: u32,
    window: u32,
    started: Instant,
    end: Instant,
    finish: Instant,
    observer: Arc<dyn Observer>,
    events: Sender<(Instant, Notification)>,
    ready: Sender<Result<(), Unsupported>>,
    requests: Receiver<Command>,
    revision: Arc<Mutex<u64>>,
}

fn serve<D: Driver>(make: impl FnOnce(Arc<Mutex<u64>>) -> Result<D, Unsupported>, watch: Watch) {
    let armed = make(Arc::clone(&watch.revision)).and_then(|mut driver| {
        grant(&mut driver, watch.started, watch.end)?;
        let root = driver.open(watch.pid, watch.window, watch.end)?;
        let mut coverage = Coverage::new(root);
        coverage.reconcile(&driver, watch.end)?;
        Ok((driver, coverage))
    });
    let (mut driver, mut coverage) = match armed {
        Ok(armed) => armed,
        Err(error) => {
            let _ = watch.ready.send(Err(error));
            return;
        }
    };
    if watch.ready.send(Ok(())).is_err() {
        return;
    }
    while driver.now() < watch.finish {
        let until = (driver.now() + Duration::from_millis(10)).min(watch.finish);
        deliver(&mut driver, &mut coverage, &watch, until);
        match watch.requests.try_recv() {
            Ok(Command::Stop) | Err(mpsc::TryRecvError::Disconnected) => return,
            Ok(Command::Sample(deadline, reply)) => {
                let sample =
                    driver.sample(watch.observer.as_ref(), watch.pid, watch.window, deadline);
                let fence = driver.now();
                deliver(&mut driver, &mut coverage, &watch, fence);
                let revision = *watch
                    .revision
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                let _ = reply.send(sample.map(|sample| (sample, revision)));
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
    }
}

fn deliver<D: Driver>(
    driver: &mut D,
    coverage: &mut Coverage<D::Element>,
    watch: &Watch,
    until: Instant,
) {
    let events = driver.pump(until);
    for event in coverage.events(driver, events, watch.window, watch.finish) {
        *watch
            .revision
            .lock()
            .unwrap_or_else(PoisonError::into_inner) += 1;
        let _ = watch.events.send(event);
    }
}

#[cfg(test)]
mod tests;
