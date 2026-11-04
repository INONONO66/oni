use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs, io,
    io::Cursor,
    net::IpAddr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use rcgen::PublicKeyData;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::transport::{
    connection::{public_key_pin, HostPin},
    ws::{self, WsEndpoint},
};

pub const DEFAULT_PORT: &str = "7643";
const DEFAULT_WSS_PORT: &str = "443";

/// The carrier a configured host address selects, by its scheme:
/// `unix:<path>` dials the host's unix listener (see [`unix_path`]);
/// `wss://host[:port][/path]` dials the WebSocket listener over TLS (port
/// 443 and path `/machine` by default; `HTTPS_PROXY`/`https_proxy` tunnels
/// it through HTTP CONNECT); `tcp://host[:port]` or a bare `host[:port]`
/// dials the raw TLS-TCP listener (port 7643 by default). Both TLS carriers
/// present the same client identity and verify the same host pin. A plaintext
/// `ws://` address is refused ([`ConfigError::PlaintextWs`]): the wire never
/// leaves the host unencrypted and the address is never read as a TCP host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Carrier {
    Tcp {
        address: String,
        server_name: String,
    },
    Wss(WsEndpoint),
}

pub fn unix_path(host: &str) -> Option<PathBuf> {
    host.strip_prefix("unix:").map(PathBuf::from)
}

pub fn carrier(host: &str) -> Result<Carrier, ConfigError> {
    if host.starts_with("ws://") {
        return Err(ConfigError::PlaintextWs);
    }
    if let Some(rest) = host.strip_prefix("wss://") {
        let (authority, path) = rest
            .split_once('/')
            .map_or((rest, ws::PATH.to_owned()), |(authority, path)| {
                (authority, format!("/{path}"))
            });
        let (name, port) = split_port(authority);
        return Ok(Carrier::Wss(WsEndpoint {
            address: with_port(name, port.unwrap_or(DEFAULT_WSS_PORT)),
            server_name: name.to_owned(),
            path,
        }));
    }
    let (address, server_name) = endpoint(host.strip_prefix("tcp://").unwrap_or(host));
    Ok(Carrier::Tcp {
        address,
        server_name,
    })
}

/// One Retina `screen()` capture retains ~103 MB RSS that the allocator does
/// not return (#1775); 512 covers that plus encode-buffer headroom.
pub const DEFAULT_MEMORY_BUDGET_MB: u64 = 512;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("host_unresolved")]
    HostUnresolved,
    #[error("plaintext_ws_refused")]
    PlaintextWs,
    #[error("pin_required")]
    PinRequired,
    #[error("invalid host pin")]
    InvalidPin,
    #[error("invalid export")]
    InvalidExport,
    #[error("invalid saved client identity (client-cert.pem/client-key.pem); restore the matching pair or delete both and re-enroll with Owner")]
    InvalidIdentity,
    #[error("configuration I/O: {0}")]
    Io(#[from] io::Error),
    #[error("configuration JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("certificate generation: {0}")]
    Certificate(#[from] rcgen::Error),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Export {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    pub machine_id: String,
    pub name: String,
    pub host: String,
    pub exports: Vec<Export>,
    pub tags: Vec<String>,
    pub memory_budget_mb: u64,
    pub unix: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tmux_socket: Option<String>,
}

#[derive(Debug, clap::Args)]
pub struct JoinOptions {
    pub host: String,
    /// Explicit override of `ONI_MCLIENT_JOIN_TOKEN`; the environment keeps
    /// the token out of `ps` and shell history.
    #[arg(long)]
    pub token: Option<String>,
    #[arg(long)]
    pub json: bool,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long = "tag")]
    pub tags: Vec<String>,
    #[arg(long = "export")]
    pub exports: Vec<String>,
    #[arg(long)]
    pub no_service: bool,
    #[arg(long)]
    pub service_dir: Option<PathBuf>,
    #[arg(long)]
    pub no_open: bool,
    /// The host key's pin, `encode_pin` text; the only trust a join takes.
    #[arg(long)]
    pub host_pin: Option<String>,
    #[arg(long)]
    pub unix: Option<PathBuf>,
    #[arg(long, default_value_t = DEFAULT_MEMORY_BUDGET_MB)]
    pub memory_budget_mb: u64,
}

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

pub fn root() -> PathBuf {
    home().join(".oni")
}

pub fn agent_registry_directory() -> PathBuf {
    root().join("machine-client")
}

pub fn agent_hook_directory() -> PathBuf {
    agent_registry_directory().join("hooks")
}

/// The socket file, beside the client config, a CLI's permission hook asks
/// the running client on.
pub const AGENT_HOOK_SOCKET: &str = "hook.sock";

/// Set in every launched CLI session to the socket of the client that
/// launched it, so its hooks reach that client whatever config it runs.
pub const AGENT_HOOK_SOCKET_VARIABLE: &str = "ONI_MCLIENT_HOOK_SOCKET";

/// The opaque join token `mclient join` presents to the attach
/// handshake (#1833): read from the environment, never persisted.
pub const JOIN_TOKEN_VARIABLE: &str = "ONI_MCLIENT_JOIN_TOKEN";

pub fn join_token(options: &JoinOptions, env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    options
        .token
        .clone()
        .or_else(|| env(JOIN_TOKEN_VARIABLE))
        .filter(|token| !token.is_empty())
}

/// Set in every launched CLI session to the file its startup hook creates
/// (`mclient hook ready`) once the CLI is at its prompt; the launching
/// client waits for it before the first transcript exists.
pub const AGENT_READY_FILE_VARIABLE: &str = "ONI_MCLIENT_READY_FILE";

/// The launching client's socket when a CLI session names one, else the
/// default client's.
pub fn agent_hook_socket() -> PathBuf {
    std::env::var_os(AGENT_HOOK_SOCKET_VARIABLE).map_or_else(
        || agent_registry_directory().join(AGENT_HOOK_SOCKET),
        PathBuf::from,
    )
}

/// The text form of a host pin, as `--host-pin` takes it and `host-pin`
/// records it: standard base64 of the 32 SPKI sha256 bytes.
pub fn encode_pin(pin: &[u8; 32]) -> String {
    STANDARD.encode(pin)
}

pub fn parse_pin(pin: &str) -> Result<[u8; 32], ConfigError> {
    let bytes = STANDARD
        .decode(pin.trim())
        .map_err(|_| ConfigError::InvalidPin)?;
    bytes.try_into().map_err(|_| ConfigError::InvalidPin)
}

/// A TLS join trusts exactly the pin it was given; no certificate file
/// stands in for it, and nothing is ever trusted unpinned.
pub fn trust(options: &JoinOptions) -> Result<HostPin, ConfigError> {
    let pin = options
        .host_pin
        .as_deref()
        .ok_or(ConfigError::PinRequired)?;
    Ok(HostPin(parse_pin(pin)?))
}

pub fn split_port(value: &str) -> (&str, Option<&str>) {
    if value.parse::<IpAddr>().is_ok() {
        return (value, None);
    }
    if let Some((host, port)) = value
        .strip_prefix('[')
        .and_then(|rest| rest.split_once("]:"))
    {
        return (host, Some(port));
    }
    value
        .rsplit_once(':')
        .map_or((value, None), |(host, port)| (host, Some(port)))
}

pub(crate) fn with_port(host: &str, port: &str) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

pub fn endpoint(value: &str) -> (String, String) {
    let (host, port) = split_port(value);
    (
        with_port(host, port.unwrap_or(DEFAULT_PORT)),
        host.to_owned(),
    )
}

pub fn resolve_address(value: &str) -> Result<String, ConfigError> {
    let (host, port) = split_port(value.strip_prefix("tcp://").unwrap_or(value));
    let address = resolve_host(host)?;
    Ok(port.map_or_else(|| address.clone(), |port| with_port(&address, port)))
}

#[derive(Deserialize)]
struct Peer {
    #[serde(rename = "HostName")]
    host_name: String,
    #[serde(rename = "DNSName")]
    dns_name: String,
    #[serde(rename = "TailscaleIPs")]
    tailscale_ips: Vec<String>,
}

#[derive(Deserialize)]
struct Status {
    #[serde(rename = "Peer")]
    peer: HashMap<String, Peer>,
}

pub fn resolve_host(host: &str) -> Result<String, ConfigError> {
    resolve_with(host, &std::env::var_os("PATH").unwrap_or_default())
}

pub fn resolve_with(host: &str, search_path: &OsStr) -> Result<String, ConfigError> {
    if host.parse::<IpAddr>().is_ok() || host.contains('.') {
        return Ok(host.to_owned());
    }
    let binary = std::env::split_paths(search_path)
        .map(|dir| dir.join("tailscale"))
        .chain([
            PathBuf::from("/usr/bin/tailscale"),
            PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
        ])
        .find(|path| path.is_file())
        .ok_or(ConfigError::HostUnresolved)?;
    let output = Command::new(binary)
        .args(["status", "--json"])
        .output()
        .map_err(|_| ConfigError::HostUnresolved)?;
    if !output.status.success() {
        return Err(ConfigError::HostUnresolved);
    }
    resolve_peer(host, &output.stdout)
}

pub fn resolve_peer(host: &str, data: &[u8]) -> Result<String, ConfigError> {
    let status: Status = serde_json::from_slice(data).map_err(|_| ConfigError::HostUnresolved)?;
    status
        .peer
        .values()
        .find(|peer| peer.host_name == host || peer.dns_name.split('.').next() == Some(host))
        .and_then(|peer| peer.tailscale_ips.first().cloned())
        .ok_or(ConfigError::HostUnresolved)
}

pub fn hostname() -> String {
    let name = nix::unistd::gethostname().unwrap_or_default();
    name.to_string_lossy().into_owned()
}

pub fn slug(hostname: &str) -> String {
    hostname
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned()
}

fn parse_export(value: &str) -> Result<Export, ConfigError> {
    let (name, path) = value.split_once('=').ok_or(ConfigError::InvalidExport)?;
    let valid_name = (1..=64).contains(&name.len())
        && name.starts_with(|ch: char| ch.is_ascii_lowercase())
        && name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_');
    let valid_path = Path::new(path).is_absolute()
        && !path.contains('\0')
        && !path.split('/').any(|segment| segment == "..");
    if !(valid_name && valid_path) {
        return Err(ConfigError::InvalidExport);
    }
    Ok(Export {
        name: name.to_owned(),
        path: path.to_owned(),
    })
}

pub fn parse_exports(values: &[String]) -> Result<Vec<Export>, ConfigError> {
    let exports = values
        .iter()
        .map(|value| parse_export(value))
        .collect::<Result<Vec<_>, _>>()?;
    let names = exports
        .iter()
        .map(|entry| &entry.name)
        .collect::<HashSet<_>>();
    if names.len() != exports.len() {
        return Err(ConfigError::InvalidExport);
    }
    Ok(exports)
}

pub fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    fs::write(path, contents)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

pub fn save(config: &ClientConfig, directory: &Path) -> Result<(), ConfigError> {
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    write_private(&directory.join("client.json"), &serde_json::to_vec(config)?)?;
    Ok(())
}

pub fn load(path: &Path) -> Result<ClientConfig, ConfigError> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

pub fn identity(directory: &Path, name: &str) -> Result<String, ConfigError> {
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let saved_cert = fs::read(directory.join("client-cert.pem"));
    let saved_key = fs::read(directory.join("client-key.pem"));
    match (saved_cert, saved_key) {
        (Ok(cert), Ok(key)) => {
            let certificate = rustls_pemfile::certs(&mut Cursor::new(cert))
                .next()
                .transpose()
                .map_err(|_| ConfigError::InvalidIdentity)?
                .ok_or(ConfigError::InvalidIdentity)?;
            let pin =
                public_key_pin(certificate.as_ref()).map_err(|_| ConfigError::InvalidIdentity)?;
            let key = rcgen::KeyPair::from_pem(
                std::str::from_utf8(&key).map_err(|_| ConfigError::InvalidIdentity)?,
            )
            .map_err(|_| ConfigError::InvalidIdentity)?;
            let key_pin: [u8; 32] = Sha256::digest(key.subject_public_key_info()).into();
            if key_pin != pin {
                return Err(ConfigError::InvalidIdentity);
            }
            return Ok(hex::encode(pin));
        }
        (Err(cert), Err(key))
            if cert.kind() == io::ErrorKind::NotFound && key.kind() == io::ErrorKind::NotFound => {}
        (Err(error), _) | (_, Err(error)) if error.kind() != io::ErrorKind::NotFound => {
            return Err(error.into());
        }
        _ => return Err(ConfigError::InvalidIdentity),
    }
    let mut params = rcgen::CertificateParams::new(vec![name.to_owned()])?;
    let current = time::OffsetDateTime::now_utc();
    params.not_before = current;
    params.not_after = current + time::Duration::days(3652);
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)?;
    let cert = params.self_signed(&key)?;
    write_private(&directory.join("client-cert.pem"), cert.pem().as_bytes())?;
    write_private(
        &directory.join("client-key.pem"),
        key.serialize_pem().as_bytes(),
    )?;
    let pin = public_key_pin(cert.der()).map_err(|_| ConfigError::InvalidPin)?;
    Ok(hex::encode(pin))
}
