use std::path::{Path, PathBuf};

use oni_protocol::{AgentPermissionRequest, AgentTranscriptRecord};
use serde_json::{json, Value};

use super::hook::{self, Outcome, Verdict};
use super::launcher::{LaunchCommand, LaunchContext};
use super::{content_part, text, tool_result, turn, unsupported};

/// Seconds Claude Code waits for the hook; past the hook's own deadline so
/// the hook reports its refusal rather than being cut off.
const HOOK_TIMEOUT_SECS: u64 = hook::ASK_DEADLINE.as_secs() + 20;

pub fn command(context: &LaunchContext<'_>, hook: &str) -> LaunchCommand {
    // Exec form with `onFailure: block`: a hook that cannot start, crashes,
    // times out or prints invalid output blocks the tool call.
    let settings = json!({"hooks": {hook: [{"matcher": "*", "hooks": [{
        "type": "command",
        "command": context.hook.program,
        "args": ["hook", "permission", "--cli", "claude-code"],
        "onFailure": "block",
        "timeout": HOOK_TIMEOUT_SECS,
    }]}]}});
    let mut args = vec!["--settings".to_owned(), settings.to_string()];
    if let Some(id) = context.session_id {
        args.extend(["--session-id".to_owned(), id.to_owned()]);
    }
    LaunchCommand {
        executable: "claude".to_owned(),
        args,
        env: Vec::new(),
        requires: None,
    }
}

/// The hook input's session, tool call and tool become one request.
pub fn hook_request(input: &Value) -> Option<AgentPermissionRequest> {
    hook::request(
        input.get("session_id")?,
        input.get("tool_use_id")?,
        input.get("tool_name")?,
        input.get("tool_input")?,
    )
}

/// An allow is an explicit `allow` decision on exit 0; a block is exit 2 with
/// the reason on stderr.
pub fn hook_outcome(event: &str, verdict: Verdict) -> Outcome {
    match verdict {
        Verdict::Allowed => Outcome {
            code: 0,
            stdout: json!({"hookSpecificOutput": {
                "hookEventName": event,
                "permissionDecision": "allow",
            }})
            .to_string(),
            stderr: String::new(),
        },
        Verdict::Blocked(reason) => Outcome::block(reason),
    }
}

pub fn transcripts(home: &Path, project: &Path) -> PathBuf {
    let encoded: String = project
        .to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    home.join(".claude/projects").join(encoded)
}

pub fn session_id(transcript: &Path) -> Option<String> {
    Some(transcript.file_stem()?.to_str()?.to_owned())
}

pub(crate) fn parse_value(value: &Value) -> Vec<AgentTranscriptRecord> {
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return unsupported(value);
    };
    if matches!(
        kind,
        "queue-operation"
            | "attachment"
            | "summary"
            | "system"
            | "file-history-snapshot"
            | "progress"
    ) {
        return Vec::new();
    }
    if !matches!(kind, "user" | "assistant") {
        return unsupported(value);
    }
    let Some(message) = value.get("message") else {
        return unsupported(value);
    };
    let Some(role @ ("user" | "assistant")) = message.get("role").and_then(Value::as_str) else {
        return unsupported(value);
    };
    if role != kind {
        return unsupported(value);
    }
    let Some(content) = message.get("content") else {
        return unsupported(value);
    };
    if let Some(value) = content.as_str() {
        return vec![turn(role, value.to_owned())];
    }
    let Some(parts) = content.as_array() else {
        return unsupported(value);
    };
    parts
        .iter()
        .flat_map(|part| content_part(role, part, ("tool_use", "input"), tool_result_part))
        .collect()
}

fn tool_result_part(part: &Value) -> Vec<AgentTranscriptRecord> {
    if part.get("type").and_then(Value::as_str) != Some("tool_result") {
        return unsupported(part);
    }
    match (
        part.get("tool_use_id").and_then(Value::as_str),
        part.get("content").and_then(text),
    ) {
        (Some(id), Some(output)) => vec![tool_result(
            id,
            output,
            part.get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )],
        _ => unsupported(part),
    }
}
