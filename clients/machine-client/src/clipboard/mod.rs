//! Bounded pasteboard reads and lease-local restoration. The fixture and native
//! backend share the same ownership and change-count decisions.

pub mod fixture;
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

    /// The pasteboard this machine can reach: the native one on macOS and
    /// an absent one everywhere else.
    pub fn local() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::new(Box::new(native::Native))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Self::absent()
        }
    }

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
        let (format, data) = match request {
            ClipboardWriteRequest::Text(text) => {
                ("public.utf8-plain-text", text.as_bytes().to_vec())
            }
            ClipboardWriteRequest::Html(html) => ("public.html", html.as_bytes().to_vec()),
            ClipboardWriteRequest::Image(image) => match STANDARD.decode(image.as_bytes()) {
                Ok(data) => ("public.png", data),
                Err(_) => return json!({"status":"refused","reason":"clipboard_not_available"}),
            },
        };
        let entry = Entry {
            format: format.to_owned(),
            data,
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

struct Absent;

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

    fn fixture() -> (Clipboard, Arc<Mutex<Contents>>) {
        let contents = fixture::text("personal");
        (
            Clipboard::new(Box::new(fixture::Fixture(contents.clone()))),
            contents,
        )
    }

    struct ReadOnly;
    impl Source for ReadOnly {
        fn snapshot(&mut self) -> Result<Contents, &'static str> {
            Ok(Contents {
                change_count: 1,
                entries: vec![],
            })
        }
        fn replace(&mut self, _entries: &[Entry]) -> Result<u64, &'static str> {
            Err("clipboard_not_available")
        }
        fn change_count(&mut self) -> u64 {
            1
        }
    }

    fn entry(format: &str, data: &[u8]) -> Entry {
        Entry {
            format: format.into(),
            data: data.to_vec(),
        }
    }

    #[test]
    fn read_reports_every_known_format_and_filters_on_request() {
        let (clipboard, contents) = fixture();
        contents.lock().expect("fixture").entries = vec![
            entry("public.utf8-plain-text", b"plain"),
            entry("public.html", b"<b>rich</b>"),
            entry("public.png", &[0x89, b'P', b'N', b'G']),
            entry("com.example.private", b"opaque"),
        ];
        let everything = decode::<ClipboardReadRequest>(json!({})).expect("read");
        assert_eq!(
            clipboard.read(&everything),
            json!({"status":"ok","changeCount":1,"text":"plain","html":"<b>rich</b>","image":"iVBORw=="})
        );
        let html = decode::<ClipboardReadRequest>(json!({"formats":["html"]})).expect("read");
        assert_eq!(
            clipboard.read(&html),
            json!({"status":"ok","changeCount":1,"html":"<b>rich</b>"})
        );
    }

    #[test]
    fn write_places_html_and_png_entries_and_refuses_bad_base64() {
        let (clipboard, contents) = fixture();
        let html = decode::<ClipboardWriteRequest>(json!({"html":"<i>x</i>"})).expect("html");
        assert_eq!(clipboard.write(&html)["status"], "ok");
        let image = decode::<ClipboardWriteRequest>(json!({"image":"iVBORw=="})).expect("image");
        assert_eq!(clipboard.write(&image)["status"], "ok");
        assert_eq!(
            contents.lock().expect("fixture").entries,
            [entry("public.png", &[0x89, b'P', b'N', b'G'])]
        );
        let bad = decode::<ClipboardWriteRequest>(json!({"image":"AB=="})).expect("shape");
        assert_eq!(
            clipboard.write(&bad),
            json!({"status":"refused","reason":"clipboard_not_available"})
        );
        assert_eq!(contents.lock().expect("fixture").change_count, 3);
    }

    #[test]
    fn write_refuses_oversized_entries_and_sources_that_cannot_replace() {
        let (clipboard, contents) = fixture();
        let huge = "é".repeat(MAX_BYTES / 2 + 1);
        let write = decode::<ClipboardWriteRequest>(json!({"text":huge})).expect("write");
        assert_eq!(
            clipboard.write(&write),
            json!({"status":"refused","reason":"clipboard_too_large"})
        );
        assert_eq!(contents.lock().expect("fixture").change_count, 1);
        let read_only = Clipboard::new(Box::new(ReadOnly));
        let write = decode::<ClipboardWriteRequest>(json!({"text":"agent"})).expect("write");
        assert_eq!(
            read_only.write(&write),
            json!({"status":"refused","reason":"clipboard_not_available"})
        );
        read_only.close();
        assert!(!read_only.take_human_edge());
    }

    #[test]
    fn absent_source_refuses_every_operation() {
        let mut absent = Absent;
        assert_eq!(absent.snapshot(), Err("clipboard_not_available"));
        assert_eq!(absent.replace(&[]), Err("clipboard_not_available"));
        assert_eq!(absent.change_count(), 0);
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
