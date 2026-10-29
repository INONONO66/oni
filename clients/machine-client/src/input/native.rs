//! The native driver over enigo: CGEvents on macOS behind the Accessibility
//! grant (re-checked before every request, so a revoked grant refuses
//! `permission_denied`), XTEST over a pure-Rust X11 connection on Linux.
//! The mapping is generic over enigo's traits so it is tested without
//! firing real input.

use enigo::{Axis, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};

use super::{Button, Driver, Event, Key, Named};

pub struct Native<E>(pub E);

/// Connects without prompting: the Owner grants Accessibility explicitly.
pub fn open() -> Result<Native<Enigo>, String> {
    let settings = Settings {
        open_prompt_to_get_permissions: false,
        ..Settings::default()
    };
    Enigo::new(&settings)
        .map(Native)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn permitted() -> bool {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    // SAFETY: a parameterless read of the process's Accessibility trust.
    unsafe { AXIsProcessTrusted() }
}

/// X11 has no injection permission beyond the display connection itself.
#[cfg(target_os = "linux")]
fn permitted() -> bool {
    true
}

fn button(button: Button) -> enigo::Button {
    match button {
        Button::Left => enigo::Button::Left,
        Button::Right => enigo::Button::Right,
        Button::Middle => enigo::Button::Middle,
    }
}

const FUNCTION: [enigo::Key; 12] = [
    enigo::Key::F1,
    enigo::Key::F2,
    enigo::Key::F3,
    enigo::Key::F4,
    enigo::Key::F5,
    enigo::Key::F6,
    enigo::Key::F7,
    enigo::Key::F8,
    enigo::Key::F9,
    enigo::Key::F10,
    enigo::Key::F11,
    enigo::Key::F12,
];

/// Every [`Named`] key but the function keys, as data.
const NAMED: [(Named, enigo::Key); 19] = [
    (Named::Enter, enigo::Key::Return),
    (Named::Tab, enigo::Key::Tab),
    (Named::Escape, enigo::Key::Escape),
    (Named::Backspace, enigo::Key::Backspace),
    (Named::Delete, enigo::Key::Delete),
    (Named::Space, enigo::Key::Space),
    (Named::ArrowUp, enigo::Key::UpArrow),
    (Named::ArrowDown, enigo::Key::DownArrow),
    (Named::ArrowLeft, enigo::Key::LeftArrow),
    (Named::ArrowRight, enigo::Key::RightArrow),
    (Named::Home, enigo::Key::Home),
    (Named::End, enigo::Key::End),
    (Named::PageUp, enigo::Key::PageUp),
    (Named::PageDown, enigo::Key::PageDown),
    (Named::CapsLock, enigo::Key::CapsLock),
    (Named::Shift, enigo::Key::Shift),
    (Named::Control, enigo::Key::Control),
    (Named::Alt, enigo::Key::Alt),
    (Named::Meta, enigo::Key::Meta),
];

/// The enigo key for `key`; `None` only for a named key missing from
/// [`NAMED`], which the driver refuses instead of pressing another key.
pub fn key(key: Key) -> Option<enigo::Key> {
    match key {
        Key::Char(character) => Some(enigo::Key::Unicode(character)),
        Key::Named(Named::F(number)) => Some(FUNCTION[usize::from(number.clamp(1, 12)) - 1]),
        Key::Named(named) => NAMED
            .iter()
            .find(|(entry, _)| *entry == named)
            .map(|&(_, mapped)| mapped),
    }
}

fn direction(down: bool) -> Direction {
    if down {
        Direction::Press
    } else {
        Direction::Release
    }
}

impl<E: Mouse + Keyboard + Send> Driver for Native<E> {
    fn permitted(&self) -> bool {
        permitted()
    }

    fn inject(&mut self, event: &Event) -> Result<(), String> {
        let done = match event {
            Event::Move { x, y, .. } => self.0.move_mouse(*x, *y, Coordinate::Abs),
            Event::Button { button: b, down } => self.0.button(button(*b), direction(*down)),
            Event::Scroll { horizontal, delta } => {
                let axis = if *horizontal {
                    Axis::Horizontal
                } else {
                    Axis::Vertical
                };
                self.0.scroll(*delta, axis)
            }
            Event::Key { key: k, down } => {
                let mapped = key(*k).ok_or("named key missing from the native table")?;
                self.0.key(mapped, direction(*down))
            }
            Event::Text(text) => self.0.text(text),
        };
        done.map_err(|error| error.to_string())
    }
}
