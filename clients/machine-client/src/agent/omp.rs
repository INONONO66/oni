use std::path::{Path, PathBuf};

use oni_protocol::AgentTranscriptRecord;
use serde_json::Value;

use super::launcher::{LaunchCommand, LaunchContext};
use super::unsupported;

/// omp loads the shared permission module as a hook; it writes the stdin
/// shape [`super::pi::hook_request`] reads.
pub fn command(context: &LaunchContext<'_>) -> LaunchCommand {
    context.script_hook("omp", "omp", "--hook")
}

pub fn transcripts(home: &Path, project: &Path) -> PathBuf {
    let dash = |path: &Path| path.to_string_lossy().replace(['/', ':'], "-");
    let encoded = match (project.strip_prefix(home), project.strip_prefix("/tmp")) {
        (Ok(relative), _) => format!("-{}", dash(relative)),
        (_, Ok(relative)) => format!("-tmp-{}", dash(relative)),
        _ => format!("--{}--", dash(project.strip_prefix("/").unwrap_or(project))),
    };
    home.join(".omp/agent/sessions").join(encoded)
}

pub(crate) fn parse_value(value: &Value) -> Vec<AgentTranscriptRecord> {
    match value.get("type").and_then(Value::as_str) {
        Some(
            "title"
            | "title_change"
            | "service_tier_change"
            | "reset_boundary"
            | "ttsr_injection"
            | "credential_pin"
            | "session_init"
            | "mode_change",
        ) => Vec::new(),
        Some(
            "session"
            | "message"
            | "thinking_level_change"
            | "model_change"
            | "compaction"
            | "branch_summary"
            | "custom"
            | "custom_message"
            | "label",
        ) => super::pi::parse_value(value),
        _ => unsupported(value),
    }
}
