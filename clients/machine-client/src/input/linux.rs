//! XTEST over the selected, authenticated X11 connection.

use std::collections::{HashMap, HashSet, VecDeque};
use x11rb::{
    connection::Connection,
    protocol::{xproto::ConnectionExt, xtest::ConnectionExt as _},
};

use super::{Button, Driver, Event, Key, Named};

fn failed(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub fn open_on(display: Option<&str>) -> Result<Xtest, String> {
    let (connection, index) = crate::screen::probe::x11::connection(display).map_err(failed)?;
    connection
        .xtest_get_version(2, 2)
        .map_err(failed)?
        .reply()
        .map_err(failed)?;
    let setup = connection.setup();
    let root = setup.roots[index].root;
    let first = setup.min_keycode;
    let mapping = connection
        .get_keyboard_mapping(first, setup.max_keycode - first + 1)
        .map_err(failed)?
        .reply()
        .map_err(failed)?;
    let mut keys = HashMap::new();
    let mut free = VecDeque::new();
    let mut slots = HashMap::new();
    for (code, symbols) in (first..=setup.max_keycode).zip(
        mapping
            .keysyms
            .chunks(usize::from(mapping.keysyms_per_keycode)),
    ) {
        if symbols.iter().all(|symbol| *symbol == 0) {
            free.push_back(code);
            slots.insert(
                code,
                Mapping {
                    original: symbols.to_vec(),
                    symbol: None,
                },
            );
        } else {
            keys.insert(symbols[0], code);
        }
    }
    Ok(Xtest {
        connection,
        root,
        mapping_width: mapping.keysyms_per_keycode,
        keys,
        held: HashMap::new(),
        free,
        slots,
    })
}

/// Uses the same authenticated connection path as capture, without mutating
/// process-global XAUTHORITY while other client work is running.
pub struct Xtest {
    connection: crate::screen::probe::x11::Connection,
    root: u32,
    mapping_width: u8,
    keys: HashMap<u32, u8>,
    held: HashMap<u32, u8>,
    free: VecDeque<u8>,
    slots: HashMap<u8, Mapping>,
}

struct Mapping {
    original: Vec<u32>,
    symbol: Option<u32>,
}

impl Xtest {
    fn post(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), String> {
        self.connection
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)
            .map_err(failed)?
            .check()
            .map_err(failed)
    }
    fn mapped(&self, symbol: u32, excluded: Option<u8>) -> Option<u8> {
        if let Some(code) = self
            .keys
            .get(&symbol)
            .filter(|code| Some(**code) != excluded)
        {
            return Some(*code);
        }
        self.slots.iter().find_map(|(&code, slot)| {
            (Some(code) != excluded && slot.symbol == Some(symbol)).then_some(code)
        })
    }

    fn keycode(&mut self, symbol: u32, excluded: Option<u8>) -> Result<u8, String> {
        if let Some(code) = self.mapped(symbol, excluded) {
            return Ok(code);
        }
        let code = *self.free.front().ok_or("X11 has no unused keycodes")?;
        self.connection
            .change_keyboard_mapping(1, code, 2, &[symbol, symbol])
            .map_err(failed)?
            .check()
            .map_err(failed)?;
        self.free.pop_front();
        if let Some(slot) = self.slots.get_mut(&code) {
            slot.symbol = Some(symbol);
        }
        if excluded.is_none() {
            self.keys.insert(symbol, code);
        }
        Ok(code)
    }

    fn key_event(&mut self, key: Key, down: bool) -> Result<(), String> {
        let mapped = self::key(key).ok_or("named key missing from the native table")?;
        let symbol = xkeysym::Keysym::from(mapped).raw();
        let code = match self.held.get(&symbol) {
            Some(code) => *code,
            None => self.keycode(symbol, None)?,
        };
        self.post(if down { 2 } else { 3 }, code, 0, 0)?;
        if down {
            self.held.insert(symbol, code);
        } else {
            self.held.remove(&symbol);
        }
        Ok(())
    }

    fn text(&mut self, text: &str) -> Result<(), String> {
        // Key events contain codes, not symbols. Even a server round trip does
        // not acknowledge application consumption, so never recycle a mapping.
        // Check capacity before changing mappings or emitting any event.
        let symbols: HashSet<_> = text
            .chars()
            .map(|c| xkeysym::Keysym::from_char(c).raw())
            .collect();
        let needed = symbols
            .iter()
            .filter(|&&symbol| {
                self.mapped(symbol, self.held.get(&symbol).copied())
                    .is_none()
            })
            .count();
        if needed > self.free.len() {
            return Err("X11 has no unused keycodes".into());
        }
        let mut codes = HashMap::new();
        for symbol in symbols {
            codes.insert(
                symbol,
                self.keycode(symbol, self.held.get(&symbol).copied())?,
            );
        }
        for character in text.chars() {
            let code = codes[&xkeysym::Keysym::from_char(character).raw()];
            self.post(2, code, 0, 0)?;
            self.post(3, code, 0, 0)?;
        }
        Ok(())
    }

    fn scroll(&self, horizontal: bool, delta: i32) -> Result<(), String> {
        let detail = match (horizontal, delta > 0) {
            (false, false) => 4,
            (false, true) => 5,
            (true, false) => 6,
            (true, true) => 7,
        };
        for _ in 0..delta.unsigned_abs() {
            self.post(4, detail, 0, 0)?;
            self.post(5, detail, 0, 0)?;
        }
        Ok(())
    }
}

impl Drop for Xtest {
    fn drop(&mut self) {
        for (code, slot) in &self.slots {
            if slot.symbol.is_none() {
                continue;
            }
            if let Err(error) = self
                .connection
                .change_keyboard_mapping(1, *code, self.mapping_width, &slot.original)
                .map_err(failed)
                .and_then(|cookie| cookie.check().map_err(failed))
            {
                eprintln!("X11 keymap restore: {error}");
            }
        }
    }
}

impl Driver for Xtest {
    fn pid_delivery(&self) -> bool {
        false
    }
    fn post_to_pid(&mut self, _: u32, _: &Event) -> Result<(), String> {
        Err("pid delivery is unavailable".into())
    }
    fn permitted(&self) -> bool {
        self.connection
            .get_input_focus()
            .is_ok_and(|cookie| cookie.reply().is_ok())
    }
    fn inject(&mut self, event: &Event) -> Result<(), String> {
        match event {
            Event::Move { x, y, .. } => self.post(
                6,
                0,
                i16::try_from(*x).map_err(failed)?,
                i16::try_from(*y).map_err(failed)?,
            ),
            Event::Button { button, down, .. } => self.post(
                if *down { 4 } else { 5 },
                match button {
                    Button::Left => 1,
                    Button::Middle => 2,
                    Button::Right => 3,
                },
                0,
                0,
            ),
            Event::Scroll { horizontal, delta } => self.scroll(*horizontal, *delta),
            Event::Key { key, down } => self.key_event(*key, *down),
            Event::Text(text) => self.text(text),
        }
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
