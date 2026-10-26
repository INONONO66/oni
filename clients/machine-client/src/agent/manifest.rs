use std::path::{Path, PathBuf};

use oni_protocol::AgentPermissionRequest;
use serde_json::Value;

use super::hook::{Outcome, Verdict};
use super::launcher::{Cli, LaunchCommand, LaunchContext, Permission};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Format {
    ClaudeJsonl,
    CodexRolloutJsonl,
    PiJsonlV3,
    OmpJsonlV3,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Dialect {
    pub cli: &'static str,
    pub discovery: &'static str,
    pub permission_hook: &'static str,
    pub permission: Permission,
    pub assigns_id: bool,
    pub format: Format,
}

pub const DIALECTS: [Dialect; 4] = [
    Dialect {
        cli: "claude-code",
        discovery: "~/.claude/projects/<encoded-project>/<session-id>.jsonl",
        permission_hook: "PreToolUse",
        permission: Permission::Hook,
        assigns_id: true,
        format: Format::ClaudeJsonl,
    },
    Dialect {
        cli: "codex",
        discovery: "~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl",
        permission_hook: "approval_request",
        permission: Permission::CliPrompt,
        assigns_id: false,
        format: Format::CodexRolloutJsonl,
    },
    Dialect {
        cli: "pi",
        discovery: "~/.pi/agent/sessions/--<encoded-project>--/<timestamp>_<session-id>.jsonl",
        permission_hook: "tool_call",
        permission: Permission::Hook,
        assigns_id: false,
        format: Format::PiJsonlV3,
    },
    Dialect {
        cli: "omp",
        discovery: "~/.omp/agent/sessions/<encoded-canonical-cwd>/<timestamp>_<session-id>.jsonl",
        permission_hook: "tool_call",
        permission: Permission::Hook,
        assigns_id: false,
        format: Format::OmpJsonlV3,
    },
];

pub fn select(cli: &str) -> Option<Dialect> {
    DIALECTS.iter().copied().find(|dialect| dialect.cli == cli)
}

impl Dialect {
    /// The permission request in this CLI's hook input; `None` for a CLI
    /// without a hook or input it does not recognise.
    pub fn hook_request(&self, input: &Value) -> Option<AgentPermissionRequest> {
        match self.format {
            Format::ClaudeJsonl => super::claude::hook_request(input),
            Format::PiJsonlV3 | Format::OmpJsonlV3 => super::pi::hook_request(input),
            Format::CodexRolloutJsonl => None,
        }
    }

    /// The verdict in the form this CLI's hook reads.
    pub fn hook_outcome(&self, verdict: Verdict) -> Outcome {
        match (self.format, verdict) {
            (Format::ClaudeJsonl, verdict) => {
                super::claude::hook_outcome(self.permission_hook, verdict)
            }
            (_, Verdict::Allowed) => Outcome {
                code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            (_, Verdict::Blocked(reason)) => Outcome::block(reason),
        }
    }
}

impl Format {
    pub fn parse(self, bytes: &[u8]) -> Vec<super::ParsedRecord> {
        super::parse_lines(
            bytes,
            match self {
                Self::ClaudeJsonl => super::claude::parse_value,
                Self::CodexRolloutJsonl => super::codex::parse_value,
                Self::PiJsonlV3 => super::pi::parse_value,
                Self::OmpJsonlV3 => super::omp::parse_value,
            },
        )
    }
}

impl Cli for Dialect {
    fn name(&self) -> &'static str {
        self.cli
    }

    fn permission(&self) -> Permission {
        self.permission
    }

    fn assigns_id(&self) -> bool {
        self.assigns_id
    }

    fn command(&self, context: &LaunchContext<'_>) -> LaunchCommand {
        match self.format {
            Format::ClaudeJsonl => super::claude::command(context, self.permission_hook),
            Format::CodexRolloutJsonl => super::codex::command(),
            Format::PiJsonlV3 => super::pi::command(context),
            Format::OmpJsonlV3 => super::omp::command(context),
        }
    }

    fn transcripts(&self, home: &Path, project: &Path) -> PathBuf {
        match self.format {
            Format::ClaudeJsonl => super::claude::transcripts(home, project),
            Format::CodexRolloutJsonl => super::codex::transcripts(home),
            Format::PiJsonlV3 => super::pi::transcripts(home, project),
            Format::OmpJsonlV3 => super::omp::transcripts(home, project),
        }
    }

    fn session_id(&self, transcript: &Path) -> Option<String> {
        match self.format {
            Format::ClaudeJsonl => super::claude::session_id(transcript),
            Format::CodexRolloutJsonl => super::codex::session_id(transcript),
            Format::PiJsonlV3 | Format::OmpJsonlV3 => super::pi::session_id(transcript),
        }
    }

    fn belongs(&self, transcript: &Path, project: &Path) -> bool {
        self.format != Format::CodexRolloutJsonl || super::codex::belongs(transcript, project)
    }
}
