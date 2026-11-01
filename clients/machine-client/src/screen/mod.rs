//! Screen enumeration and bounded capture (#1662). A [`Source`] reports
//! displays, windows and raw RGBA8 frames; region bounds, downscale, the
//! PNG/JPEG byte cap and the frame pool are shared, so the headless
//! [`fixture`] adapter drives the same path as the native backend.

pub mod ax;
pub mod blank;
mod encode;
pub mod fixture;
#[cfg(target_os = "macos")]
pub mod native;
pub mod observe;
mod pool;
pub mod private;
pub mod probe;
pub mod settle;
#[cfg(target_os = "linux")]
pub mod x11;
#[cfg(any(target_os = "linux", test))]
mod x11_pixels;

use std::{
    num::NonZeroU64,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, PoisonError,
    },
};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_protocol::{
    screen_capture_request::{ScreenCaptureRequestEncoding, ScreenCaptureRequestTarget},
    ScreenCaptureRequest, ScreenListRequest, ScreenReadRequest,
};
use serde_json::{json, Value};

use crate::attach::now_ms;
use encode::{Encoding, Format};
use observe::Observations;
use pool::Pool;
use private::{blank_rect, focus_state, overlaps, Edge, FocusState, Reason, SecureInput, States};

pub const MAX_BYTES: usize = 4_194_304;
pub const MAX_DIMENSION: u32 = 16_384;
const MAX_DISPLAYS: usize = 16;
const MAX_WINDOWS: usize = 512;
const MAX_TEXT: usize = 256;
const COORDINATE: i64 = 16_384;
/// Simultaneous captures the native backend allows.
pub const CAPTURES: usize = 2;

/// A display in points; `x`/`y` place it in the global desktop space.
#[derive(Clone, Debug, PartialEq)]
pub struct Display {
    pub id: u32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub primary: bool,
}

impl Display {
    /// Whether the global point `(x, y)` lies on this display.
    pub fn holds(&self, x: i32, y: i32) -> bool {
        let inside = |at: i32, origin: i32, extent: u32| {
            (i64::from(origin)..i64::from(origin) + i64::from(extent)).contains(&i64::from(at))
        };
        inside(x, self.x, self.width) && inside(y, self.y, self.height)
    }
}

/// A window with global bounds in points on the display `display` (a
/// [`Display::id`]).
#[derive(Clone, Debug, PartialEq)]
pub struct Window {
    pub id: u32,
    pub display: u32,
    pub title: String,
    pub owner: String,
    /// The owning process, which an observation target names.
    pub pid: Option<u32>,
    pub app: Option<ax::AppIdentity>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fault {
    Absent,
    Permission,
    InvalidRegion,
    DisplayNotFound,
    WindowNotFound,
    WindowMinimized,
    CaptureBlank,
    OwnWindow,
    Superseded,
    Private,
    AccessibilityUnavailable,
    Failed(String),
}

impl Fault {
    fn reason(&self) -> &'static str {
        match self {
            Self::Absent => "screen_not_available",
            Self::Permission => "permission_denied",
            Self::InvalidRegion => "invalid_region",
            Self::DisplayNotFound => "display_not_found",
            Self::WindowNotFound => "window_not_found",
            Self::WindowMinimized => "window_minimized",
            Self::CaptureBlank => "capture_blank",
            Self::OwnWindow => "own_window",
            Self::Superseded => "superseded",
            Self::Private => "private",
            Self::AccessibilityUnavailable => "accessibility_unavailable",
            Self::Failed(_) => "capture_failed",
        }
    }

    fn refusal(&self) -> Value {
        match self {
            Self::Failed(message) => json!({
                "status":"refused","reason":self.reason(),
                "message":message.chars().take(MAX_TEXT).collect::<String>()
            }),
            _ => json!({"status":"refused","reason":self.reason()}),
        }
    }

    /// The legacy `screen_read` refusal has no message and no target
    /// reasons: an unknown display is an invalid region there.
    fn legacy(&self) -> Value {
        let reason = match self {
            Self::DisplayNotFound | Self::WindowNotFound => "invalid_region",
            other => other.reason(),
        };
        json!({"status":"refused","reason":reason})
    }
}

/// A capture backend. `capture_*` clear `pixels`, fill it with an RGBA8
/// frame and return its pixel size.
pub trait Source: Send + Sync {
    /// `Err(Fault::Permission)` when capture is not permitted.
    fn ready(&self) -> Result<(), Fault>;
    fn displays(&self) -> Result<Vec<Display>, Fault>;
    fn windows(&self) -> Result<Vec<Window>, Fault>;
    fn capture_display(&self, display: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault>;
    fn capture_window(&self, window: u32, pixels: &mut Vec<u8>) -> Result<(u32, u32), Fault>;
}

struct Region {
    x: i64,
    y: i64,
    width: u64,
    height: u64,
}

enum Target {
    Display(u64, Option<Region>),
    Window(String),
}

struct Shot<'a> {
    id: String,
    display: usize,
    width: u32,
    height: u32,
    downscaled: bool,
    data: &'a [u8],
    accessibility_unavailable: bool,
}

/// The latest successful capture: input names it, and only it, as its anchor.
struct Anchor {
    seq: u64,
    id: String,
    display: Display,
    window: Option<(u32, u32)>,
}

enum Backend {
    Injected,
    #[cfg(target_os = "macos")]
    Mac,
    #[cfg(target_os = "linux")]
    X11(Option<String>),
}

pub struct Screen {
    backend: Backend,
    pub(crate) launcher: Box<dyn crate::app::Launcher>,
    pub(crate) excluded_owners: Vec<String>,
    source: Option<Box<dyn Source>>,
    pool: Pool,
    next: AtomicU64,
    latest: Mutex<Option<Anchor>>,
    observer: Option<Arc<dyn ax::Observer>>,
    notifications: Option<Box<dyn settle::Notifications>>,
    observations: Observations,
    private_states: Mutex<States>,
    secure_input: Mutex<SecureInput>,
    secure_input_enabled: Box<dyn Fn() -> bool + Send + Sync>,
    accessibility_fault: AtomicBool,
    #[cfg(target_os = "linux")]
    virtual_display: Option<crate::display::xvfb::Owned>,
}

impl Screen {
    pub fn absent() -> Self {
        Self {
            backend: Backend::Injected,
            launcher: crate::app::platform(),
            excluded_owners: Vec::new(),
            source: None,
            pool: Pool::new(0),
            next: AtomicU64::new(0),
            latest: Mutex::new(None),
            observer: None,
            notifications: None,
            observations: Observations::default(),
            private_states: Mutex::default(),
            secure_input: Mutex::default(),
            secure_input_enabled: Box::new(private::platform_secure_input_enabled),
            accessibility_fault: AtomicBool::new(false),
            #[cfg(target_os = "linux")]
            virtual_display: None,
        }
    }

    /// A source is offered even when capture permission is not yet granted.
    pub fn new(source: Box<dyn Source>, captures: usize) -> Self {
        Self {
            backend: Backend::Injected,
            launcher: crate::app::platform(),
            excluded_owners: Vec::new(),
            source: Some(source),
            pool: Pool::new(captures),
            next: AtomicU64::new(0),
            latest: Mutex::new(None),
            observer: None,
            notifications: None,
            observations: Observations::default(),
            private_states: Mutex::default(),
            secure_input: Mutex::default(),
            secure_input_enabled: Box::new(private::platform_secure_input_enabled),
            accessibility_fault: AtomicBool::new(false),
            #[cfg(target_os = "linux")]
            virtual_display: None,
        }
    }

    /// Serves `machine.screen.observe` and `machine.input.action` through `observer`.
    pub fn observing(mut self, observer: Box<dyn ax::Observer>) -> Self {
        self.observer = Some(Arc::from(observer));
        self
    }

    #[cfg(test)]
    pub(crate) fn with_secure_input(
        mut self,
        enabled: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        self.secure_input_enabled = Box::new(enabled);
        self
    }

    fn system_private(&self) -> bool {
        self.secure_input
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .refresh(std::time::Instant::now(), (self.secure_input_enabled)())
    }

    pub fn notifying(mut self, notifications: Box<dyn settle::Notifications>) -> Self {
        self.notifications = Some(notifications);
        self
    }

    pub fn launching(mut self, launcher: Box<dyn crate::app::Launcher>) -> Self {
        self.launcher = launcher;
        self
    }

    pub fn excluding(mut self, owners: Vec<String>) -> Self {
        self.excluded_owners = owners;
        self
    }

    pub(crate) fn lifecycle(
        &self,
        window: &ax::WindowIdentity,
        park: bool,
    ) -> Result<(), ax::ActFault> {
        let observer = self.observer.as_deref().ok_or(ax::ActFault::Unsupported)?;
        observer.lifecycle(window, park)
    }

    #[cfg(target_os = "macos")]
    pub fn platform() -> Self {
        let mut screen = Self::new(Box::new(native::Native), CAPTURES)
            .observing(Box::new(ax::native::Native))
            .notifying(Box::new(ax::observer::Native));
        screen.backend = Backend::Mac;
        screen
    }

    #[cfg(target_os = "linux")]
    pub fn platform() -> Self {
        Self::platform_on(None)
    }

    #[cfg(target_os = "linux")]
    pub fn platform_on(display: Option<&str>) -> Self {
        let selected = probe::linux_display(&probe::linux::System, display);
        Self::platform_selected(selected)
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn platform_selected(selected: Option<String>) -> Self {
        let mut screen = Self::absent();
        if selected.as_deref().and_then(probe::local_display).is_none() {
            screen.backend = Backend::X11(selected);
            return screen;
        }
        if let Ok(source) = x11::Native::open(selected.as_deref()) {
            let authority = source.authority.clone();
            screen = Self::new(Box::new(source), CAPTURES)
                .observing(Box::new(ax::linux::Native(selected.clone())))
                .launching(Box::new(crate::app::linux::Native::selected(
                    selected.clone(),
                    authority,
                    false,
                )));
        }
        screen.backend = Backend::X11(selected);
        screen
    }

    #[cfg(target_os = "linux")]
    pub fn virtualizing(mut self, display: crate::display::xvfb::Owned) -> Self {
        self.launcher = Box::new(crate::app::linux::Native::selected(
            Some(display.id.clone()),
            None,
            true,
        ));
        self.virtual_display = Some(display);
        self
    }

    #[cfg(target_os = "linux")]
    pub fn virtual_display(&self) -> Option<(&str, bool)> {
        self.virtual_display
            .as_ref()
            .map(|display| (display.id.as_str(), display.window_manager_missing()))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn platform() -> Self {
        Self::absent()
    }

    pub fn available(&self) -> bool {
        self.source.is_some()
    }

    /// Recheck capture permission at each report without listing displays.
    pub fn probe(&self) -> Option<Result<(), Fault>> {
        self.source.as_deref().map(|source| source.ready())
    }

    pub fn capability(&self, input: bool) -> probe::Verdict {
        let mut verdict = match &self.backend {
            Backend::Injected => probe::injected(self.probe(), self.observer.is_some(), input),
            #[cfg(target_os = "macos")]
            Backend::Mac => probe::macos_verdict(&probe::macos::System, input),
            #[cfg(target_os = "linux")]
            Backend::X11(selected) => self.linux_capability(selected.clone(), input),
        };
        if self.accessibility_fault.load(Ordering::Relaxed) {
            verdict.grants.accessibility = false;
            verdict.blockers.push(probe::Blocker {
                kind: "accessibility_unavailable",
            });
            verdict = probe::fold(verdict.display, verdict.grants, verdict.blockers);
        }
        verdict.refresh_needs();
        verdict
    }

    #[cfg(target_os = "linux")]
    fn linux_capability(&self, selected: Option<String>, input: bool) -> probe::Verdict {
        let virtual_display = self.virtual_display();
        let mut verdict = probe::linux_ready(
            &probe::linux::System,
            &probe::Display {
                kind: "console",
                id: selected,
                isolated: virtual_display.is_some(),
            },
            input,
            probe::capture_grant(self.probe()),
        );
        if virtual_display.is_some_and(|(_, missing)| missing) {
            verdict.blockers.push(probe::Blocker {
                kind: "window_manager_missing",
            });
            verdict.verdict = "partial";
        }
        verdict.refresh_needs();
        verdict
    }

    pub fn retained(&self) -> usize {
        self.pool.retained()
    }

    pub fn stream_private(
        &self,
        source: &oni_protocol::stream_open_request::StreamOpenRequestSource,
    ) -> Result<bool, Fault> {
        use oni_protocol::stream_open_request::StreamOpenRequestSource as Feed;
        match source {
            Feed::Display { display, region } => {
                let region = region.as_ref().map(|region| Region {
                    x: region.x,
                    y: region.y,
                    width: region.width.get(),
                    height: region.height.get(),
                });
                self.display_private(display.get(), region.as_ref())
            }
            Feed::Window { window_id } => window_id
                .parse()
                .map_err(|_| Fault::WindowNotFound)
                .and_then(|window| self.window_private(window)),
        }
    }

    pub fn input_private(&self, aim: Option<(i32, i32)>) -> Result<bool, Fault> {
        if self.system_private() {
            return Ok(true);
        }
        let observer = self.observer.as_deref().ok_or(Fault::Absent)?;
        let windows = observer.windows().map_err(|_| {
            self.accessibility_fault.store(true, Ordering::Relaxed);
            Fault::AccessibilityUnavailable
        })?;
        if windows.is_empty() {
            return Ok(true);
        }
        if let Some((x, y)) = aim {
            let candidates: Vec<_> = self
                .source()?
                .windows()?
                .into_iter()
                .filter(|window| {
                    i64::from(x) >= i64::from(window.x)
                        && i64::from(x) < i64::from(window.x) + i64::from(window.width)
                        && i64::from(y) >= i64::from(window.y)
                        && i64::from(y) < i64::from(window.y) + i64::from(window.height)
                })
                .collect();
            let [window] = candidates.as_slice() else {
                return Ok(true);
            };
            let private = windows
                .into_iter()
                .find(|identity| identity.window_id == window.id)
                .map(|identity| self.checked_focus(observer, &identity))
                .transpose()?
                .is_none_or(|focus| focus != FocusState::Admits);
            self.accessibility_fault.store(false, Ordering::Relaxed);
            return Ok(private);
        }
        let mut focused = Vec::new();
        for window in &windows {
            match self.checked_focus(observer, window)? {
                FocusState::Idle => {}
                focus => focused.push(focus),
            }
        }
        self.accessibility_fault.store(false, Ordering::Relaxed);
        Ok(focused.len() != 1 || focused.pop() != Some(FocusState::Admits))
    }

    fn checked_focus(
        &self,
        observer: &dyn ax::Observer,
        window: &ax::WindowIdentity,
    ) -> Result<FocusState, Fault> {
        match focus_state(observer.focused(window)) {
            FocusState::Unknown(_) => {
                self.accessibility_fault.store(true, Ordering::Relaxed);
                Err(Fault::AccessibilityUnavailable)
            }
            focus => Ok(focus),
        }
    }

    /// Check only the PID-addressed window's focused field, not overlapping windows.
    pub fn input_target_private(&self, pid: u32, id: u32) -> Result<bool, Fault> {
        if self.system_private() {
            return Ok(true);
        }
        let observer = self.observer.as_deref().ok_or(Fault::Absent)?;
        let window = observer
            .windows()?
            .into_iter()
            .find(|window| window.owner_pid == pid && window.window_id == id)
            .ok_or(Fault::WindowNotFound)?;
        let private = self.checked_focus(observer, &window)? != FocusState::Admits;
        self.accessibility_fault.store(false, Ordering::Relaxed);
        Ok(private)
    }

    /// Identify the live window beneath a pointer before enforcing the caller's expectation.
    pub fn pointer_landing(&self, pid: u32, id: u32) -> Result<Option<String>, Fault> {
        let observer = self.observer.as_deref().ok_or(Fault::Absent)?;
        let window = observer
            .windows()?
            .into_iter()
            .find(|window| window.owner_pid == pid && window.window_id == id)
            .ok_or(Fault::WindowNotFound)?;
        if crate::app::excluded(pid, &window.app, &self.excluded_owners) {
            return Err(Fault::OwnWindow);
        }
        Ok(window
            .app
            .bundle_id
            .or_else(|| (!window.app.path.is_empty()).then_some(window.app.path)))
    }

    /// Live observer ordering puts the frontmost fixture window first.
    pub fn pointer_at(&self, x: i32, y: i32) -> Option<(u32, u32)> {
        let observer = self.observer.as_deref()?;
        let listed = self.source().ok()?.windows().ok()?;
        observer.windows().ok()?.into_iter().find_map(|window| {
            let (width, height) = observer.window_size(&window).ok().or_else(|| {
                listed
                    .iter()
                    .find(|listed| listed.id == window.window_id)
                    .map(|listed| (i64::from(listed.width), i64::from(listed.height)))
            })?;
            let (left, top) = window.origin;
            ((left..left + width).contains(&i64::from(x))
                && (top..top + height).contains(&i64::from(y)))
            .then_some((window.owner_pid, window.window_id))
        })
    }

    pub fn private_edges(&self) -> Result<Vec<(observe::Target, Edge, Reason)>, Fault> {
        let system_private = self.system_private();
        let observer = self.observer.as_deref().ok_or(Fault::Absent)?;
        let windows = observer.windows().inspect_err(|_| {
            self.accessibility_fault.store(true, Ordering::Relaxed);
        })?;
        let observations = &self.observations;
        let mut states = self
            .private_states
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let mut edges = Vec::new();
        let mut failed = false;
        for window in &windows {
            let target = match observations.target_for(observer, window) {
                Ok(target) => target,
                Err(refusal) if edges.is_empty() => {
                    self.accessibility_fault.store(true, Ordering::Relaxed);
                    return Err(Fault::Failed(refusal.reason().to_owned()));
                }
                Err(_) => {
                    self.accessibility_fault.store(true, Ordering::Relaxed);
                    failed = true;
                    break;
                }
            };
            let reason = if system_private {
                Some(Reason::SecureInputEnabled)
            } else if self.checked_focus(observer, window)? == FocusState::Secure {
                Some(Reason::SecureFocus)
            } else {
                None
            };
            if let Some((edge, reason)) = states.update(target, reason) {
                edges.push((target, edge, reason));
            }
        }
        if !failed {
            self.accessibility_fault.store(false, Ordering::Relaxed);
        }
        Ok(edges)
    }

    fn window_private(&self, window_id: u32) -> Result<bool, Fault> {
        if self.system_private() {
            return Ok(true);
        }
        let observer = self.observer.as_deref().ok_or(Fault::Absent)?;
        let window = observer
            .windows()
            .map_err(|fault| match fault {
                Fault::WindowNotFound | Fault::Failed(_) => fault,
                Fault::Permission => {
                    self.accessibility_fault.store(true, Ordering::Relaxed);
                    fault
                }
                _ => {
                    self.accessibility_fault.store(true, Ordering::Relaxed);
                    Fault::AccessibilityUnavailable
                }
            })?
            .into_iter()
            .find(|window| window.window_id == window_id)
            .ok_or(Fault::WindowNotFound)?;
        let private = match focus_state(observer.focused(&window)) {
            FocusState::Unknown(fault @ (Fault::Failed(_) | Fault::WindowNotFound)) => {
                return Err(fault);
            }
            FocusState::Unknown(_) => {
                self.accessibility_fault.store(true, Ordering::Relaxed);
                return Err(Fault::AccessibilityUnavailable);
            }
            focus => focus == FocusState::Secure,
        };
        self.accessibility_fault.store(false, Ordering::Relaxed);
        Ok(private)
    }

    fn mask_private(
        &self,
        source: &dyn Source,
        display: &Display,
        region: Option<&Region>,
        size: (u32, u32),
        transform: Transform,
        pixels: &mut [u8],
    ) -> Result<bool, Fault> {
        if self.system_private() {
            pixels.fill(0);
            return Ok(false);
        }
        let viewport = viewport(display, region)?;
        let pixel = |at: i64, origin: i32, points: u32, total: u32, upper: bool| {
            let scaled = u64::try_from(at - i64::from(origin)).unwrap_or(0) * u64::from(total);
            let position = if upper {
                scaled.div_ceil(u64::from(points))
            } else {
                scaled / u64::from(points)
            };
            i64::try_from(position).unwrap_or(i64::MAX)
        };
        let mut accessibility_unavailable = false;
        for window in source
            .windows()?
            .into_iter()
            .filter(|window| overlaps(window_frame(window), viewport))
        {
            let private = match self.window_private(window.id) {
                Ok(private) => private,
                Err(Fault::AccessibilityUnavailable | Fault::Permission) => {
                    accessibility_unavailable = true;
                    continue;
                }
                Err(Fault::Failed(_) | Fault::WindowNotFound) => continue,
                Err(fault) => return Err(fault),
            };
            if private {
                let left = pixel(
                    i64::from(window.x),
                    display.x,
                    display.width,
                    transform.original.0,
                    false,
                ) - i64::from(transform.crop_start.0);
                let top = pixel(
                    i64::from(window.y),
                    display.y,
                    display.height,
                    transform.original.1,
                    false,
                ) - i64::from(transform.crop_start.1);
                let right = pixel(
                    i64::from(window.x) + i64::from(window.width),
                    display.x,
                    display.width,
                    transform.original.0,
                    true,
                ) - i64::from(transform.crop_start.0);
                let bottom = pixel(
                    i64::from(window.y) + i64::from(window.height),
                    display.y,
                    display.height,
                    transform.original.1,
                    true,
                ) - i64::from(transform.crop_start.1);
                blank_rect(
                    pixels,
                    size,
                    size,
                    ax::Frame {
                        x: left,
                        y: top,
                        width: right - left,
                        height: bottom - top,
                    },
                );
            }
        }
        self.accessibility_fault
            .store(accessibility_unavailable, Ordering::Relaxed);
        Ok(accessibility_unavailable)
    }

    fn display_private(&self, number: u64, region: Option<&Region>) -> Result<bool, Fault> {
        if self.system_private() {
            return Ok(true);
        }
        let source = self.source()?;
        let all = source.displays()?;
        let displays = shown(&all)?;
        let index = usize::try_from(number)
            .ok()
            .filter(|index| (1..=displays.len()).contains(index))
            .ok_or(Fault::DisplayNotFound)?;
        let display = &displays[index - 1];
        let viewport = viewport(display, region)?;
        source
            .windows()?
            .into_iter()
            .filter(|window| overlaps(window_frame(window), viewport))
            .try_fold(false, |private, window| {
                match self.window_private(window.id) {
                    Ok(secure) => Ok(private || secure),
                    Err(Fault::Failed(_) | Fault::WindowNotFound) => Ok(private),
                    Err(fault) => Err(fault),
                }
            })
    }

    pub fn release(&self) {
        self.pool.release();
    }

    fn latest(&self) -> std::sync::MutexGuard<'_, Option<Anchor>> {
        self.latest.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records capture `seq` as the anchor unless a later one already is.
    fn anchor(&self, seq: u64, id: &str, display: &Display, window: Option<(u32, u32)>) {
        let mut latest = self.latest();
        if latest.as_ref().is_none_or(|anchor| anchor.seq < seq) {
            *latest = Some(Anchor {
                seq,
                id: id.to_owned(),
                display: display.clone(),
                window,
            });
        }
    }

    /// The display `capture` was taken on, as it stands now: `Ok(None)` when
    /// `capture` is not the latest capture, or its display has since gone or
    /// moved, so input anchored to it would land somewhere else;
    /// `Fault::Absent` when no display is active at all.
    pub fn anchored(&self, capture: &str) -> Result<Option<Display>, Fault> {
        let current = self.source()?.displays()?;
        if current.is_empty() {
            return Err(Fault::Absent);
        }
        let latest = self.latest();
        Ok(latest
            .as_ref()
            .filter(|anchor| anchor.id == capture && current.contains(&anchor.display))
            .map(|anchor| anchor.display.clone()))
    }

    /// Owner PID and ID of the latest capture's window, if it was window-bound.
    pub fn anchor_window(&self, capture: &str) -> Option<(u32, u32)> {
        self.latest()
            .as_ref()
            .filter(|anchor| anchor.id == capture)
            .and_then(|anchor| anchor.window)
    }

    /// Drops the anchor and every observation: no capture or observation
    /// taken before this call admits input.
    pub fn forget(&self) {
        *self.latest() = None;
        self.observations.forget();
    }

    pub fn list(&self, request: &ScreenListRequest) -> Value {
        self.listing(request.windows.unwrap_or(false))
            .unwrap_or_else(|fault| fault.refusal())
    }

    pub fn capture(&self, request: &ScreenCaptureRequest) -> Value {
        if let ScreenCaptureRequestTarget::Window { window_id } = &request.target {
            let private = window_id
                .parse()
                .map_err(|_| Fault::WindowNotFound)
                .and_then(|id| self.window_private(id));
            match private {
                Ok(true) => return Fault::Private.refusal(),
                Err(Fault::Permission) => return Fault::AccessibilityUnavailable.refusal(),
                Err(fault) => return fault.refusal(),
                Ok(false) => {}
            }
        }
        let (format, quality) = match request.encoding {
            ScreenCaptureRequestEncoding::Png => (Format::Png, 0),
            ScreenCaptureRequestEncoding::Jpeg(quality) => {
                (Format::Jpeg, u8::try_from(quality.get()).unwrap_or(100))
            }
        };
        let encoding = Encoding {
            format,
            quality,
            max_bytes: request.max_bytes.map_or(MAX_BYTES, |bytes| {
                usize::try_from(bytes.get())
                    .unwrap_or(MAX_BYTES)
                    .min(MAX_BYTES)
            }),
            max_dimension: request.max_dimension.map_or(MAX_DIMENSION, |side| {
                u32::try_from(side.get())
                    .unwrap_or(MAX_DIMENSION)
                    .min(MAX_DIMENSION)
            }),
        };
        let target = match &request.target {
            ScreenCaptureRequestTarget::Display { display, region } => Target::Display(
                display.get(),
                region.as_ref().map(|region| Region {
                    x: region.x,
                    y: region.y,
                    width: region.width.get(),
                    height: region.height.get(),
                }),
            ),
            ScreenCaptureRequestTarget::Window { window_id } => {
                Target::Window(window_id.to_string())
            }
        };
        self.shoot(&target, &encoding, |shot| {
            let mut answer = json!({
                "status":"ok","captureId":shot.id,"display":shot.display,
                "format":format.name(),"data":STANDARD.encode(shot.data),
                "width":shot.width,"height":shot.height,
                "downscaled":shot.downscaled,"observedAt":now_ms()
            });
            if shot.accessibility_unavailable {
                answer["accessibilityUnavailable"] = json!(true);
            }
            answer
        })
        .unwrap_or_else(|fault| fault.refusal())
    }

    /// The legacy whole-or-region PNG read of one display (default 1).
    pub fn read(&self, request: &ScreenReadRequest) -> Value {
        let region = request.region.as_ref().map(|region| Region {
            x: region.x,
            y: region.y,
            width: region.width.get(),
            height: region.height.get(),
        });
        let target = Target::Display(request.display.map_or(1, NonZeroU64::get), region);
        let encoding = Encoding {
            format: Format::Png,
            quality: 0,
            max_bytes: MAX_BYTES,
            max_dimension: MAX_DIMENSION,
        };
        self.shoot(&target, &encoding, |shot| {
            let mut answer =
                json!({"status":"ok","captureId":shot.id,"png":STANDARD.encode(shot.data)});
            if shot.accessibility_unavailable {
                answer["accessibilityUnavailable"] = json!(true);
            }
            answer
        })
        .unwrap_or_else(|fault| fault.legacy())
    }

    fn source(&self) -> Result<&dyn Source, Fault> {
        let source = self.source.as_deref().ok_or(Fault::Absent)?;
        source.ready()?;
        Ok(source)
    }

    fn listing(&self, windows: bool) -> Result<Value, Fault> {
        let source = self.source()?;
        let all = source.displays()?;
        let displays = shown(&all)?;
        let mut truncated = all.len() > displays.len();
        let mut rows = Vec::new();
        if windows {
            for window in source.windows()? {
                let Some(index) = displays
                    .iter()
                    .position(|display| display.id == window.display)
                else {
                    truncated = true;
                    continue;
                };
                if rows.len() == MAX_WINDOWS {
                    truncated = true;
                    break;
                }
                rows.push(window_row(&window, index, &displays[index]));
            }
            if let Some(observer) = self.observer.as_deref() {
                if let Ok(identities) = self.observations.listed(observer) {
                    let epochs: std::collections::HashMap<_, _> = identities
                        .iter()
                        .map(|(identity, epoch)| ((identity.pid, identity.window_id), *epoch))
                        .collect();
                    for (identity, _) in identities {
                        let Some(surface) = identity.surface else {
                            continue;
                        };
                        let Some(index) = displays.iter().position(|display| {
                            let frame = &surface.frame;
                            i64::from(display.x) <= frame.x
                                && frame.x < i64::from(display.x) + i64::from(display.width)
                                && i64::from(display.y) <= frame.y
                                && frame.y < i64::from(display.y) + i64::from(display.height)
                        }) else {
                            truncated = true;
                            continue;
                        };
                        if rows.len() == MAX_WINDOWS {
                            truncated = true;
                            break;
                        }
                        let frame = &surface.frame;
                        let display = &displays[index];
                        let mut row = json!({
                            "windowId":identity.window_id.to_string(),
                            "kind":surface.kind.name(),
                            "display":index + 1,
                            "title":identity.title.chars().take(MAX_TEXT).collect::<String>(),
                            "owner":identity.app.bundle_id.as_deref().unwrap_or(&identity.app.path).chars().take(MAX_TEXT).collect::<String>(),
                            "pid":identity.pid,
                            "app":identity.app,
                            "bounds":{
                                "x":(frame.x - i64::from(display.x)).clamp(-COORDINATE, COORDINATE),
                                "y":(frame.y - i64::from(display.y)).clamp(-COORDINATE, COORDINATE),
                                "width":u32::try_from(frame.width.max(0)).unwrap_or(MAX_DIMENSION).min(MAX_DIMENSION),
                                "height":u32::try_from(frame.height.max(0)).unwrap_or(MAX_DIMENSION).min(MAX_DIMENSION),
                            }
                        });
                        if let Some((parent, epoch)) = surface.parent.and_then(|parent| {
                            epochs
                                .get(&(identity.pid, parent))
                                .map(|epoch| (parent, epoch))
                        }) {
                            row["parent"] = json!({
                                "pid":identity.pid,"windowId":parent,
                                "epoch":epoch
                            });
                        }
                        rows.push(row);
                    }
                }
            }
        }
        let displays: Vec<Value> = displays
            .iter()
            .enumerate()
            .map(|(index, display)| display_row(index, display))
            .collect();
        Ok(json!({
            "status":"ok","displays":displays,"windows":rows,
            "truncated":truncated,"observedAt":now_ms()
        }))
    }

    fn shoot(
        &self,
        target: &Target,
        encoding: &Encoding,
        render: impl FnOnce(Shot<'_>) -> Value,
    ) -> Result<Value, Fault> {
        let ticket = match target {
            Target::Window(id) => {
                let id = id.parse().map_err(|_| Fault::WindowNotFound)?;
                self.capture_guard(id)?;
                Some(self.pool.begin(id))
            }
            Target::Display(..) => None,
        };
        let attempt = || {
            let source = self.source()?;
            let all = source.displays()?;
            let displays = shown(&all)?;
            let mut lease = self
                .pool
                .acquire()
                .ok_or_else(|| Fault::Failed("frame pool saturated".to_owned()))?;
            let slot = &mut lease.slot;
            let Raw {
                index: display,
                display: anchor,
                window,
                size,
                transform,
            } = raw(source, displays, target, &mut slot.pixels)?;
            let accessibility_unavailable = if let Target::Display(_, region) = target {
                self.mask_private(
                    source,
                    anchor,
                    region.as_ref(),
                    size,
                    transform,
                    &mut slot.pixels,
                )?
            } else {
                false
            };
            if ticket.is_some() && blank::blank(&slot.pixels) {
                return Err(Fault::CaptureBlank);
            }
            let fitted = encode::fit(
                &slot.pixels,
                size,
                encoding,
                &mut slot.scratch,
                &mut slot.encoded,
            )?;
            let seq = self.next.fetch_add(1, Ordering::Relaxed) + 1;
            let id = format!("cap-{seq}");
            let value = render(Shot {
                id: id.clone(),
                display,
                width: fitted.width,
                height: fitted.height,
                downscaled: fitted.downscaled,
                data: &slot.encoded,
                accessibility_unavailable,
            });
            let publish = || {
                self.anchor(seq, &id, anchor, window);
                value
            };
            let result = match &ticket {
                Some(ticket) => ticket.publish(publish).ok_or(Fault::Superseded),
                None => Ok(publish()),
            };
            if result.is_ok() {
                lease.keep();
            }
            result
        };
        let result = attempt();
        if result.is_err() && ticket.as_ref().is_some_and(|ticket| !ticket.current()) {
            return Err(Fault::Superseded);
        }
        result
    }

    fn capture_guard(&self, id: u32) -> Result<(), Fault> {
        let Some(observer) = &self.observer else {
            return Ok(());
        };
        let windows = match observer.windows() {
            Ok(windows) => windows,
            Err(Fault::Permission) => return Ok(()),
            Err(fault) => return Err(fault),
        };
        let window = windows
            .into_iter()
            .find(|window| window.window_id == id)
            .ok_or(Fault::WindowNotFound)?;
        if crate::app::excluded(window.owner_pid, &window.app, &self.excluded_owners) {
            return Err(Fault::OwnWindow);
        }
        if window.minimized {
            return Err(Fault::WindowMinimized);
        }
        Ok(())
    }
}

/// Captures `target` into `pixels` (cropped to its region): the 1-based
/// display index, that display and the frame's pixel size.
#[derive(Clone, Copy)]
struct Transform {
    original: (u32, u32),
    crop_start: (u32, u32),
}

struct Raw<'a> {
    index: usize,
    display: &'a Display,
    window: Option<(u32, u32)>,
    size: (u32, u32),
    transform: Transform,
}

fn raw<'a>(
    source: &dyn Source,
    displays: &'a [Display],
    target: &Target,
    frame: &mut Vec<u8>,
) -> Result<Raw<'a>, Fault> {
    match target {
        Target::Display(number, region) => {
            let index = usize::try_from(*number)
                .ok()
                .filter(|index| (1..=displays.len()).contains(index))
                .ok_or(Fault::DisplayNotFound)?;
            let display = &displays[index - 1];
            let points = region
                .as_ref()
                .map(|region| bounds(region, display))
                .transpose()?;
            let size = source.capture_display(display.id, frame)?;
            let source_size = size;
            let (size, crop_start) = match points {
                Some((columns, rows)) => {
                    let columns = pixels(columns, display.width, size.0);
                    let rows = pixels(rows, display.height, size.1);
                    let crop_start = (columns.start, rows.start);
                    (encode::crop(frame, size.0, columns, rows), crop_start)
                }
                None => (size, (0, 0)),
            };
            Ok(Raw {
                index,
                display,
                window: None,
                size,
                transform: Transform {
                    original: source_size,
                    crop_start,
                },
            })
        }
        Target::Window(id) => {
            let id: u32 = id.parse().map_err(|_| Fault::WindowNotFound)?;
            let window = source
                .windows()?
                .into_iter()
                .find(|window| window.id == id)
                .ok_or(Fault::WindowNotFound)?;
            let index = displays
                .iter()
                .position(|display| display.id == window.display)
                .ok_or(Fault::WindowNotFound)?;
            let size = source.capture_window(id, frame)?;
            Ok(Raw {
                index: index + 1,
                display: &displays[index],
                window: window.pid.map(|pid| (pid, window.id)),
                size,
                transform: Transform {
                    original: size,
                    crop_start: (0, 0),
                },
            })
        }
    }
}

/// The displays the wire can carry (at most 16); none is an absent screen.
fn shown(displays: &[Display]) -> Result<&[Display], Fault> {
    if displays.is_empty() {
        return Err(Fault::Absent);
    }
    Ok(&displays[..displays.len().min(MAX_DISPLAYS)])
}

fn side(points: u32) -> u32 {
    points.clamp(1, MAX_DIMENSION)
}

fn display_row(index: usize, display: &Display) -> Value {
    let scale = if display.scale > 0.0 {
        display.scale.min(8.0)
    } else {
        1.0
    };
    json!({
        "display":index + 1,"width":side(display.width),"height":side(display.height),
        "scale":scale,"primary":display.primary
    })
}

fn window_row(window: &Window, index: usize, display: &Display) -> Value {
    let offset =
        |at: i32, origin: i32| (i64::from(at) - i64::from(origin)).clamp(-COORDINATE, COORDINATE);
    let mut row = json!({
        "windowId":window.id.to_string(),"kind":"window","display":index + 1,
        "title":window.title.chars().take(MAX_TEXT).collect::<String>(),
        "owner":window.owner.chars().take(MAX_TEXT).collect::<String>(),
        "bounds":{
            "x":offset(window.x, display.x),"y":offset(window.y, display.y),
            "width":window.width.min(MAX_DIMENSION),"height":window.height.min(MAX_DIMENSION)
        }
    });
    if let Some(pid) = window.pid {
        row["pid"] = json!(pid);
    }
    if let Some(app) = &window.app {
        row["app"] = json!(app);
    }
    row
}

/// The region's point ranges, refused unless inside the display.
fn bounds(
    region: &Region,
    display: &Display,
) -> Result<(std::ops::Range<u64>, std::ops::Range<u64>), Fault> {
    let start = |at: i64| u64::try_from(at).map_err(|_| Fault::InvalidRegion);
    let (x, y) = (start(region.x)?, start(region.y)?);
    let (right, bottom) = (x + region.width, y + region.height);
    if right > u64::from(display.width) || bottom > u64::from(display.height) {
        return Err(Fault::InvalidRegion);
    }
    Ok((x..right, y..bottom))
}

fn viewport(display: &Display, region: Option<&Region>) -> Result<ax::Frame, Fault> {
    let (x, y, width, height) = match region {
        Some(region) => {
            bounds(region, display)?;
            (
                i64::from(display.x) + region.x,
                i64::from(display.y) + region.y,
                region.width,
                region.height,
            )
        }
        None => (
            i64::from(display.x),
            i64::from(display.y),
            u64::from(display.width),
            u64::from(display.height),
        ),
    };
    Ok(ax::Frame {
        x,
        y,
        width: i64::try_from(width).map_err(|_| Fault::InvalidRegion)?,
        height: i64::try_from(height).map_err(|_| Fault::InvalidRegion)?,
    })
}

fn window_frame(window: &Window) -> ax::Frame {
    ax::Frame {
        x: i64::from(window.x),
        y: i64::from(window.y),
        width: i64::from(window.width),
        height: i64::from(window.height),
    }
}

/// Maps a point range on a `points`-wide axis onto a `pixels`-wide frame,
/// covering every partially included pixel and at least one.
fn pixels(range: std::ops::Range<u64>, points: u32, pixels: u32) -> std::ops::Range<u32> {
    let (points, frame) = (u64::from(points), u64::from(pixels));
    let start = (range.start * frame / points).min(frame - 1);
    let end = range.end * frame;
    let end = end.div_ceil(points).clamp(start + 1, frame);
    start as u32..end as u32
}

impl Screen {
    /// One RGBA8 video frame of a stream's `source` into `out`, captured
    /// through the frame pool and box-scaled to fit `max_dimension` with even
    /// sides; a saturated pool is `Fault::Failed`.
    pub fn frame(
        &self,
        source: &oni_protocol::stream_open_request::StreamOpenRequestSource,
        max_dimension: u32,
        out: &mut Vec<u8>,
    ) -> Result<(u32, u32), Fault> {
        self.frame_private(source, max_dimension, out)
            .map(|(size, _)| size)
    }

    pub fn frame_private(
        &self,
        source: &oni_protocol::stream_open_request::StreamOpenRequestSource,
        max_dimension: u32,
        out: &mut Vec<u8>,
    ) -> Result<((u32, u32), bool), Fault> {
        use oni_protocol::stream_open_request::StreamOpenRequestSource as Feed;
        let target = match source {
            Feed::Display { display, region } => Target::Display(
                display.get(),
                region.as_ref().map(|region| Region {
                    x: region.x,
                    y: region.y,
                    width: region.width.get(),
                    height: region.height.get(),
                }),
            ),
            Feed::Window { window_id } => Target::Window(window_id.to_string()),
        };
        let private = self.stream_private(source)?;
        let capture = self.source()?;
        let all = capture.displays()?;
        let displays = shown(&all)?;
        let mut lease = self
            .pool
            .acquire()
            .ok_or_else(|| Fault::Failed("frame pool saturated".to_owned()))?;
        let Raw {
            display,
            size,
            transform,
            ..
        } = raw(capture, displays, &target, &mut lease.slot.pixels)?;
        match &target {
            Target::Window(_) if private => lease.slot.pixels.fill(0),
            Target::Window(_) => {}
            Target::Display(_, region) => {
                self.mask_private(
                    capture,
                    display,
                    region.as_ref(),
                    size,
                    transform,
                    &mut lease.slot.pixels,
                )?;
            }
        }
        let scaled = encode::even(&lease.slot.pixels, size, max_dimension, out);
        lease.keep();
        Ok((scaled, private))
    }
}
