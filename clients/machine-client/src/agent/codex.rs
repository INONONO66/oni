use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use oni_protocol::AgentTranscriptRecord;
use serde_json::Value;

use super::launcher::LaunchCommand;
use super::{tool_call, tool_result, turn, unsupported};

pub fn command() -> LaunchCommand {
    LaunchCommand {
        executable: "codex".to_owned(),
        args: Vec::new(),
        env: Vec::new(),
        requires: None,
    }
}

pub fn transcripts(home: &Path) -> PathBuf {
    home.join(".codex/sessions")
}

pub fn session_id(transcript: &Path) -> Option<String> {
    let stem = transcript.file_stem()?.to_str()?;
    Some(stem.get(stem.len().checked_sub(36)?..)?.to_owned())
}

pub fn belongs(transcript: &Path, project: &Path) -> bool {
    let mut first = String::new();
    let read = fs::File::open(transcript)
        .and_then(|file| BufReader::new(file).read_line(&mut first))
        .is_ok();
    let meta: Value = serde_json::from_str(&first).unwrap_or_default();
    read && meta["type"] == "session_meta" && meta["payload"]["cwd"].as_str() == project.to_str()
}

pub(crate) fn parse_value(value: &Value) -> Vec<AgentTranscriptRecord> {
    match value.get("type").and_then(Value::as_str) {
        Some("session_meta" | "turn_context" | "event_msg" | "compacted") => return Vec::new(),
        Some("response_item") => {}
        _ => return unsupported(value),
    }
    let Some(payload) = value.get("payload") else {
        return unsupported(value);
    };
    match payload.get("type").and_then(Value::as_str) {
        Some("message") => {
            let role = match payload.get("role").and_then(Value::as_str) {
                Some(role @ ("user" | "assistant")) => role,
                Some("system" | "developer") => return Vec::new(),
                _ => return unsupported(payload),
            };
            let Some(parts) = payload.get("content").and_then(Value::as_array) else {
                return unsupported(payload);
            };
            let mut records = Vec::new();
            for part in parts {
                match part
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("content").and_then(Value::as_str))
                {
                    Some(text) => records.push(turn(role, text.to_owned())),
                    None => records.extend(unsupported(part)),
                }
            }
            records
        }
        Some("function_call") => match (
            payload.get("call_id").and_then(Value::as_str),
            payload.get("name").and_then(Value::as_str),
            payload.get("arguments").and_then(Value::as_str),
        ) {
            (Some(id), Some(name), Some(input)) => vec![tool_call(id, name, input.to_owned())],
            _ => unsupported(payload),
        },
        Some("function_call_output") => match (
            payload.get("call_id").and_then(Value::as_str),
            payload.get("output").and_then(Value::as_str),
        ) {
            (Some(id), Some(output)) => vec![tool_result(id, output.to_owned(), false)],
            _ => unsupported(payload),
        },
        _ => unsupported(payload),
    }
}
