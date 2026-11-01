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
    screen::{
        ax::fixture::ScriptedNotifications,
        ax::{
            fixture::{Element, Scripted},
            AppIdentity,
        },
        fixture::Fixture,
        Display, Screen, Window, CAPTURES,
    },
};

#[derive(Debug, thiserror::Error)]
pub enum ComputerError {
    #[error("computer_layout_missing: {}", .0.display())]
    LayoutMissing(PathBuf),
    #[error("computer_layout_invalid: {0}")]
    LayoutInvalid(String),
    #[error("computer_config_invalid: {0}")]
    Config(String),
    #[cfg(target_os = "linux")]
    #[error(transparent)]
    Display(#[from] crate::display::xvfb::Error),
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
    layout: Option<PathBuf>,
    recorder: Option<PathBuf>,
    #[serde(default)]
    excluded_owners: Vec<String>,
    #[cfg(target_os = "linux")]
    display: Option<crate::display::xvfb::Config>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Layout {
    displays: Vec<DisplayRow>,
    #[serde(default)]
    windows: Vec<WindowRow>,
    #[serde(rename = "apps", default)]
    _apps: Vec<crate::app::fixture::App>,
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
    pid: Option<u32>,
    app: Option<AppIdentity>,
    #[serde(rename = "epoch", default)]
    _epoch: u64,
    #[serde(rename = "elements", default)]
    _elements: Vec<Element>,
    #[serde(default)]
    blank: bool,
    #[serde(rename = "minimized", default)]
    _minimized: bool,
    #[serde(rename = "timeline", default)]
    _timeline: Vec<serde_json::Value>,
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
    #[cfg(target_os = "linux")]
    if let Some(display) = &block.display {
        if block.layout.is_some() || block.recorder.is_some() {
            return Err(ComputerError::Config(
                "virtual display cannot use a fixture layout".into(),
            ));
        }
        let owned = crate::display::xvfb::open(display)?;
        let id = owned.id.clone();
        let screen = Screen::platform_on(Some(&id));
        return virtual_pair(owned, screen, block.excluded_owners).map(Some);
    }
    let (layout, recorder) = match (block.layout, block.recorder) {
        (None, None) => {
            let (screen, input) = platform();
            return Ok(Some((screen.excluding(block.excluded_owners), input)));
        }
        (Some(layout), Some(recorder)) => (layout, recorder),
        _ => {
            return Err(ComputerError::Config(
                "layout and recorder must be specified together".into(),
            ))
        }
    };
    let directory = path.parent().unwrap_or(Path::new(""));
    let layout_path = directory.join(&layout);
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
    let blank_windows = layout
        .windows
        .iter()
        .filter(|window| window.blank)
        .map(|window| window.id)
        .collect();
    let fixture = Fixture {
        displays: layout.displays.into_iter().map(display).collect(),
        windows: layout.windows.into_iter().map(window).collect(),
        blank_windows,
        ..Fixture::default()
    };
    let recorder = directory.join(recorder);
    let observer = Scripted {
        layout: layout_path.clone(),
        recorder: recorder.clone(),
    };
    Ok(Some((
        Screen::new(Box::new(fixture), CAPTURES)
            .observing(Box::new(observer))
            .notifying(Box::new(ScriptedNotifications {
                layout: layout_path.clone(),
            }))
            .launching(Box::new(crate::app::fixture::Scripted {
                layout: layout_path,
                recorder: recorder.clone(),
            }))
            .excluding(block.excluded_owners),
        Input::new(Recorder(recorder)),
    )))
}

#[cfg(target_os = "linux")]
fn virtual_pair(
    owned: crate::display::xvfb::Owned,
    screen: Screen,
    excluded_owners: Vec<String>,
) -> Result<(Screen, Input), ComputerError> {
    if !screen.available() {
        return Err(crate::display::Error::Unavailable.into());
    }
    let input = Input::platform_on(Some(&owned.id));
    Ok((screen.virtualizing(owned).excluding(excluded_owners), input))
}

#[cfg(all(test, target_os = "linux"))]
mod virtual_tests {
    use super::*;

    #[test]
    fn missing_capture_after_display_start_refuses_the_pair() {
        let config = crate::display::Config {
            kind: "xvfb".into(),
            width: 32,
            height: 24,
            dpi: 96,
            window_manager: Some(crate::display::Manager {
                path: "/bin/true".into(),
                args: vec![],
            }),
        };
        let owned = crate::display::xvfb::open(&config).expect("display");
        assert!(matches!(
            virtual_pair(owned, Screen::absent(), vec![]),
            Err(ComputerError::Display(_))
        ));
        let owned = crate::display::xvfb::open(&config).expect("display");
        let id = owned.id.clone();
        let screen = Screen::platform_on(Some(&id));
        let (screen, input) = virtual_pair(owned, screen, vec![]).expect("native pair");
        assert_eq!(screen.virtual_display().expect("owned display").0, id);
        assert!(screen.available() && input.ready());
    }
}

pub fn platform() -> (Screen, Input) {
    #[cfg(target_os = "linux")]
    {
        let display =
            crate::screen::probe::linux_display(&crate::screen::probe::linux::System, None);
        let input = Input::platform_selected(display.as_deref());
        (Screen::platform_selected(display), input)
    }
    #[cfg(not(target_os = "linux"))]
    {
        (Screen::platform(), Input::platform())
    }
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
        pid: row.pid,
        app: row.app,
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
    fn pid_delivery(&self) -> bool {
        true
    }
    fn pointer_pid_delivery(&self) -> bool {
        true
    }

    fn post_to_pid(&mut self, pid: u32, event: &Event) -> Result<(), String> {
        let mut line = record(event);
        line["delivery"] = json!("background");
        line["pid"] = json!(pid);
        append(&self.0, &line).map_err(|error| error.to_string())
    }

    fn permitted(&self) -> bool {
        true
    }

    fn inject(&mut self, event: &Event) -> Result<(), String> {
        append(&self.0, &record(event)).map_err(|error| error.to_string())
    }
}

/// Appends `line` and a newline to the recorder file at `path`.
pub fn append(path: &Path, line: &Value) -> io::Result<()> {
    let mut text = line.to_string();
    text.push('\n');
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
}

pub fn record(event: &Event) -> Value {
    let mut line = match event {
        Event::Move {
            x,
            y,
            reference: None,
        } => json!({ "event": "move", "x": x, "y": y }),
        Event::Move {
            x,
            y,
            reference: Some(reference),
        } => json!({ "event": "move", "x": x, "y": y, "ref": reference }),
        Event::Button { button, down, .. } => {
            json!({ "event": "button", "button": button_name(*button), "down": down })
        }
        Event::Scroll { horizontal, delta } => {
            json!({ "event": "scroll", "horizontal": horizontal, "delta": delta })
        }
        Event::Key { key, down } => json!({ "event": "key", "key": key_name(*key), "down": down }),
        Event::Text(text) => json!({ "event": "text", "text": text }),
    };
    line["delivery"] = json!("foreground");
    line["pid"] = Value::Null;
    line["tag"] = json!(true);
    line
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
