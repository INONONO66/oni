//! Bounded pasteboard reads and lease-local restoration. The fixture and native
//! backend share the same ownership and change-count decisions.

#[cfg(target_os = "macos")]
mod native;

use std::sync::{Mutex, PoisonError};

use base64::{engine::general_purpose::STANDARD, Engine};
use oni_protocol::{ClipboardReadRequest, ClipboardWriteRequest};
use serde_json::{json, Value};

const MAX_BYTES: usize = 4_194_304;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub format: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contents {
    pub change_count: u64,
    pub entries: Vec<Entry>,
}

pub trait Source: Send {
    fn snapshot(&mut self) -> Result<Contents, &'static str>;
    fn replace(&mut self, entries: &[Entry]) -> Result<u64, &'static str>;
    fn change_count(&mut self) -> u64;
}

pub struct Clipboard {
    state: Mutex<State>,
}

struct State {
    source: Box<dyn Source>,
    saved: Option<Contents>,
    written_count: Option<u64>,
    observed_count: Option<u64>,
    human_edge: bool,
}

impl Clipboard {
    pub fn new(source: Box<dyn Source>) -> Self {
        Self {
            state: Mutex::new(State {
                source,
                saved: None,
                written_count: None,
                observed_count: None,
                human_edge: false,
            }),
        }
    }

    #[cfg(target_os = "macos")]
    pub fn native() -> Self {
        Self::new(Box::new(native::Native))
    }

    #[cfg(not(target_os = "macos"))]
    pub fn absent() -> Self {
        Self::new(Box::new(Absent))
    }

    pub fn read(&self, request: &ClipboardReadRequest) -> Value {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let contents = match state.observe() {
            Ok(contents) => contents,
            Err(reason) => return json!({"status":"refused","reason":reason}),
        };
        let wanted = request.formats.as_deref();
        let mut result = json!({"status":"ok","changeCount":contents.change_count});
        for entry in &contents.entries {
            let name = match entry.format.as_str() {
                "public.utf8-plain-text" => "text",
                "public.html" => "html",
                "public.png" => "image",
                _ => continue,
            };
            if wanted
                .is_some_and(|formats| !formats.iter().any(|format| format.to_string() == name))
            {
                continue;
            }
            if name == "image" {
                result[name] = json!(STANDARD.encode(&entry.data));
            } else if let Ok(text) = std::str::from_utf8(&entry.data) {
                result[name] = json!(text);
            }
        }
        result
    }

    pub fn write(&self, request: &ClipboardWriteRequest) -> Value {
        let entry = match serde_json::to_value(request) {
            Ok(Value::Object(fields)) => {
                let Some((name, Value::String(value))) = fields.into_iter().next() else {
                    return json!({"status":"refused","reason":"clipboard_not_available"});
                };
                let (format, data) = match name.as_str() {
                    "text" => ("public.utf8-plain-text", value.into_bytes()),
                    "html" => ("public.html", value.into_bytes()),
                    "image" => match STANDARD.decode(value) {
                        Ok(data) => ("public.png", data),
                        Err(_) => {
                            return json!({"status":"refused","reason":"clipboard_not_available"})
                        }
                    },
                    _ => return json!({"status":"refused","reason":"clipboard_not_available"}),
                };
                Entry {
                    format: format.to_owned(),
                    data,
                }
            }
            _ => return json!({"status":"refused","reason":"clipboard_not_available"}),
        };
        if entry.data.len() > MAX_BYTES {
            return json!({"status":"refused","reason":"clipboard_too_large"});
        }
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let current = match state.observe() {
            Ok(contents) => contents,
            Err(reason) => return json!({"status":"refused","reason":reason}),
        };
        let previous = state.saved.clone().unwrap_or_else(|| current.clone());
        let count = match state.source.replace(std::slice::from_ref(&entry)) {
            Ok(count) => count,
            Err(reason) => return json!({"status":"refused","reason":reason}),
        };
        state.saved = if previous.entries == [entry] {
            None
        } else {
            Some(previous.clone())
        };
        state.written_count = Some(count);
        state.observed_count = Some(count);
        json!({
            "status":"ok","changeCount":count,
            "previous":{
                "changeCount":current.change_count,
                "formats":current.entries.iter().map(|item| &item.format).collect::<Vec<_>>(),
                "bytes":current.entries.iter().map(|item| item.data.len()).sum::<usize>()
            }
        })
    }

    pub fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let current_count = state.source.change_count();
        let should_restore = state.written_count == Some(current_count);
        if let Some(previous) = state.saved.take() {
            if should_restore {
                let _restored = state.source.replace(&previous.entries);
            }
        }
        state.written_count = None;
        state.observed_count = None;
    }

    pub fn take_human_edge(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        std::mem::take(&mut state.human_edge)
    }
}

impl State {
    fn observe(&mut self) -> Result<Contents, &'static str> {
        let contents = self.source.snapshot()?;
        if contents
            .entries
            .iter()
            .map(|entry| entry.data.len())
            .sum::<usize>()
            > MAX_BYTES
        {
            return Err("clipboard_too_large");
        }
        if self
            .observed_count
            .is_some_and(|count| count != contents.change_count)
        {
            self.human_edge = true;
            self.saved = None;
            self.written_count = None;
        }
        self.observed_count = Some(contents.change_count);
        Ok(contents)
    }
}

#[cfg(not(target_os = "macos"))]
struct Absent;

#[cfg(not(target_os = "macos"))]
impl Source for Absent {
    fn snapshot(&mut self) -> Result<Contents, &'static str> {
        Err("clipboard_not_available")
    }
    fn replace(&mut self, _entries: &[Entry]) -> Result<u64, &'static str> {
        Err("clipboard_not_available")
    }
    fn change_count(&mut self) -> u64 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oni_protocol::decode;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Fixture(Arc<Mutex<Contents>>);
    impl Source for Fixture {
        fn snapshot(&mut self) -> Result<Contents, &'static str> {
            Ok(self.0.lock().expect("fixture").clone())
        }
        fn replace(&mut self, entries: &[Entry]) -> Result<u64, &'static str> {
            let mut contents = self.0.lock().expect("fixture");
            contents.change_count += 1;
            contents.entries = entries.to_vec();
            Ok(contents.change_count)
        }
        fn change_count(&mut self) -> u64 {
            self.0.lock().expect("fixture").change_count
        }
    }
    fn fixture() -> (Clipboard, Arc<Mutex<Contents>>) {
        let contents = Arc::new(Mutex::new(Contents {
            change_count: 1,
            entries: vec![Entry {
                format: "public.utf8-plain-text".into(),
                data: b"personal".to_vec(),
            }],
        }));
        (
            Clipboard::new(Box::new(Fixture(contents.clone()))),
            contents,
        )
    }

    #[test]
    fn read_write_restore_lease_round_trip() {
        let (clipboard, contents) = fixture();
        let request = decode::<ClipboardReadRequest>(json!({"formats":["text"]})).expect("request");
        assert_eq!(
            clipboard.read(&request),
            json!({"status":"ok","text":"personal","changeCount":1})
        );
        let write = decode::<ClipboardWriteRequest>(json!({"text":"agent"})).expect("write");
        assert_eq!(
            clipboard.write(&write),
            json!({"status":"ok","changeCount":2,
            "previous":{"changeCount":1,"formats":["public.utf8-plain-text"],"bytes":8}})
        );
        assert_eq!(clipboard.read(&request)["text"], "agent");
        clipboard.close();
        assert_eq!(
            contents.lock().expect("fixture").entries[0].data,
            b"personal"
        );
    }

    #[test]
    fn human_change_prevents_restore_and_reports_edge() {
        let (clipboard, contents) = fixture();
        let write = decode::<ClipboardWriteRequest>(json!({"text":"agent"})).expect("write");
        clipboard.write(&write);
        {
            let mut current = contents.lock().expect("fixture");
            current.change_count += 1;
            current.entries[0].data = b"human".to_vec();
        }
        let read = decode::<ClipboardReadRequest>(json!({})).expect("read");
        assert_eq!(clipboard.read(&read)["text"], "human");
        assert!(clipboard.take_human_edge());
        clipboard.close();
        assert_eq!(contents.lock().expect("fixture").entries[0].data, b"human");
    }

    #[test]
    fn agent_writing_original_contents_clears_restore() {
        let (clipboard, contents) = fixture();
        clipboard.write(&decode::<ClipboardWriteRequest>(json!({"text":"agent"})).expect("write"));
        clipboard
            .write(&decode::<ClipboardWriteRequest>(json!({"text":"personal"})).expect("write"));
        clipboard.close();
        assert_eq!(contents.lock().expect("fixture").change_count, 3);
    }

    #[test]
    fn oversized_contents_refuse_without_writing() {
        let (clipboard, contents) = fixture();
        contents.lock().expect("fixture").entries[0].data = vec![b'x'; MAX_BYTES + 1];
        let read = decode::<ClipboardReadRequest>(json!({})).expect("read");
        assert_eq!(
            clipboard.read(&read),
            json!({"status":"refused","reason":"clipboard_too_large"})
        );
        let write = decode::<ClipboardWriteRequest>(json!({"text":"agent"})).expect("write");
        assert_eq!(
            clipboard.write(&write),
            json!({"status":"refused","reason":"clipboard_too_large"})
        );
        assert_eq!(contents.lock().expect("fixture").change_count, 1);
    }
}
