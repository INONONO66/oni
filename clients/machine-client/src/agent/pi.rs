use std::path::{Path, PathBuf};

use oni_protocol::{AgentPermissionRequest, AgentTranscriptRecord};
use serde_json::Value;

use super::launcher::{LaunchCommand, LaunchContext};
use super::{content_part, text, tool_result, turn, unsupported};

/// pi loads the shared permission module as an extension.
pub fn command(context: &LaunchContext<'_>) -> LaunchCommand {
    context.script_hook("pi", "pi", "--extension")
}

/// The shape the shared permission module writes to the hook's stdin.
pub fn hook_request(input: &Value) -> Option<AgentPermissionRequest> {
    super::hook::request(
        input.get("sessionId")?,
        input.get("toolCallId")?,
        input.get("toolName")?,
        input.get("input")?,
    )
}

pub fn transcripts(home: &Path, project: &Path) -> PathBuf {
    let path = project.to_string_lossy();
    let encoded = path.trim_start_matches('/').replace(['/', ':'], "-");
    home.join(".pi/agent/sessions")
        .join(format!("--{encoded}--"))
}

pub fn session_id(transcript: &Path) -> Option<String> {
    let (_, id) = transcript.file_stem()?.to_str()?.split_once('_')?;
    Some(id.to_owned())
}

pub(crate) fn parse_value(value: &Value) -> Vec<AgentTranscriptRecord> {
    match value.get("type").and_then(Value::as_str) {
        Some(
            "session"
            | "model_change"
            | "thinking_level_change"
            | "compaction"
            | "branch_summary"
            | "custom"
            | "label"
            | "session_info"
            | "usage"
            | "context_edit"
            | "custom_message",
        ) => return Vec::new(),
        Some("message") => {}
        _ => return unsupported(value),
    }
    let Some(message) = value.get("message") else {
        return unsupported(value);
    };
    match message.get("role").and_then(Value::as_str) {
        Some(role @ ("user" | "assistant")) => {
            let Some(content) = message.get("content") else {
                return unsupported(message);
            };
            if role == "user" {
                return text(content)
                    .map(|value| vec![turn(role, value)])
                    .unwrap_or_else(|| unsupported(message));
            }
            let Some(parts) = content.as_array() else {
                return unsupported(message);
            };
            parts
                .iter()
                .flat_map(|part| content_part(role, part, ("toolCall", "arguments"), unsupported))
                .collect()
        }
        Some("system") => Vec::new(),
        Some("toolResult") => match (
            message.get("toolCallId").and_then(Value::as_str),
            message.get("content").and_then(text),
        ) {
            (Some(id), Some(output)) => vec![tool_result(
                id,
                output,
                message
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )],
            _ => unsupported(message),
        },
        _ => unsupported(message),
    }
}
