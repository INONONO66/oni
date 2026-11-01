//! General macOS pasteboard access; all ownership decisions live in the parent.

use objc2_app_kit::NSPasteboard;
use objc2_foundation::{NSData, NSString};

use super::{Contents, Entry, Source, MAX_BYTES};

pub struct Native;

impl Source for Native {
    fn snapshot(&mut self) -> Result<Contents, &'static str> {
        let board = NSPasteboard::generalPasteboard();
        let count = u64::try_from(board.changeCount()).map_err(|_| "clipboard_not_available")?;
        let mut entries = Vec::new();
        let mut bytes = 0;
        if let Some(types) = board.types() {
            for format in types.iter() {
                if let Some(data) = board.dataForType(&format) {
                    bytes += data.len();
                    if bytes > MAX_BYTES {
                        return Err("clipboard_too_large");
                    }
                    entries.push(Entry {
                        format: format.to_string(),
                        data: data.to_vec(),
                    });
                }
            }
        }
        if u64::try_from(board.changeCount()).ok() != Some(count) {
            return Err("clipboard_not_available");
        }
        Ok(Contents {
            change_count: count,
            entries,
        })
    }

    fn replace(&mut self, entries: &[Entry]) -> Result<u64, &'static str> {
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        for entry in entries {
            let format = NSString::from_str(&entry.format);
            let data = NSData::with_bytes(&entry.data);
            if !board.setData_forType(Some(&data), &format) {
                return Err("clipboard_not_available");
            }
        }
        u64::try_from(board.changeCount()).map_err(|_| "clipboard_not_available")
    }

    fn change_count(&mut self) -> u64 {
        u64::try_from(NSPasteboard::generalPasteboard().changeCount()).unwrap_or(0)
    }
}
