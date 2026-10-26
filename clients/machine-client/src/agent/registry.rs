//! Durable observations of CLI sessions, keyed by their canonical project.
//! A saved entry is never proof that its process is still running: only a
//! terminal the launcher re-observes live is owned again after a restart.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub project: PathBuf,
    pub cli: String,
    pub session_id: String,
    pub transcript: PathBuf,
    /// The terminal this client launched the session in, kept so a restarted
    /// client can re-own it once the terminal is observed live again.
    #[serde(default)]
    pub terminal: Option<String>,
}

impl Session {
    fn same(&self, project: &Path, cli: &str, session_id: &str) -> bool {
        self.project == project && self.cli == cli && self.session_id == session_id
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("session registry I/O: {0}")]
    Io(#[from] io::Error),
    #[error("session registry JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("project escapes the granted export")]
    OutsideExport,
    /// The wire addresses a session by its id alone, so one id never names
    /// sessions in two projects or of two CLIs.
    #[error("session id already names another project's session")]
    Collision,
}

#[derive(Default, Deserialize, Serialize)]
struct Saved {
    sessions: Vec<Session>,
}

pub struct Registry {
    directory: PathBuf,
    saved: Saved,
}

const FILE: &str = "agent-sessions.json";

fn load(file: &Path) -> Result<Saved, RegistryError> {
    match fs::read(file) {
        Ok(bytes) => {
            let saved: Saved = serde_json::from_slice(&bytes)?;
            let mut ids = std::collections::HashSet::new();
            if saved
                .sessions
                .iter()
                .any(|session| !ids.insert(&session.session_id))
            {
                return Err(RegistryError::Collision);
            }
            Ok(saved)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Saved::default()),
        Err(error) => Err(error.into()),
    }
}

impl Registry {
    pub fn open(directory: &Path) -> Result<Self, RegistryError> {
        Ok(Self {
            directory: directory.to_owned(),
            saved: load(&directory.join(FILE))?,
        })
    }

    pub fn project(path: &Path, exports: &[PathBuf]) -> Result<PathBuf, RegistryError> {
        let canonical = path.canonicalize()?;
        exports
            .iter()
            .filter_map(|export| export.canonicalize().ok())
            .any(|root| canonical.starts_with(root))
            .then_some(canonical)
            .ok_or(RegistryError::OutsideExport)
    }

    pub fn find(&self, project: &Path, cli: &str, session_id: &str) -> Option<&Session> {
        self.saved
            .sessions
            .iter()
            .find(|session| session.same(project, cli, session_id))
    }

    /// The one observation carrying this session id, in any project.
    pub fn by_id(&self, session_id: &str) -> Option<&Session> {
        self.saved
            .sessions
            .iter()
            .find(|session| session.session_id == session_id)
    }

    pub fn sessions<'a>(&'a self, project: &'a Path) -> impl Iterator<Item = &'a Session> + 'a {
        self.saved
            .sessions
            .iter()
            .filter(move |session| session.project == project)
    }

    /// Record `session`, refusing an id that already names a session of
    /// another project or CLI.
    pub fn observe(&mut self, session: Session) -> Result<(), RegistryError> {
        self.update(|saved| {
            let mut same_id = saved
                .sessions
                .iter_mut()
                .filter(|existing| existing.session_id == session.session_id);
            match same_id.next() {
                Some(existing)
                    if existing.same(&session.project, &session.cli, &session.session_id) =>
                {
                    *existing = session;
                }
                Some(_) => return Err(RegistryError::Collision),
                None => saved.sessions.push(session),
            }
            Ok(())
        })
    }

    /// Reload under an exclusive lock, apply `change`, and replace the file
    /// atomically so separately opened clients never drop each other's rows.
    fn update(
        &mut self,
        change: impl FnOnce(&mut Saved) -> Result<(), RegistryError>,
    ) -> Result<(), RegistryError> {
        let directory = &self.directory;
        fs::create_dir_all(directory)?;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(directory.join("agent-sessions.lock"))?;
        lock.lock()?;
        let file = directory.join(FILE);
        let mut saved = load(&file)?;
        change(&mut saved)?;
        let temporary = directory.join(format!("agent-sessions-{}.tmp", std::process::id()));
        let mut output = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        output.write_all(&serde_json::to_vec(&saved)?)?;
        output.sync_all()?;
        fs::rename(&temporary, &file)?;
        File::open(directory)?.sync_all()?;
        self.saved = saved;
        Ok(())
    }
}
