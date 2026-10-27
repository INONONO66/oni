//! The local permission channel. A CLI's permission hook runs
//! `mclient hook permission --cli <name>`, which asks the running client over
//! a private unix socket; the client answers with the attached host's
//! verdict. Every failure on either side ends in a block, never a grant.

use std::{
    fs,
    future::Future,
    io::{self, Read as _},
    os::unix::{
        ffi::OsStrExt,
        fs::{DirBuilderExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use oni_protocol::{decode, AgentPermissionDecision, AgentPermissionRequest, DecodeError};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncReadExt as _,
    net::{UnixListener, UnixStream},
};

use super::manifest;
use crate::transport::framing::{write_frame, FrameError, Framed};

/// How long the host may take to decide one request.
pub const DECIDE: Duration = Duration::from_secs(120);

/// How long one hook round trip may take end to end; past [`DECIDE`] so the
/// host's own timeout refusal arrives first.
pub const ASK_DEADLINE: Duration = Duration::from_secs(150);

pub const MAX_REQUEST_BYTES: u64 = 64 * 1024;

pub const MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024;

/// `sun_path` is 104 bytes on macOS and 108 on Linux; reserve one for NUL.
pub const SUN_PATH_LIMIT: usize = if cfg!(target_os = "linux") { 107 } else { 103 };

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Verdict {
    Allowed,
    Blocked(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Outcome {
    pub code: u8,
    pub stdout: String,
    pub stderr: String,
}

impl Outcome {
    /// Exit 2 with the reason on stderr: the block every supported CLI reads.
    pub fn block(reason: String) -> Self {
        Self {
            code: 2,
            stdout: String::new(),
            stderr: reason,
        }
    }
}

/// Whatever answers permission requests arriving on the socket.
pub trait Decide: Send + Sync + 'static {
    fn decide(
        &self,
        request: AgentPermissionRequest,
    ) -> impl Future<Output = AgentPermissionDecision> + Send;
}

/// One request from the fields a dialect read out of its hook input; the
/// tool input becomes the bounded description.
pub(crate) fn request(
    session: &Value,
    call: &Value,
    tool: &Value,
    input: &Value,
) -> Option<AgentPermissionRequest> {
    decode(json!({
        "sessionId": session,
        "requestId": call,
        "tool": tool,
        "description": super::truncate(&input.to_string()),
    }))
    .ok()
}

/// Bind the socket, replacing a stale socket file, readable only by its owner.
pub fn bind(path: &Path) -> io::Result<UnixListener> {
    path.parent().map_or(Ok(()), fs::create_dir_all)?;
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// Resolve the path advertised to CLI hooks, using a private short directory
/// when the config-relative socket would exceed the Unix address limit.
pub fn socket_path(config_dir: &Path) -> io::Result<PathBuf> {
    socket_path_in(config_dir, &std::env::temp_dir())
}

/// `socket_path` with an explicit fallback root instead of the process `TMPDIR`.
pub fn socket_path_in(config_dir: &Path, temp_root: &Path) -> io::Result<PathBuf> {
    let canonical_socket = config_dir.join(crate::config::AGENT_HOOK_SOCKET);
    if canonical_socket.as_os_str().as_bytes().len() < SUN_PATH_LIMIT {
        return Ok(canonical_socket);
    }
    let canonical_dir = fs::canonicalize(config_dir)?;
    let digest = Sha256::digest(canonical_dir.as_os_str().as_bytes());
    let short_dir = temp_root.join(format!("oni-mclient-{}", hex::encode(&digest[..8])));
    let short_socket = short_dir.join(crate::config::AGENT_HOOK_SOCKET);
    if short_socket.as_os_str().as_bytes().len() >= SUN_PATH_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "hook socket paths exceed sun_path: {} and {}",
                canonical_socket.display(),
                short_socket.display()
            ),
        ));
    }
    match fs::DirBuilder::new().mode(0o700).create(&short_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if !fs::symlink_metadata(&short_dir)?.file_type().is_dir() {
                return Err(error);
            }
            fs::set_permissions(&short_dir, fs::Permissions::from_mode(0o700))?;
        }
        Err(error) => return Err(error),
    }
    Ok(short_socket)
}

/// Answer one request per connection until the task is dropped.
pub async fn serve<D: Decide>(listener: UnixListener, decider: Arc<D>) {
    loop {
        if let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(answer(stream, decider.clone()));
        }
    }
}

/// Read one bounded request, ask, and write the decision back; any failure
/// closes the connection without a decision.
async fn answer<D: Decide>(stream: UnixStream, decider: Arc<D>) {
    let (read, mut write) = stream.into_split();
    let exchange = async move {
        let frame = Framed::new(read.take(MAX_REQUEST_BYTES)).next().await;
        let request = decode::<AgentPermissionRequest>(frame.ok()??).ok()?;
        let decision = serde_json::to_value(decider.decide(request).await).ok()?;
        write_frame(&mut write, &decision).await.ok()
    };
    tokio::time::timeout(ASK_DEADLINE, exchange).await.ok();
}

/// Ask the client listening on `socket`; anything but a matching grant
/// within `deadline` is a block.
pub async fn ask(socket: &Path, request: &AgentPermissionRequest, deadline: Duration) -> Verdict {
    let decision = match tokio::time::timeout(deadline, exchange(socket, request)).await {
        Err(_) => return Verdict::Blocked("oni: permission request timed out".to_owned()),
        Ok(Err(reason)) => return Verdict::Blocked(format!("oni: {reason}")),
        Ok(Ok(decision)) => decision,
    };
    match decision {
        AgentPermissionDecision::Allowed {
            session_id,
            request_id,
        } if *session_id == *request.session_id && *request_id == *request.request_id => {
            Verdict::Allowed
        }
        AgentPermissionDecision::Allowed { .. } => {
            Verdict::Blocked("oni: permission answer names another request".to_owned())
        }
        AgentPermissionDecision::Refused { reason, .. } => {
            Verdict::Blocked(format!("oni: permission refused ({reason})"))
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum AskError {
    #[error("client not reachable: {0}")]
    Unreachable(#[from] io::Error),
    #[error("{0}")]
    Frame(#[from] FrameError),
    #[error("{0}")]
    Encode(#[from] serde_json::Error),
    #[error("malformed decision: {0}")]
    Decode(#[from] DecodeError),
    #[error("client closed without a decision")]
    Closed,
}

async fn exchange(
    socket: &Path,
    request: &AgentPermissionRequest,
) -> Result<AgentPermissionDecision, AskError> {
    let (read, mut write) = UnixStream::connect(socket).await?.into_split();
    write_frame(&mut write, &serde_json::to_value(request)?).await?;
    let mut answers = Framed::new(read.take(MAX_REQUEST_BYTES));
    Ok(decode(answers.next().await?.ok_or(AskError::Closed)?)?)
}

/// The whole hook: read the CLI's input, ask, and map the verdict into the
/// CLI's own answer. An unknown CLI, or input without a permission request,
/// is a block.
pub async fn run(cli: &str, input: impl io::Read, socket: &Path, deadline: Duration) -> Outcome {
    let Some(dialect) = manifest::select(cli) else {
        return Outcome::block(format!("oni: no permission hook for {cli}"));
    };
    let mut bytes = Vec::new();
    let read = input.take(MAX_INPUT_BYTES).read_to_end(&mut bytes);
    let request = read
        .ok()
        .and_then(|_| serde_json::from_slice(&bytes).ok())
        .and_then(|value| dialect.hook_request(&value));
    let Some(request) = request else {
        return Outcome::block("oni: no permission request in hook input".to_owned());
    };
    dialect.hook_outcome(ask(socket, &request, deadline).await)
}
