//! Typed pointer, keyboard and text input (#1662). Every request names the
//! latest screen capture as its anchor and is planned whole — anchor, point
//! bounds, key names, scroll deltas and text — before its first event
//! reaches the [`Driver`], so a refusal never leaves a partial action behind.
//! Pointer coordinates are points on the anchored capture's display and are
//! translated into the global desktop space here; the driver only ever sees
//! global points. A driver failure mid-request releases every button and key
//! the request pressed and answers `input_failed`.
//!
//! The capability gate (`computer.use` / `input.write` granted at attach) is
//! the caller's: this module is defense in depth behind the host's own gate,
//! and re-checks the driver's permission and the anchor on every request.

pub mod action;
pub mod cg;
pub mod delivery;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod native;
pub mod recorder;
pub mod tag;
#[cfg(target_os = "macos")]
pub mod tap;
pub mod watch;

use std::sync::{Mutex, PoisonError};

use oni_protocol::{
    input_key_request::InputKeyRequestAction,
    input_pointer_request::{
        InputPointerRequestButtonAt, InputPointerRequestButtonState, InputPointerRequestClickAt,
        InputPointerRequestMoveAt, InputPointerRequestScrollAt,
    },
    input_write_request::InputWriteRequestActionsItem,
    InputKeyRequest, InputPointerRequest, InputTextRequest, InputWriteRequest,
};
use serde_json::{json, Value};

use crate::screen::{Display, Fault, Screen};
use delivery::Route;

/// Characters one request may type, across all of its text.
pub const MAX_TEXT_CHARS: usize = 10_000;
/// Largest scroll delta per axis, in the driver's scroll units.
pub const MAX_SCROLL: u64 = 10_000;
const MAX_MESSAGE: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// The named keys every driver maps; the wire spells them as the
/// `KeyboardEvent.key` names below (case-insensitive), `Return` included.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Named {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Space,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    Home,
    End,
    PageUp,
    PageDown,
    CapsLock,
    Shift,
    Control,
    Alt,
    Meta,
    /// `F1` through `F12`.
    F(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Named(Named),
    /// One printable character, typed through the active layout.
    Char(char),
}

/// One injected event. `Move` is in global desktop points; `reference` is
/// the observed ref a pointer anchor resolved to that point, recorded with
/// it and never consulted by a backend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Move {
        x: i32,
        y: i32,
        reference: Option<String>,
    },
    Button {
        button: Button,
        down: bool,
        click: u32,
    },
    Scroll {
        horizontal: bool,
        delta: i32,
    },
    Key {
        key: Key,
        down: bool,
    },
    Text(String),
}

/// An input backend. `inject` fires one event; the caller has already
/// validated it, so a failure here is the platform refusing it.
pub trait Driver: Send {
    /// False when the platform does not (or no longer) permit injection.
    fn permitted(&self) -> bool;
    fn prepare(&mut self, _: Route, _: &[Event]) -> Result<(), String> {
        Ok(())
    }
    fn inject(&mut self, event: &Event) -> Result<(), String>;
    fn pid_delivery(&self) -> bool;
    fn post_to_pid(&mut self, pid: u32, event: &Event) -> Result<(), String>;
}

const NAMED: [(&str, Named); 20] = [
    ("Enter", Named::Enter),
    ("Return", Named::Enter),
    ("Tab", Named::Tab),
    ("Escape", Named::Escape),
    ("Backspace", Named::Backspace),
    ("Delete", Named::Delete),
    ("Space", Named::Space),
    ("ArrowUp", Named::ArrowUp),
    ("ArrowDown", Named::ArrowDown),
    ("ArrowLeft", Named::ArrowLeft),
    ("ArrowRight", Named::ArrowRight),
    ("Home", Named::Home),
    ("End", Named::End),
    ("PageUp", Named::PageUp),
    ("PageDown", Named::PageDown),
    ("CapsLock", Named::CapsLock),
    ("Shift", Named::Shift),
    ("Control", Named::Control),
    ("Alt", Named::Alt),
    ("Meta", Named::Meta),
];

/// Parses one key name: a single printable character, `F1`..`F12`, or a
/// [`Named`] spelling. Anything else is not a key this client knows.
pub fn key(name: &str) -> Option<Key> {
    let mut chars = name.chars();
    if let (Some(single), None) = (chars.next(), chars.next()) {
        return (!single.is_control()).then_some(Key::Char(single));
    }
    let function = name
        .strip_prefix(['F', 'f'])
        .and_then(|number| number.parse::<u8>().ok())
        .filter(|number| (1..=12).contains(number));
    function
        .map(|number| Key::Named(Named::F(number)))
        .or_else(|| {
            NAMED
                .iter()
                .find(|(spelling, _)| spelling.eq_ignore_ascii_case(name))
                .map(|&(_, named)| Key::Named(named))
        })
}

struct Refusal {
    reason: &'static str,
    message: Option<String>,
}

fn refuse(reason: &'static str) -> Refusal {
    Refusal {
        reason,
        message: None,
    }
}

fn explain(reason: &'static str, message: String) -> Refusal {
    Refusal {
        reason,
        message: Some(message.chars().take(MAX_MESSAGE).collect()),
    }
}

impl Refusal {
    fn value(self) -> Value {
        match self.message {
            Some(message) => json!({"status":"refused","reason":self.reason,"message":message}),
            None => json!({"status":"refused","reason":self.reason}),
        }
    }
}

/// The wire spells every button enum `left|right|middle`.
fn button(name: &str) -> Button {
    match name {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    }
}

/// `at` on an `extent`-point axis starting at global `origin`.
fn offset(at: i64, extent: u32, origin: i32) -> Result<i32, Refusal> {
    i32::try_from(at)
        .ok()
        .filter(|&at| at >= 0 && i64::from(at) < i64::from(extent))
        .and_then(|at| origin.checked_add(at))
        .ok_or_else(|| refuse("invalid_region"))
}

/// What a request is anchored to: a capture (its display), a point on a
/// capture's display, or a ref of an observation (its element's centre on
/// a fresh walk). A pointer anchor's global point is the request's first move.
enum Anchor<'a> {
    Capture(&'a str),
    Point {
        capture: &'a str,
        x: i64,
        y: i64,
    },
    Ref {
        observation: &'a str,
        reference: &'a str,
    },
}

macro_rules! pointer_anchor {
    ($($at:ident),+) => {$(
        impl<'a> From<&'a $at> for Anchor<'a> {
            fn from(at: &'a $at) -> Self {
                match at {
                    $at::Variant0 { capture_id, x, y } => Anchor::Point {
                        capture: capture_id.as_str(),
                        x: *x,
                        y: *y,
                    },
                    $at::Variant1 { observation_id, ref_ } => Anchor::Ref {
                        observation: observation_id.as_str(),
                        reference: ref_.as_str(),
                    },
                }
            }
        }
    )+};
}

pointer_anchor!(
    InputPointerRequestMoveAt,
    InputPointerRequestClickAt,
    InputPointerRequestButtonAt,
    InputPointerRequestScrollAt
);

fn anchored(screen: &Screen, capture: &str) -> Result<Display, Refusal> {
    match screen.anchored(capture) {
        Ok(Some(display)) => Ok(display),
        Ok(None) => Err(refuse("stale_capture")),
        Err(Fault::Absent) => Err(refuse("input_not_available")),
        Err(Fault::Permission) => Err(refuse("permission_denied")),
        Err(fault) => Err(explain("input_failed", format!("{fault:?}"))),
    }
}

/// The anchor's display and, for a pointer anchor, its global point.
fn resolve(screen: &Screen, anchor: &Anchor<'_>) -> Result<(Display, Option<Event>), Refusal> {
    match *anchor {
        Anchor::Capture(capture) => Ok((anchored(screen, capture)?, None)),
        Anchor::Point { capture, x, y } => {
            let display = anchored(screen, capture)?;
            let aim = Event::Move {
                x: offset(x, display.width, display.x)?,
                y: offset(y, display.height, display.y)?,
                reference: None,
            };
            Ok((display, Some(aim)))
        }
        Anchor::Ref {
            observation,
            reference,
        } => {
            let (display, x, y) =
                screen
                    .point(observation, reference)
                    .map_err(|refusal| Refusal {
                        reason: refusal.reason(),
                        message: refusal.message(),
                    })?;
            let reference = Some(reference.to_owned());
            Ok((display, Some(Event::Move { x, y, reference })))
        }
    }
}

struct Plan<'a> {
    display: &'a Display,
    events: Vec<Event>,
    typed: usize,
}

impl Plan<'_> {
    fn point(&mut self, x: i64, y: i64) -> Result<(), Refusal> {
        let x = offset(x, self.display.width, self.display.x)?;
        let y = offset(y, self.display.height, self.display.y)?;
        self.events.push(Event::Move {
            x,
            y,
            reference: None,
        });
        Ok(())
    }

    fn press(&mut self, button: Button, count: u64) {
        for ordinal in 1..=count {
            let click = u32::try_from(ordinal).unwrap_or(u32::MAX);
            self.events.push(Event::Button {
                button,
                down: true,
                click,
            });
            self.events.push(Event::Button {
                button,
                down: false,
                click,
            });
        }
    }

    fn scroll(&mut self, horizontal: i64, vertical: i64) -> Result<(), Refusal> {
        for (axis, delta) in [(true, horizontal), (false, vertical)] {
            if delta.unsigned_abs() > MAX_SCROLL {
                return Err(explain(
                    "unsupported_action",
                    format!("scroll delta {delta} exceeds {MAX_SCROLL}"),
                ));
            }
            if delta != 0 {
                self.events.push(Event::Scroll {
                    horizontal: axis,
                    delta: delta as i32,
                });
            }
        }
        Ok(())
    }

    /// Modifiers go down in order before the key and up in reverse after it.
    fn chord(&mut self, key: Key, modifiers: &[Named], down: bool, up: bool) {
        let modifier = |named: &Named, down| Event::Key {
            key: Key::Named(*named),
            down,
        };
        if down {
            self.events
                .extend(modifiers.iter().map(|named| modifier(named, true)));
            self.events.push(Event::Key { key, down: true });
        }
        if up {
            self.events.push(Event::Key { key, down: false });
            self.events
                .extend(modifiers.iter().rev().map(|named| modifier(named, false)));
        }
    }

    fn text(&mut self, text: &str) -> Result<(), Refusal> {
        self.typed += text.chars().count();
        if self.typed > MAX_TEXT_CHARS {
            return Err(explain(
                "unsupported_action",
                format!("text exceeds {MAX_TEXT_CHARS} characters"),
            ));
        }
        if let Some(control) = text
            .chars()
            .find(|c| c.is_control() && !matches!(c, '\n' | '\t'))
        {
            return Err(explain(
                "unsupported_action",
                format!(
                    "text contains control character U+{:04X}",
                    u32::from(control)
                ),
            ));
        }
        self.events.push(Event::Text(text.to_owned()));
        Ok(())
    }
}

fn unknown(name: &str) -> Refusal {
    explain("unsupported_action", format!("unknown key: {name}"))
}

/// A legacy chord `Control+Shift+t`: modifiers, then exactly one key.
fn chord(name: &str) -> Option<(Key, Vec<Named>)> {
    let mut parts: Vec<&str> = name.split('+').collect();
    let last = parts.pop().filter(|last| !last.is_empty())?;
    let modifiers = parts
        .into_iter()
        .map(|part| match key(part)? {
            Key::Named(named @ (Named::Shift | Named::Control | Named::Alt | Named::Meta)) => {
                Some(named)
            }
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    Some((key(last)?, modifiers))
}

/// The driver with every button and key a successful request left down:
/// held across requests until released by a later request or by [`Input::settle`].
struct Driven {
    driver: Box<dyn Driver>,
    held: Vec<(Route, Event)>,
}

pub struct Input {
    driver: Option<Mutex<Driven>>,
}

impl Input {
    pub fn absent() -> Self {
        Self { driver: None }
    }

    /// Offer an existing driver; permission is checked before every injection.
    pub fn new(driver: impl Driver + 'static) -> Self {
        Self {
            driver: Some(Mutex::new(Driven {
                driver: Box::new(driver),
                held: Vec::new(),
            })),
        }
    }

    /// The native driver, or absent when the platform has none or refused
    /// the connection (no display server, no Accessibility grant).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub fn platform() -> Self {
        native::open().map_or_else(|_| Self::absent(), Self::new)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn platform() -> Self {
        Self::absent()
    }

    pub fn available(&self) -> bool {
        self.driver.is_some()
    }

    /// Waits for an in-flight request to finish, then releases, in reverse,
    /// every button and key still held: after `screen.forget()` and this
    /// call, no request anchored before them can still inject and nothing
    /// an earlier request pressed stays down.
    pub fn settle(&self) {
        if let Some(driver) = &self.driver {
            let mut driven = driver.lock().unwrap_or_else(PoisonError::into_inner);
            let Driven { driver, held } = &mut *driven;
            for (route, release) in held.drain(..).rev() {
                if let Err(error) = delivery::post(driver.as_mut(), route, &release) {
                    eprintln!("input release failed: {error}");
                }
            }
        }
    }

    pub fn pointer(&self, screen: &Screen, request: &InputPointerRequest) -> Value {
        let foreground = match request {
            InputPointerRequest::Move { delivery, .. } => delivery.to_string() == "foreground",
            InputPointerRequest::Click { delivery, .. } => delivery.to_string() == "foreground",
            InputPointerRequest::Button { delivery, .. } => delivery.to_string() == "foreground",
            InputPointerRequest::Scroll { delivery, .. } => delivery.to_string() == "foreground",
        };
        if !foreground {
            return refuse("foreground_required").value();
        }
        let anchor = match request {
            InputPointerRequest::Move { at, .. } => at.into(),
            InputPointerRequest::Click { at, .. } => at.into(),
            InputPointerRequest::Button { at, .. } => at.into(),
            InputPointerRequest::Scroll { at, .. } => at.into(),
        };
        self.run(screen, &anchor, false, Route::Foreground, &|plan| {
            match request {
                InputPointerRequest::Move { .. } => {}
                InputPointerRequest::Click {
                    button: b, count, ..
                } => {
                    plan.press(button(&b.to_string()), count.get());
                }
                InputPointerRequest::Button {
                    button: b, state, ..
                } => {
                    plan.events.push(Event::Button {
                        button: button(&b.to_string()),
                        down: *state == InputPointerRequestButtonState::Down,
                        click: 1,
                    });
                }
                InputPointerRequest::Scroll {
                    delta_x, delta_y, ..
                } => plan.scroll(*delta_x, *delta_y)?,
            }
            Ok(())
        })
    }

    pub fn key(&self, screen: &Screen, request: &InputKeyRequest) -> Value {
        let target = request.target.as_ref().map(|target| {
            crate::screen::observe::target(target.pid.get(), target.window_id, target.epoch)
        });
        let route = match route(screen, request.delivery.to_string() == "foreground", target) {
            Ok(route) => route,
            Err(refusal) => return refusal.value(),
        };
        self.run(
            screen,
            &Anchor::Capture(&request.capture_id),
            false,
            route,
            &|plan| {
                let pressed = key(&request.key).ok_or_else(|| unknown(&request.key))?;
                let held = request.modifiers.as_ref().map_or_else(Vec::new, |held| {
                    [
                        (held.shift, Named::Shift),
                        (held.control, Named::Control),
                        (held.alt, Named::Alt),
                        (held.meta, Named::Meta),
                    ]
                    .into_iter()
                    .filter_map(|(on, named)| on.unwrap_or(false).then_some(named))
                    .collect()
                });
                let (down, up) = match request.action {
                    InputKeyRequestAction::Press => (true, true),
                    InputKeyRequestAction::Down => (true, false),
                    InputKeyRequestAction::Up => (false, true),
                };
                plan.chord(pressed, &held, down, up);
                Ok(())
            },
        )
    }

    pub fn text(&self, screen: &Screen, request: &InputTextRequest) -> Value {
        let target = request.target.as_ref().map(|target| {
            crate::screen::observe::target(target.pid.get(), target.window_id, target.epoch)
        });
        let route = match route(screen, request.delivery.to_string() == "foreground", target) {
            Ok(route) => route,
            Err(refusal) => return refusal.value(),
        };
        self.run(
            screen,
            &Anchor::Capture(&request.capture_id),
            false,
            route,
            &|plan| plan.text(&request.text),
        )
    }

    /// The legacy batch: main display only, as its contract states; every
    /// action is planned before the first one runs.
    pub fn write(&self, screen: &Screen, request: &InputWriteRequest) -> Value {
        self.run(
            screen,
            &Anchor::Capture(&request.capture_id),
            true,
            Route::Foreground,
            &|plan| {
                for action in &request.actions {
                    match action {
                        InputWriteRequestActionsItem::Click { button: b, x, y } => {
                            plan.point(*x, *y)?;
                            plan.press(b.map_or(Button::Left, |b| button(&b.to_string())), 1);
                        }
                        InputWriteRequestActionsItem::Type { text } => plan.text(text)?,
                        InputWriteRequestActionsItem::Key { name } => {
                            let (pressed, held) = chord(name).ok_or_else(|| unknown(name))?;
                            plan.chord(pressed, &held, true, true);
                        }
                        InputWriteRequestActionsItem::Move { x, y } => plan.point(*x, *y)?,
                        InputWriteRequestActionsItem::Scroll { delta_x, delta_y } => {
                            plan.scroll(delta_x.unwrap_or(0), delta_y.unwrap_or(0))?;
                        }
                    }
                }
                Ok(())
            },
        )
    }

    /// Permission, anchor and the whole plan are checked under the driver
    /// lock before anything is injected.
    fn run(
        &self,
        screen: &Screen,
        anchor: &Anchor<'_>,
        main_only: bool,
        route: Route,
        build: &dyn Fn(&mut Plan<'_>) -> Result<(), Refusal>,
    ) -> Value {
        let Some(driver) = &self.driver else {
            return refuse("input_not_available").value();
        };
        let mut driven = driver.lock().unwrap_or_else(PoisonError::into_inner);
        let Driven { driver, held } = &mut *driven;
        self.attempt(
            (driver.as_mut(), held),
            screen,
            anchor,
            main_only,
            route,
            build,
        )
        .map_or_else(Refusal::value, |()| json!({"status":"ok"}))
    }

    fn attempt(
        &self,
        (driver, held): (&mut dyn Driver, &mut Vec<(Route, Event)>),
        screen: &Screen,
        anchor: &Anchor<'_>,
        main_only: bool,
        route: Route,
        build: &dyn Fn(&mut Plan<'_>) -> Result<(), Refusal>,
    ) -> Result<(), Refusal> {
        if !driver.permitted() {
            return Err(refuse("permission_denied"));
        }
        let (display, aim) = resolve(screen, anchor)?;
        if main_only && !display.primary {
            return Err(explain(
                "unsupported_action",
                "the capture is not of the main display; input_write is main-display only"
                    .to_owned(),
            ));
        }
        let mut plan = Plan {
            display: &display,
            events: aim.into_iter().collect(),
            typed: 0,
        };
        build(&mut plan)?;
        let delivery = delivery::Plan::classify(route, &plan.events, driver.pid_delivery())
            .map_err(|_| refuse("foreground_required"))?;
        driver
            .prepare(delivery.route, delivery.events)
            .map_err(|message| explain("unsupported_action", message))?;
        inject(driver, held, delivery.route, delivery.events)
    }
}

/// Fires `events` in order, tracking what stays down in `kept` across
/// requests; on the first failure releases, in reverse, every button and
/// key this request pressed and has not released.
fn inject(
    driver: &mut dyn Driver,
    kept: &mut Vec<(Route, Event)>,
    route: Route,
    events: &[Event],
) -> Result<(), Refusal> {
    let mut held: Vec<(Route, Event)> = Vec::new();
    for event in events {
        if let Err(error) = delivery::post(driver, route, event) {
            let stuck = held
                .iter()
                .rev()
                .filter(|(_, release)| {
                    let failed = delivery::post(driver, route, release).is_err();
                    if !failed {
                        track(kept, route, release);
                    }
                    failed
                })
                .count();
            let message = match stuck {
                0 => format!("input driver failed: {error}"),
                stuck => format!("input driver failed: {error}; {stuck} held inputs not released"),
            };
            return Err(explain("input_failed", message));
        }
        track(&mut held, route, event);
        track(kept, route, event);
    }
    Ok(())
}

fn route(
    screen: &Screen,
    foreground: bool,
    target: Option<crate::screen::observe::Target>,
) -> Result<Route, Refusal> {
    if foreground {
        return Ok(Route::Foreground);
    }
    let target = target.ok_or_else(|| refuse("foreground_required"))?;
    let (window, _) = screen.window_target(target).map_err(|error| Refusal {
        reason: error.reason(),
        message: error.message(),
    })?;
    Ok(Route::Background(window.pid))
}

/// Folds one injected event into a held set of pending releases.
fn track(held: &mut Vec<(Route, Event)>, route: Route, event: &Event) {
    let (release, down) = match event {
        Event::Button {
            button,
            down,
            click,
        } => (
            Event::Button {
                button: *button,
                down: false,
                click: *click,
            },
            *down,
        ),
        Event::Key { key, down } => (
            Event::Key {
                key: *key,
                down: false,
            },
            *down,
        ),
        _ => return,
    };
    held.retain(|(at, pressed)| *at != route || *pressed != release);
    if down {
        held.push((route, release));
    }
}
