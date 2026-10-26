//! The CDP endpoint manifest: operator data beside `client.json`, read once
//! at start, naming every loopback port discovery may probe and every
//! browser the client may launch. A request names a launch entry and
//! nothing else: no request byte reaches a path, an argument or a port.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::Deserialize;

pub const FILE: &str = "cdp.json";
const MAX_PORTS: usize = 16;
const MAX_LAUNCH: usize = 16;
const MAX_ARGS: usize = 64;
const MAX_NAME: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("cdp manifest I/O: {0}")]
    Io(#[from] io::Error),
    #[error("cdp manifest JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid cdp manifest: {0}")]
    Invalid(&'static str),
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    #[serde(default)]
    pub ports: Vec<u16>,
    #[serde(default)]
    pub launch: Vec<Launch>,
}

/// One launchable browser: the binary and argv are taken verbatim; the
/// dialect adds only its port and profile flags.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    pub name: String,
    pub binary: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    pub port: u16,
    pub profile: PathBuf,
}

fn named(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= MAX_NAME
        && chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn launchable(entry: &Launch) -> bool {
    named(&entry.name)
        && entry.binary.is_absolute()
        && entry.profile.is_absolute()
        && entry.args.len() <= MAX_ARGS
        && entry.port != 0
}

impl Manifest {
    pub fn parse(data: &[u8]) -> Result<Self, ManifestError> {
        let manifest: Self = serde_json::from_slice(data)?;
        if manifest.ports.len() > MAX_PORTS || manifest.launch.len() > MAX_LAUNCH {
            return Err(ManifestError::Invalid("too many entries"));
        }
        if manifest.ports.contains(&0) {
            return Err(ManifestError::Invalid("port 0"));
        }
        if !manifest.launch.iter().all(launchable) {
            return Err(ManifestError::Invalid("launch entry"));
        }
        let mut names: Vec<&str> = manifest.launch.iter().map(|e| e.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        if names.len() != manifest.launch.len() {
            return Err(ManifestError::Invalid("duplicate launch name"));
        }
        Ok(manifest)
    }

    /// An absent file is the empty manifest: CDP is not available.
    pub fn load(path: &Path) -> Result<Self, ManifestError> {
        match fs::read(path) {
            Ok(data) => Self::parse(&data),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn configured(&self) -> bool {
        !self.ports.is_empty() || !self.launch.is_empty()
    }

    pub fn entry(&self, name: &str) -> Option<&Launch> {
        self.launch.iter().find(|entry| entry.name == name)
    }
}
