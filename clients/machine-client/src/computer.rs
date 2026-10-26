//! The explicit headless computer backends: an optional `computer` block in
//! `client.json` names a fixture frame layout (served by the scripted
//! fixture screen) and a recorder file (where injected input lands as JSON
//! lines) instead of the platform backends, so a display-less machine (CI,
//! the conformance harness) drives the built client's capture, input and
//! stream paths end to end. Without the block the platform backends are used;
//! a block whose layout is missing or invalid refuses startup.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    input::{Button, Driver, Event, Input, Key, Named},
    screen::{fixture::Fixture, Display, Screen, Window, CAPTURES},
};

#[derive(Debug, thiserror::Error)]
pub enum ComputerError {
    #[error("computer_layout_missing: {}", .0.display())]
    LayoutMissing(PathBuf),
    #[error("computer_layout_invalid: {0}")]
    LayoutInvalid(String),
    #[error("computer_config_invalid: {0}")]
    Config(String),
}

/// The part of `client.json` this module reads; every other key is the
/// attachment config's.
#[derive(Debug, Deserialize)]
struct ClientFile {
    #[serde(default)]
    computer: Option<Block>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Block {
    layout: PathBuf,
    recorder: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Layout {
    displays: Vec<DisplayRow>,
    #[serde(default)]
    windows: Vec<WindowRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisplayRow {
    id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f32,
    primary: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowRow {
    id: u32,
    display: u32,
    title: String,
    owner: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// The fixture screen and recorder input the `computer` block of the
/// `client.json` at `path` names, or `None` when the block is absent.
/// Relative paths resolve against the directory holding `client.json`.
pub fn open(path: &Path) -> Result<Option<(Screen, Input)>, ComputerError> {
    let text = fs::read(path).map_err(|error| ComputerError::Config(error.to_string()))?;
    let file: ClientFile =
        serde_json::from_slice(&text).map_err(|error| ComputerError::Config(error.to_string()))?;
    let Some(block) = file.computer else {
        return Ok(None);
    };
    let directory = path.parent().unwrap_or(Path::new(""));
    let layout_path = directory.join(&block.layout);
    let layout = match fs::read(&layout_path) {
        Ok(layout) => layout,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(ComputerError::LayoutMissing(layout_path))
        }
        Err(error) => return Err(ComputerError::LayoutInvalid(error.to_string())),
    };
    let layout: Layout = serde_json::from_slice(&layout)
        .map_err(|error| ComputerError::LayoutInvalid(error.to_string()))?;
    if !layout.displays.iter().any(|row| row.primary) {
        return Err(ComputerError::LayoutInvalid(
            "the layout has no primary display".to_owned(),
        ));
    }
    let fixture = Fixture {
        displays: layout.displays.into_iter().map(display).collect(),
        windows: layout.windows.into_iter().map(window).collect(),
        ..Fixture::default()
    };
    Ok(Some((
        Screen::new(Box::new(fixture), CAPTURES),
        Input::new(Recorder(directory.join(block.recorder))),
    )))
}

fn display(row: DisplayRow) -> Display {
    Display {
        id: row.id,
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height,
        scale: row.scale,
        primary: row.primary,
    }
}

fn window(row: WindowRow) -> Window {
    Window {
        id: row.id,
        display: row.display,
        title: row.title,
        owner: row.owner,
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height,
    }
}

/// Appends every injected event as one JSON line instead of moving a real
/// pointer; a recorder that cannot be written refuses the event.
#[derive(Debug)]
pub struct Recorder(pub PathBuf);

impl Driver for Recorder {
    fn permitted(&self) -> bool {
        true
    }

    fn inject(&mut self, event: &Event) -> Result<(), String> {
        let mut line = record(event).to_string();
        line.push('\n');
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.0)
            .and_then(|mut file| file.write_all(line.as_bytes()))
            .map_err(|error| error.to_string())
    }
}

pub fn record(event: &Event) -> Value {
    match event {
        Event::Move { x, y } => json!({ "event": "move", "x": x, "y": y }),
        Event::Button { button, down } => {
            json!({ "event": "button", "button": button_name(*button), "down": down })
        }
        Event::Scroll { horizontal, delta } => {
            json!({ "event": "scroll", "horizontal": horizontal, "delta": delta })
        }
        Event::Key { key, down } => json!({ "event": "key", "key": key_name(*key), "down": down }),
        Event::Text(text) => json!({ "event": "text", "text": text }),
    }
}

fn button_name(button: Button) -> &'static str {
    match button {
        Button::Left => "left",
        Button::Right => "right",
        Button::Middle => "middle",
    }
}

fn key_name(key: Key) -> String {
    match key {
        Key::Char(character) => character.to_string(),
        Key::Named(Named::F(number)) => format!("F{number}"),
        Key::Named(named) => format!("{named:?}"),
    }
}
