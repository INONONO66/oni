//! Window-bound observation (#1689). [`Observations`] holds, per attachment,
//! the epoch table (a window's recreations as this peer has seen them), the
//! observation id counter and the latest snapshot of each lineage
//! `w<pid>-<windowId>-<epoch>`. The id counter outlives [`Observations::forget`],
//! so a detach never reissues an id. A complete walk is minted into
//! elements whose ref is the element's `role[i]` path; an incomplete walk
//! cannot prove a ref unambiguous and mints none. A `since` naming the
//! lineage's latest observation answers a diff by ref, or every element
//! again when either side holds an element without a ref; anything else is
//! stale. An action re-checks the lineage, resolves its ref by path
//! and requires the same unclipped role, label, secure flag and identifier, and
//! the observer dispatches only on the element it resolved and admitted
//! against that identity; a pointer aimed at a ref passes the same fresh
//! check and lands on the element's centre in global points. Operations on
//! one window run one at a time; different windows do not wait on each
//! other.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_protocol::ScreenObserveRequest;
use serde::Serialize;
use serde_json::{json, Value};

use super::ax::{
    self, ActFault, Action, Attributes, Bounds, Frame, Hit, Node, Observer, Segment, Walk,
    WindowIdentity,
};
use super::encode::{Encoding, Format};
use super::private::focus_is_secure;
use super::settle::{Notification, Subscription};
use super::{Display, Fault, Screen, MAX_DIMENSION};

pub const MAX_ELEMENTS: usize = 2000;
pub const MAX_VISITS: usize = 5000;
pub const BUDGET: Duration = Duration::from_millis(2500);
pub const MAX_BYTES: usize = 262_144;
const MAX_VALUE: usize = 4096;
const MAX_LABEL: usize = 1024;
const MAX_ACTIONS: usize = 16;
const MAX_ACTION_NAME: usize = 64;
const MAX_ROLE: usize = 128;
const MAX_REF: usize = 256;
const MAX_MESSAGE: usize = 256;
const MAX_TITLE: usize = 256;
const COORDINATE: i64 = 16_384;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Element {
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub actions: Vec<String>,
    pub frame: Frame,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub secure: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    NotAvailable,
    Permission,
    WindowNotFound,
    EpochChanged,
    Stale,
    RefNotFound,
    Unsupported,
    OffScreen,
    NotActionable(&'static str),
    Private,
    Failed(String),
}

impl From<Fault> for Refusal {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Absent => Self::NotAvailable,
            Fault::Permission => Self::Permission,
            Fault::WindowNotFound => Self::WindowNotFound,
            Fault::Failed(message) => Self::Failed(message),
            other => Self::Failed(other.reason().to_owned()),
        }
    }
}

impl From<ActFault> for Refusal {
    fn from(fault: ActFault) -> Self {
        match fault {
            ActFault::NotFound => Self::RefNotFound,
            ActFault::Unsupported => Self::Unsupported,
            ActFault::Permission => Self::Permission,
            ActFault::Failed(message) => Self::Failed(message),
        }
    }
}

impl Refusal {
    /// The `ScreenObserveResult` refusal; ref and action refusals cannot
    /// arise while observing and answer `observe_failed`.
    pub fn observed(&self) -> Value {
        let reason = match self {
            Self::NotAvailable => "observe_not_available",
            Self::Permission => "permission_denied",
            Self::WindowNotFound => "window_not_found",
            Self::EpochChanged => "epoch_changed",
            Self::Stale => "stale_observation",
            Self::Private => "observe_failed",
            Self::RefNotFound
            | Self::Unsupported
            | Self::OffScreen
            | Self::NotActionable(_)
            | Self::Failed(_) => "observe_failed",
        };
        self.render(reason)
    }

    /// The `InputWriteResult` refusal of a ref-targeted action.
    pub fn acted(&self) -> Value {
        self.render(self.reason())
    }

    /// The `InputWriteResult` reason of a ref-targeted action or pointer.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::NotAvailable => "input_not_available",
            Self::Permission => "permission_denied",
            Self::WindowNotFound => "window_not_found",
            Self::EpochChanged => "epoch_changed",
            Self::Stale => "stale_observation",
            Self::RefNotFound => "ref_not_found",
            Self::Unsupported => "action_not_supported",
            Self::OffScreen => "invalid_region",
            Self::NotActionable(_) => "not_actionable",
            Self::Private => "private",
            Self::Failed(_) => "input_failed",
        }
    }

    /// The refusal's message, clipped to the wire bound, when it has one.
    pub fn message(&self) -> Option<String> {
        match self {
            Self::Failed(message) if !message.is_empty() => Some(clip(message, MAX_MESSAGE)),
            Self::NotActionable(blocker) => Some(format!("{blocker}: element is not actionable")),
            _ => None,
        }
    }

    fn render(&self, reason: &str) -> Value {
        match self.message() {
            Some(message) => json!({"status": "refused", "reason": reason, "message": message}),
            None => json!({"status": "refused", "reason": reason}),
        }
    }
}

/// A window as the wire names it; `epoch` is required on every action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub pid: u64,
    pub window_id: u64,
    pub epoch: Option<u64>,
}

pub struct Request {
    pub target: Target,
    pub since: Option<String>,
    pub max_elements: usize,
}

pub struct Act {
    pub target: Target,
    pub observation: String,
    pub reference: String,
    pub action: Action,
    pub wait_ms: u64,
}

/// The first reason a resolved action cannot reach its target. A missing
/// enabled flag is not evidence of a disabled custom view.
fn blocker(
    attributes: &Attributes,
    size: (i64, i64),
    action: &Action,
    hit: Option<Hit>,
) -> Option<&'static str> {
    if attributes.enabled == Some(false) {
        return Some("disabled");
    }
    if matches!(action, Action::SetValue(_)) {
        return None;
    }
    let frame = attributes.frame;
    if frame.width <= 0 || frame.height <= 0 {
        return Some("zero_size");
    }
    let center = (frame.x + frame.width / 2, frame.y + frame.height / 2);
    if center.0 < 0 || center.1 < 0 || center.0 >= size.0 || center.1 >= size.1 {
        return Some("off_window");
    }
    match hit {
        Some(Hit::Occluded) => Some("occluded"),
        Some(Hit::Covered) => Some("covered"),
        Some(Hit::Target) | None => None,
    }
}

struct Seen {
    epoch: u64,
    owner_pid: u32,
    token: u64,
    present: bool,
}

/// Recreations per `(pid, window_id)`: a window bumps its epoch when its
/// owner or recreation token changes, or when it reappears after an update
/// that did not list it.
#[derive(Default)]
struct EpochTable(HashMap<(u32, u32), Seen>);

impl EpochTable {
    fn update(&mut self, windows: &[WindowIdentity]) {
        let mut current: HashMap<(u32, u32), &WindowIdentity> = windows
            .iter()
            .map(|window| ((window.pid, window.window_id), window))
            .collect();
        for (key, seen) in &mut self.0 {
            let Some(window) = current.remove(key) else {
                seen.present = false;
                continue;
            };
            if !seen.present || seen.owner_pid != window.owner_pid || seen.token != window.token {
                seen.epoch += 1;
            }
            (seen.owner_pid, seen.token, seen.present) = (window.owner_pid, window.token, true);
        }
        for (key, window) in current {
            let seen = Seen {
                epoch: 0,
                owner_pid: window.owner_pid,
                token: window.token,
                present: true,
            };
            self.0.insert(key, seen);
        }
    }

    fn epoch(&self, key: (u32, u32)) -> u64 {
        self.0.get(&key).map_or(0, |seen| seen.epoch)
    }
}

/// An element's unclipped identity: what a fresh walk must find again.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Key {
    role: String,
    label: Option<String>,
    secure: bool,
    identifier: Option<String>,
}

impl Key {
    fn of(attributes: &Attributes) -> Self {
        Self {
            role: attributes.role.clone(),
            label: attributes.label.clone(),
            secure: attributes.secure,
            identifier: attributes.identifier.clone(),
        }
    }
}

struct Snapshot {
    id: String,
    target: Target,
    private: bool,
    elements: Vec<Element>,
    keys: HashMap<String, Key>,
}

impl Snapshot {
    fn element(&self, reference: &str) -> Result<(Element, Key), Refusal> {
        let element = self
            .elements
            .iter()
            .find(|element| element.reference.as_deref() == Some(reference));
        let key = self.keys.get(reference);
        element
            .cloned()
            .zip(key.cloned())
            .ok_or(Refusal::RefNotFound)
    }
}

struct Located {
    window: WindowIdentity,
    epoch: u64,
    lineage: String,
}

/// A walked observation not yet given an id: an observe that fails after
/// the walk (its screenshot) leaves the lineage's latest observation intact.
pub struct Prepared {
    located: Located,
    since: Option<(String, Vec<Element>)>,
    minted: Minted,
    private: bool,
}

impl Prepared {
    fn new(
        located: Located,
        since: Option<(String, Vec<Element>)>,
        walk: Walk,
        private: bool,
    ) -> Self {
        Self {
            located,
            since,
            minted: mint(walk),
            private,
        }
    }
}

#[derive(Default)]
struct State {
    epochs: EpochTable,
    snapshots: HashMap<String, Snapshot>,
}

impl State {
    fn latest(&self, lineage: &str, id: &str) -> Result<&Snapshot, Refusal> {
        self.snapshots
            .get(lineage)
            .filter(|snapshot| snapshot.id == id)
            .ok_or(Refusal::Stale)
    }
}

/// One operation lock per `(pid, windowId)`.
type WindowLocks = HashMap<(u32, u32), Arc<Mutex<()>>>;

#[derive(Default)]
pub struct Observations {
    ids: AtomicU64,
    state: Mutex<State>,
    windows: Mutex<WindowLocks>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Observations {
    /// Drops every snapshot and epoch; the id counter keeps counting.
    pub fn forget(&self) {
        *lock(&self.state) = State::default();
    }

    fn locate(&self, observer: &dyn Observer, target: Target) -> Result<Located, Refusal> {
        let windows = observer.windows()?;
        self.locate_windows(windows, target)
    }

    fn locate_windows(
        &self,
        windows: Vec<WindowIdentity>,
        target: Target,
    ) -> Result<Located, Refusal> {
        let mut state = lock(&self.state);
        state.epochs.update(&windows);
        let window = windows
            .into_iter()
            .find(|window| {
                (u64::from(window.pid), u64::from(window.window_id))
                    == (target.pid, target.window_id)
            })
            .ok_or(Refusal::WindowNotFound)?;
        let key = (window.pid, window.window_id);
        let epoch = state.epochs.epoch(key);
        if target.epoch.is_some_and(|named| named != epoch) {
            return Err(Refusal::EpochChanged);
        }
        let lineage = format!("w{}-{}-{epoch}", key.0, key.1);
        Ok(Located {
            window,
            epoch,
            lineage,
        })
    }

    /// The operation lock of `located`'s window.
    fn window(&self, located: &Located) -> Arc<Mutex<()>> {
        let key = (located.window.pid, located.window.window_id);
        Arc::clone(lock(&self.windows).entry(key).or_default())
    }

    pub fn target_for(
        &self,
        observer: &dyn Observer,
        window: &WindowIdentity,
    ) -> Result<Target, Refusal> {
        let located = self.locate(
            observer,
            Target {
                pid: window.pid.into(),
                window_id: window.window_id.into(),
                epoch: None,
            },
        )?;
        Ok(Target {
            pid: located.window.pid.into(),
            window_id: located.window.window_id.into(),
            epoch: Some(located.epoch),
        })
    }

    /// Observes `request`'s window; `shot` (given the window id) adds a
    /// screenshot or fails the observation before it is named.
    pub fn observe(
        &self,
        observer: &dyn Observer,
        request: &Request,
        shot: impl FnOnce(u32) -> Result<Option<Value>, Refusal>,
    ) -> Result<Value, Refusal> {
        let located = self.locate(observer, request.target)?;
        let window = self.window(&located);
        let _serial = lock(&window);
        let prepared = self.prepare(observer, request, located)?;
        let screenshot = if prepared.private {
            None
        } else {
            shot(prepared.located.window.window_id)?
        };
        Ok(self.commit(prepared, screenshot))
    }

    fn prepare(
        &self,
        observer: &dyn Observer,
        request: &Request,
        located: Located,
    ) -> Result<Prepared, Refusal> {
        if focus_is_secure(observer.focused(&located.window)) {
            return Ok(Prepared::new(
                located,
                None,
                Walk {
                    nodes: Vec::new(),
                    focused: None,
                    complete: true,
                },
                true,
            ));
        }
        let since = match &request.since {
            Some(id) => {
                let state = lock(&self.state);
                let before = state.latest(&located.lineage, id)?.elements.clone();
                Some((id.clone(), before))
            }
            None => None,
        };
        let bounds = Bounds {
            max_elements: request.max_elements,
            max_visits: MAX_VISITS,
            budget: BUDGET,
        };
        let walk = observer.walk(&located.window, &bounds)?;
        Ok(Prepared::new(located, since, walk, false))
    }

    /// Settle samples outside the store lock, then fences the sampled
    /// identity through the same epoch owner as ordinary observations.
    pub fn prepare_sample(
        &self,
        target: Target,
        windows: Vec<WindowIdentity>,
        walk: Walk,
        private: bool,
    ) -> Result<Prepared, Refusal> {
        let located = self.locate_windows(windows, target)?;
        Ok(Prepared::new(located, None, walk, private))
    }

    pub fn destroy(&self, target: Target) {
        let mut state = lock(&self.state);
        for ((pid, window), seen) in &mut state.epochs.0 {
            if (u64::from(*pid), u64::from(*window)) == (target.pid, target.window_id) {
                seen.present = false;
            }
        }
        state.snapshots.retain(|_, snapshot| {
            (snapshot.target.pid, snapshot.target.window_id) != (target.pid, target.window_id)
        });
    }

    /// Names `prepared` the lineage's latest observation and renders it,
    /// with `screenshot` when one was taken.
    pub fn commit(&self, prepared: Prepared, screenshot: Option<Value>) -> Value {
        let id = format!("o{}", self.ids.fetch_add(1, Ordering::Relaxed) + 1);
        let Located {
            window,
            epoch,
            lineage,
        } = prepared.located;
        let Minted {
            elements,
            keys,
            focused,
            complete,
        } = prepared.minted;
        let mut body = json!({
            "status": "ok", "observationId": id, "lineage": lineage,
            "target": {"pid": window.pid, "windowId": window.window_id, "epoch": epoch},
            "window": {
                "pid": window.pid, "windowId": window.window_id, "epoch": epoch,
                "title": clip(&window.title, MAX_TITLE), "app": window.app,
            },
            "complete": complete, "private": prepared.private,
        });
        if prepared.private {
            lock(&self.state).snapshots.insert(
                lineage,
                Snapshot {
                    id,
                    target: Target {
                        pid: window.pid.into(),
                        window_id: window.window_id.into(),
                        epoch: Some(epoch),
                    },
                    private: true,
                    elements: Vec::new(),
                    keys: HashMap::new(),
                },
            );
            body["elements"] = json!([]);
            return body;
        }
        if let Some(focused) = focused {
            body["focused"] = json!(focused);
        }
        if let Some(screenshot) = screenshot {
            body["screenshot"] = screenshot;
        }
        match prepared.since {
            Some((since, before)) if addressed(&before) && addressed(&elements) => {
                body["diff"] = diff(&since, &before, &elements);
            }
            _ => body["elements"] = json!(elements),
        }
        let keys = elements
            .iter()
            .zip(keys)
            .filter_map(|(element, key)| Some((element.reference.clone()?, key)))
            .collect();
        let snapshot = Snapshot {
            id,
            target: Target {
                pid: window.pid.into(),
                window_id: window.window_id.into(),
                epoch: Some(epoch),
            },
            private: false,
            elements,
            keys,
        };
        lock(&self.state).snapshots.insert(lineage, snapshot);
        body
    }

    /// Checks `act` against the lineage's latest observation, then has the
    /// observer perform it on the element it resolves
    /// and admits by the observed identity; nothing executes on a refusal.
    pub fn act(&self, observer: &dyn Observer, act: &Act) -> Result<(), Refusal> {
        self.act_guarded(observer, act, &|| true)
    }

    pub fn act_guarded(
        &self,
        observer: &dyn Observer,
        act: &Act,
        before_dispatch: &dyn Fn() -> bool,
    ) -> Result<(), Refusal> {
        self.act_waiting(observer, act, before_dispatch, &|_, _| None)
    }

    pub fn act_waiting(
        &self,
        observer: &dyn Observer,
        act: &Act,
        before_dispatch: &dyn Fn() -> bool,
        subscribe: &dyn Fn(Instant, Instant) -> Option<Box<dyn Subscription>>,
    ) -> Result<(), Refusal> {
        let located = self.locate(observer, act.target)?;
        let window = self.window(&located);
        let _serial = lock(&window);
        let snapshots = lock(&self.state);
        let snapshot = snapshots.latest(&located.lineage, &act.observation)?;
        if snapshot.private {
            return Err(Refusal::Private);
        }
        let (observed, key) = snapshot.element(&act.reference)?;
        drop(snapshots);
        if observed.secure || observed.role == "AXSecureTextField" {
            return Err(Refusal::Private);
        }
        let listed = |name: &str| observed.actions.iter().any(|action| action == name);
        let supported = match &act.action {
            Action::Press => listed("AXPress"),
            Action::Perform(name) => listed(name),
            Action::SetValue(_) => true,
        };
        if !supported {
            return Err(Refusal::Unsupported);
        }
        let path = ax::segments(&act.reference).ok_or(Refusal::RefNotFound)?;
        let admit = |attributes: &Attributes| Key::of(attributes) == key;
        let started = Instant::now();
        let end = started + Duration::from_millis(act.wait_ms);
        let mut subscription: Option<Box<dyn Subscription>> = None;
        let path = loop {
            let (attributes, path) = if key.identifier.is_some() {
                let current = observer.resolve(&located.window, &path)?;
                if let Some(attributes) = current.filter(|at| Key::of(at) == key) {
                    (attributes, path.clone())
                } else {
                    let moved = ax::segments(&relocate(observer, &located, &key)?)
                        .ok_or(Refusal::RefNotFound)?;
                    let attributes = observer
                        .resolve(&located.window, &moved)?
                        .filter(|at| Key::of(at) == key)
                        .ok_or(Refusal::RefNotFound)?;
                    (attributes, moved)
                }
            } else {
                (
                    fresh_unidentified(observer, &located, &act.reference, &key)?,
                    path.clone(),
                )
            };
            let size = if matches!(act.action, Action::SetValue(_)) {
                (0, 0)
            } else {
                observer.window_size(&located.window)?
            };
            let first = blocker(&attributes, size, &act.action, None);
            let blocked = match first {
                Some(first) => Some(first),
                None if matches!(act.action, Action::SetValue(_)) => None,
                None => {
                    let frame = attributes.frame;
                    let point = (
                        located.window.origin.0 + frame.x + frame.width / 2,
                        located.window.origin.1 + frame.y + frame.height / 2,
                    );
                    blocker(
                        &attributes,
                        size,
                        &act.action,
                        Some(observer.hit_test(&located.window, &path, point)?),
                    )
                }
            };
            let Some(reason) = blocked else {
                break path;
            };
            if act.wait_ms == 0 || Instant::now() >= end {
                return Err(Refusal::NotActionable(reason));
            }
            if subscription.is_none() {
                subscription = subscribe(started, end);
            }
            let Some(watch) = subscription.as_mut() else {
                return Err(Refusal::NotActionable(reason));
            };
            let tick = (watch.now() + Duration::from_millis(200)).min(end);
            if let Some((_, Notification::Destroyed)) = watch.receive_until(tick) {
                return Err(Refusal::WindowNotFound);
            }
            if watch.now() >= end {
                return Err(Refusal::NotActionable(reason));
            }
            // The settle sampler fences window identity and observes the
            // layout before each quiet-tick recheck.
            let sample = watch.sample(
                (watch.now() + Duration::from_millis(500)).min(end + Duration::from_millis(500)),
            )?;
            if sample.private {
                return Err(Refusal::Private);
            }
            self.locate_windows(sample.windows, act.target)?;
        };
        observer
            .act_guarded(&located.window, &path, &admit, &act.action, before_dispatch)
            .map_err(Into::into)
    }

    /// The global centre of `reference` in `observation`, which must be its
    /// lineage's latest, re-resolved from the window root.
    pub fn point(
        &self,
        observer: &dyn Observer,
        observation: &str,
        reference: &str,
    ) -> Result<(i64, i64), Refusal> {
        let (target, key) = {
            let state = lock(&self.state);
            let snapshot = state
                .snapshots
                .values()
                .find(|snapshot| snapshot.id == observation)
                .ok_or(Refusal::Stale)?;
            (snapshot.target, snapshot.element(reference)?.1)
        };
        let located = self.locate(observer, target)?;
        let window = self.window(&located);
        let _serial = lock(&window);
        if focus_is_secure(observer.focused(&located.window)) {
            return Err(Refusal::Private);
        }
        let frame = fresh(observer, &located, reference, &key)?.frame;
        let (x, y) = located.window.origin;
        Ok((
            x + frame.x + frame.width / 2,
            y + frame.y + frame.height / 2,
        ))
    }
}

fn addressed(elements: &[Element]) -> bool {
    elements.iter().all(|element| element.reference.is_some())
}

/// The element `reference` names from the window root, with the observed
/// identity unchanged. An identified element can move to a different path.
fn fresh(
    observer: &dyn Observer,
    located: &Located,
    reference: &str,
    key: &Key,
) -> Result<Attributes, Refusal> {
    if key.identifier.is_none() {
        return fresh_unidentified(observer, located, reference, key);
    }
    let path = ax::segments(reference).ok_or(Refusal::RefNotFound)?;
    if let Some(attributes) = observer.resolve(&located.window, &path)? {
        if Key::of(&attributes) == *key {
            return Ok(attributes);
        }
    }
    let relocated = relocate(observer, located, key)?;
    let path = ax::segments(&relocated).ok_or(Refusal::RefNotFound)?;
    observer
        .resolve(&located.window, &path)?
        .filter(|attributes| Key::of(attributes) == *key)
        .ok_or(Refusal::RefNotFound)
}

/// An unidentified sibling cannot be distinguished after a reorder without
/// the complete census that established its original ref.
fn fresh_unidentified(
    observer: &dyn Observer,
    located: &Located,
    reference: &str,
    key: &Key,
) -> Result<Attributes, Refusal> {
    let bounds = Bounds {
        max_elements: MAX_ELEMENTS,
        max_visits: MAX_VISITS,
        budget: BUDGET,
    };
    let walk = observer.walk(&located.window, &bounds)?;
    if !walk.complete {
        return Err(Refusal::RefNotFound);
    }
    let attributes: Vec<_> = walk
        .nodes
        .iter()
        .map(|node| node.attributes.clone())
        .collect();
    let minted = mint(walk);
    let element = minted
        .elements
        .iter()
        .zip(&minted.keys)
        .position(|(element, found)| {
            element.reference.as_deref() == Some(reference) && found == key
        });
    if !minted.complete {
        return Err(Refusal::RefNotFound);
    }
    element
        .and_then(|index| attributes.get(index).cloned())
        .ok_or(Refusal::RefNotFound)
}

/// Search only after an identified element's old path stops matching.
fn relocate(observer: &dyn Observer, located: &Located, key: &Key) -> Result<String, Refusal> {
    let bounds = Bounds {
        max_elements: MAX_ELEMENTS,
        max_visits: MAX_VISITS,
        budget: BUDGET,
    };
    let minted = mint(observer.walk(&located.window, &bounds)?);
    if !minted.complete {
        return Err(Refusal::RefNotFound);
    }
    let mut matches = minted
        .elements
        .into_iter()
        .zip(minted.keys)
        .filter(|(_, found)| found.identifier == key.identifier && found.role == key.role)
        .map(|(element, found)| (element.reference, found));
    let found = matches.next().ok_or(Refusal::RefNotFound)?;
    if matches.next().is_some() {
        return Err(Refusal::RefNotFound);
    }
    if found.1 != *key {
        return Err(Refusal::RefNotFound);
    }
    found.0.ok_or(Refusal::RefNotFound)
}

type Identity = (Option<usize>, String, Option<String>, bool, Option<String>);

fn identity(node: &Node) -> Identity {
    let attributes = &node.attributes;
    (
        node.parent,
        ax::slug(&attributes.role),
        attributes.label.clone(),
        attributes.secure,
        attributes.identifier.clone(),
    )
}

struct Minted {
    elements: Vec<Element>,
    keys: Vec<Key>,
    focused: Option<String>,
    complete: bool,
}

/// Mints refs over `walk` in document order, stopping (incomplete) before
/// the element list would exceed [`MAX_BYTES`] serialized. Siblings that
/// share `(role, label, secure, identifier)` cannot be told apart after a reorder, so
/// they and their descendants get no ref; an incomplete walk has not seen
/// every sibling, so none of its elements gets one.
fn mint(walk: Walk) -> Minted {
    let census = walk.complete;
    let mut siblings: HashMap<Identity, usize> = HashMap::new();
    for node in &walk.nodes {
        *siblings.entry(identity(node)).or_default() += 1;
    }
    let mut paths: Vec<String> = Vec::with_capacity(walk.nodes.len());
    let mut ambiguous: Vec<bool> = Vec::with_capacity(walk.nodes.len());
    let mut counts: HashMap<(Option<usize>, String), usize> = HashMap::new();
    let mut elements: Vec<Element> = Vec::with_capacity(walk.nodes.len());
    let mut keys: Vec<Key> = Vec::with_capacity(walk.nodes.len());
    let (mut bytes, mut complete) = (2, walk.complete);
    for node in walk.nodes {
        let hidden = siblings[&identity(&node)] > 1 || node.parent.is_some_and(|at| ambiguous[at]);
        let role = ax::slug(&node.attributes.role);
        let count = counts.entry((node.parent, role.clone())).or_default();
        let segment = Segment {
            role,
            index: *count,
        };
        *count += 1;
        let path = match node.parent {
            Some(parent) => format!("{}/{segment}", paths[parent]),
            None => segment.to_string(),
        };
        let addressable = census && !hidden && !segment.role.is_empty() && path.len() <= MAX_REF;
        let reference = addressable.then(|| path.clone());
        let parent = node
            .parent
            .and_then(|parent| elements[parent].reference.clone());
        let key = Key::of(&node.attributes);
        let element = element(node.attributes, reference, parent);
        let size = serde_json::to_vec(&element).map_or(MAX_BYTES, |json| json.len()) + 1;
        if bytes + size > MAX_BYTES {
            complete = false;
            break;
        }
        bytes += size;
        paths.push(path);
        ambiguous.push(hidden);
        elements.push(element);
        keys.push(key);
    }
    let focused = walk
        .focused
        .and_then(|index| elements.get(index))
        .and_then(|element| element.reference.clone());
    Minted {
        elements,
        keys,
        focused,
        complete,
    }
}

fn element(attributes: Attributes, reference: Option<String>, parent: Option<String>) -> Element {
    let actions = match reference {
        Some(_) => attributes
            .actions
            .into_iter()
            .filter(|name| !name.is_empty() && name.chars().count() <= MAX_ACTION_NAME)
            .take(MAX_ACTIONS)
            .collect(),
        None => Vec::new(),
    };
    let secure = attributes.secure;
    Element {
        reference,
        role: clip(&attributes.role, MAX_ROLE),
        label: attributes.label.map(|label| clip(&label, MAX_LABEL)),
        id: attributes.identifier,
        value: attributes
            .value
            .filter(|_| !secure)
            .map(|value| clip(&value, MAX_VALUE)),
        actions,
        frame: frame(attributes.frame),
        parent,
        secure,
        enabled: attributes.enabled,
        selected: attributes.selected,
        checked: attributes.checked,
        expanded: attributes.expanded,
    }
}

fn frame(frame: Frame) -> Frame {
    Frame {
        x: frame.x.clamp(-COORDINATE, COORDINATE),
        y: frame.y.clamp(-COORDINATE, COORDINATE),
        width: frame.width.clamp(0, COORDINATE),
        height: frame.height.clamp(0, COORDINATE),
    }
}

/// At most `max` UTF-16 code units, the unit the wire's string bounds count.
pub(super) fn clip(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= max
        })
        .collect()
}

/// The elements of a walk by ref; [`Observations::commit`] diffs only walks
/// whose every element has one.
fn by_ref(elements: &[Element]) -> impl Iterator<Item = (&str, &Element)> {
    elements
        .iter()
        .filter_map(|element| Some((element.reference.as_deref()?, element)))
}

/// `added` and `changed` whole, `removed` by ref.
fn diff(since: &str, before: &[Element], after: &[Element]) -> Value {
    let previous: HashMap<&str, &Element> = by_ref(before).collect();
    let (mut added, mut changed) = (Vec::new(), Vec::new());
    let mut present = HashSet::new();
    for (reference, element) in by_ref(after) {
        present.insert(reference);
        match previous.get(reference) {
            None => added.push(element),
            Some(old) if *old != element => changed.push(element),
            Some(_) => {}
        }
    }
    let mut removed: Vec<&str> = previous
        .keys()
        .copied()
        .filter(|reference| !present.contains(reference))
        .collect();
    removed.sort_unstable();
    json!({"since": since, "added": added, "changed": changed, "removed": removed})
}

/// The wire target; the schema keeps `windowId` and `epoch` non-negative.
pub fn target(pid: u64, window_id: i64, epoch: Option<i64>) -> Target {
    Target {
        pid,
        window_id: window_id.unsigned_abs(),
        epoch: epoch.map(i64::unsigned_abs),
    }
}

impl Screen {
    pub fn window_target(&self, target: Target) -> Result<(WindowIdentity, u64), Refusal> {
        let observer = self.observer.as_deref().ok_or(Refusal::NotAvailable)?;
        let located = self.observations.locate(observer, target)?;
        Ok((located.window, located.epoch))
    }

    pub fn windows_for_pid(&self, pid: u32) -> Result<Vec<Value>, Refusal> {
        let observer = self.observer.as_deref().ok_or(Refusal::NotAvailable)?;
        let windows = observer.windows()?;
        let mut observations = lock(&self.observations.state);
        observations.epochs.update(&windows);
        Ok(windows
            .into_iter()
            .filter(|window| window.pid == pid)
            .take(super::MAX_WINDOWS)
            .map(|window| {
                json!({"pid": pid, "windowId": window.window_id,
                "epoch": observations.epochs.epoch((pid, window.window_id))})
            })
            .collect())
    }

    pub fn observe(&self, request: &ScreenObserveRequest) -> Value {
        self.observed(request)
            .unwrap_or_else(|refusal| refusal.observed())
    }

    fn observed(&self, request: &ScreenObserveRequest) -> Result<Value, Refusal> {
        let observer = self.observer.as_deref().ok_or(Refusal::NotAvailable)?;
        let wire = &request.target;
        let parsed = Request {
            target: target(wire.pid.get(), wire.window_id, wire.epoch),
            since: request.since.as_ref().map(|since| since.to_string()),
            max_elements: request.max_elements.map_or(MAX_ELEMENTS, |limit| {
                usize::try_from(limit.get()).map_or(MAX_ELEMENTS, |limit| limit.min(MAX_ELEMENTS))
            }),
        };
        self.observations.observe(observer, &parsed, |window| {
            request
                .screenshot
                .then(|| self.window_shot(window))
                .transpose()
        })
    }

    fn window_shot(&self, window: u32) -> Result<Value, Refusal> {
        let encoding = Encoding {
            format: Format::Png,
            quality: 0,
            max_bytes: super::MAX_BYTES,
            max_dimension: MAX_DIMENSION,
        };
        let render = |shot: super::Shot<'_>| {
            json!({
                "captureId": shot.id, "format": "png", "width": shot.width,
                "height": shot.height, "data": STANDARD.encode(shot.data),
            })
        };
        Ok(self.shoot(
            &super::Target::Window(window.to_string()),
            &encoding,
            render,
        )?)
    }

    pub fn act(&self, act: &Act) -> Result<(), Refusal> {
        self.act_guarded(act, &|| true)
    }

    pub fn act_guarded(
        &self,
        act: &Act,
        before_dispatch: &dyn Fn() -> bool,
    ) -> Result<(), Refusal> {
        let observer = self.observer.as_deref().ok_or(Refusal::NotAvailable)?;
        self.observations
            .act_waiting(observer, act, before_dispatch, &|started, end| {
                let (Some(notifications), Some(observer)) =
                    (self.notifications.as_deref(), self.observer.as_ref())
                else {
                    return None;
                };
                let (Ok(pid), Ok(window)) = (
                    u32::try_from(act.target.pid),
                    u32::try_from(act.target.window_id),
                ) else {
                    return None;
                };
                notifications
                    .subscribe(pid, window, started, end, Arc::clone(observer))
                    .ok()
            })
    }

    /// Where a pointer aimed at `reference` of `observation` lands: the
    /// element's global centre and the active display holding it.
    pub fn point(
        &self,
        observation: &str,
        reference: &str,
    ) -> Result<(Display, i32, i32), Refusal> {
        let observer = self.observer.as_deref().ok_or(Refusal::NotAvailable)?;
        let (x, y) = self.observations.point(observer, observation, reference)?;
        let displays = self.source()?.displays()?;
        let (x, y) = (i32::try_from(x), i32::try_from(y));
        let (Ok(x), Ok(y)) = (x, y) else {
            return Err(Refusal::OffScreen);
        };
        let display = displays.into_iter().find(|display| display.holds(x, y));
        display
            .map(|display| (display, x, y))
            .ok_or(Refusal::OffScreen)
    }
}

#[cfg(test)]
mod tests;
