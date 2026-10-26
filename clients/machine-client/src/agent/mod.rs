use oni_protocol::AgentTranscriptRecord;

pub mod claude;
pub mod codex;
pub mod hook;
pub mod launcher;
pub mod manifest;
pub mod omp;
pub mod pi;
pub mod registry;
pub mod tail;

#[derive(Debug)]
pub struct ParsedRecord {
    pub start: u64,
    pub end: u64,
    pub record: AgentTranscriptRecord,
}

pub(crate) fn parse_lines(
    bytes: &[u8],
    parse: fn(&serde_json::Value) -> Vec<AgentTranscriptRecord>,
) -> Vec<ParsedRecord> {
    let mut records = Vec::new();
    let mut start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let end = index + 1;
        records.extend(parse_line(&bytes[start..index], start, end, parse));
        start = end;
    }
    if start < bytes.len() {
        records.push(ParsedRecord {
            start: u64::try_from(start).unwrap_or(u64::MAX),
            end: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            record: record(serde_json::json!({
                "kind": "truncated",
                "originalBytes": bytes.len() - start,
                "prefix": excerpt(&bytes[start..]),
            })),
        });
    }
    records
}

fn parse_line(
    line: &[u8],
    start: usize,
    end: usize,
    parse: fn(&serde_json::Value) -> Vec<AgentTranscriptRecord>,
) -> Vec<ParsedRecord> {
    let value = match std::str::from_utf8(line) {
        Ok(text) => match serde_json::from_str(text) {
            Ok(value) => value,
            Err(_) => return one_corrupt(line, start, end, "invalid_shape"),
        },
        Err(_) => return one_corrupt(line, start, end, "invalid_encoding"),
    };
    parse(&value)
        .into_iter()
        .map(|record| ParsedRecord {
            start: u64::try_from(start).unwrap_or(u64::MAX),
            end: u64::try_from(end).unwrap_or(u64::MAX),
            record,
        })
        .collect()
}

fn one_corrupt(line: &[u8], start: usize, end: usize, reason: &str) -> Vec<ParsedRecord> {
    vec![ParsedRecord {
        start: u64::try_from(start).unwrap_or(u64::MAX),
        end: u64::try_from(end).unwrap_or(u64::MAX),
        record: record(serde_json::json!({
            "kind": "corrupt",
            "reason": reason,
            "excerpt": excerpt(line),
        })),
    }]
}

pub(crate) fn unsupported(value: &serde_json::Value) -> Vec<AgentTranscriptRecord> {
    vec![record(serde_json::json!({
        "kind": "corrupt",
        "reason": "unsupported_record",
        "excerpt": truncate(&value.to_string()),
    }))]
}

pub(crate) fn turn(role: &str, text: String) -> AgentTranscriptRecord {
    if let Some(truncated) = truncated_field(&text) {
        return truncated;
    }
    record(serde_json::json!({ "kind": "turn", "role": role, "text": truncate(&text) }))
}

pub(crate) fn tool_call(id: &str, name: &str, input: String) -> AgentTranscriptRecord {
    if let Some(truncated) = truncated_field(&input) {
        return truncated;
    }
    record(serde_json::json!({
        "kind": "tool_call", "callId": id, "name": name, "input": truncate(&input),
    }))
}

/// One message content part: text becomes a turn, the dialect's tool-call
/// part (`tool_call` = its type tag and input key) a tool call, and anything
/// else goes to `other`.
pub(crate) fn content_part(
    role: &str,
    part: &serde_json::Value,
    tool_call: (&str, &str),
    other: fn(&serde_json::Value) -> Vec<AgentTranscriptRecord>,
) -> Vec<AgentTranscriptRecord> {
    match part.get("type").and_then(serde_json::Value::as_str) {
        Some("text") => text_part(role, part),
        Some(kind) if kind == tool_call.0 => tool_call_part(part, tool_call.1),
        _ => other(part),
    }
}

/// A `{type: "text", text}` content part as one turn.
fn text_part(role: &str, part: &serde_json::Value) -> Vec<AgentTranscriptRecord> {
    match part.get("text").and_then(serde_json::Value::as_str) {
        Some(value) => vec![turn(role, value.to_owned())],
        None => unsupported(part),
    }
}

/// A tool-call content part carrying `id`, `name` and its input under `input_key`.
fn tool_call_part(part: &serde_json::Value, input_key: &str) -> Vec<AgentTranscriptRecord> {
    match (
        part.get("id").and_then(serde_json::Value::as_str),
        part.get("name").and_then(serde_json::Value::as_str),
        part.get(input_key),
    ) {
        (Some(id), Some(name), Some(input)) => vec![tool_call(id, name, input.to_string())],
        _ => unsupported(part),
    }
}

pub(crate) fn tool_result(id: &str, output: String, failed: bool) -> AgentTranscriptRecord {
    if let Some(truncated) = truncated_field(&output) {
        return truncated;
    }
    record(serde_json::json!({
        "kind": "tool_result", "callId": id, "output": truncate(&output), "failed": failed,
    }))
}

fn truncated_field(text: &str) -> Option<AgentTranscriptRecord> {
    text.chars().nth(4096).map(|_| {
        record(serde_json::json!({
            "kind": "truncated",
            "originalBytes": text.len(),
            "prefix": truncate(text),
        }))
    })
}

pub(crate) fn text(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    let parts = value.as_array()?;
    parts
        .iter()
        .map(|part| part.get("text").and_then(serde_json::Value::as_str))
        .collect::<Option<Vec<_>>>()
        .map(|parts| parts.join("\n"))
}

pub(crate) fn excerpt(bytes: &[u8]) -> String {
    truncate(&String::from_utf8_lossy(bytes))
}

fn truncate(text: &str) -> String {
    text.chars().take(4096).collect()
}

pub(crate) fn record(value: serde_json::Value) -> AgentTranscriptRecord {
    match oni_protocol::decode(value) {
        Ok(record) => record,
        Err(error) => oni_protocol::decode(serde_json::json!({
            "kind": "corrupt",
            "reason": "invalid_shape",
            "excerpt": truncate(&error.to_string()),
        }))
        .expect("static corrupt record matches generated schema"),
    }
}
