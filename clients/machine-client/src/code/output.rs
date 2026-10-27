//! Bounded UTF-8 stream snapshots for live peek and final cell results.

use std::sync::{Mutex, PoisonError};

use serde_json::{json, Value};

use super::driver::{Stream, OUTPUT_LIMIT};

#[derive(Default)]
pub(super) struct Captured {
    stdout: String,
    stderr: String,
    stdout_bytes: usize,
    stderr_bytes: usize,
}

impl Captured {
    pub(super) fn push(&mut self, stream: Stream, text: &str, bytes: usize) {
        let (prefix, total) = match stream {
            Stream::Stdout => (&mut self.stdout, &mut self.stdout_bytes),
            Stream::Stderr => (&mut self.stderr, &mut self.stderr_bytes),
        };
        *total = total.saturating_add(bytes);
        let available = OUTPUT_LIMIT.saturating_sub(prefix.len());
        let mut end = available.min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        prefix.push_str(&text[..end]);
    }

    pub(super) fn value(&self) -> Value {
        let mut output = json!({"stdout": self.stdout, "stderr": self.stderr});
        let mut truncated = serde_json::Map::new();
        for (name, prefix, total) in [
            ("stdout", &self.stdout, self.stdout_bytes),
            ("stderr", &self.stderr, self.stderr_bytes),
        ] {
            if total > prefix.len() {
                output[name] = json!(format!("{prefix}\n[truncated: {total} bytes]\n"));
                truncated.insert(name.to_owned(), json!({"originalBytes": total}));
            }
        }
        if !truncated.is_empty() {
            output["truncated"] = Value::Object(truncated);
        }
        output
    }
}

pub(super) fn terminal(cell_id: &str, status: &str, output: &Mutex<Captured>) -> Value {
    json!({"status":status,"cellId":cell_id,"output":output.lock().unwrap_or_else(PoisonError::into_inner).value()})
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Captured, Stream, OUTPUT_LIMIT};

    #[test]
    fn each_stream_is_cut_at_a_char_boundary_and_reports_its_original_size() {
        let mut captured = Captured::default();
        captured.push(Stream::Stderr, "warn", 4);
        let filler = "a".repeat(OUTPUT_LIMIT - 1);
        captured.push(Stream::Stdout, &filler, OUTPUT_LIMIT - 1);
        captured.push(Stream::Stdout, "\u{e9}", 2);
        let value = captured.value();
        assert_eq!(value["stderr"], "warn");
        assert_eq!(
            value["stdout"],
            format!("{filler}\n[truncated: {} bytes]\n", OUTPUT_LIMIT + 1)
        );
        assert_eq!(
            value["truncated"],
            json!({"stdout": {"originalBytes": OUTPUT_LIMIT + 1}})
        );
    }
}
