//! Proof that an archive, and the binary staged from it, are the release they claim.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{run, Artifact, Layout, ReleaseDoc, UpdateError};

/// The staged binary must speak the release's contract, and the host's when known.
pub fn compatible(own: u64, release: u64, host: Option<u64>) -> Result<(), UpdateError> {
    if own != release || host.is_some_and(|host| host != own) {
        return Err(UpdateError::ProbeFailed(format!(
            "contract {own}, release {release}, host {host:?}"
        )));
    }
    Ok(())
}

pub fn verify(archive: &[u8], artifact: &Artifact) -> Result<(), UpdateError> {
    let length = u64::try_from(archive.len()).map_err(|_| UpdateError::ChecksumMismatch)?;
    if length != artifact.bytes || hex::encode(Sha256::digest(archive)) != artifact.sha256 {
        return Err(UpdateError::ChecksumMismatch);
    }
    Ok(())
}

/// What `mclient --version --json` reports.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub version: String,
    pub contract_version: u64,
}

pub(super) fn stage(
    layout: &Layout,
    release: &ReleaseDoc,
    artifact: &Artifact,
    archive: &[u8],
) -> Result<PathBuf, UpdateError> {
    let directory = layout.stage(&release.version);
    let binary = directory.join("mclient");
    if [layout.current(), layout.previous()]
        .iter()
        .any(|link| fs::read_link(link).is_ok_and(|target| target == binary))
    {
        return Err(UpdateError::ProbeFailed(
            "version is active or retained for rollback".to_owned(),
        ));
    }
    match fs::remove_dir_all(&directory) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    fs::create_dir_all(&directory)?;
    fs::write(directory.join("release.json"), release.document.to_string())?;
    let path = directory.join(&artifact.name);
    fs::write(&path, archive)?;
    let path = path.to_string_lossy().into_owned();
    let into = directory.to_string_lossy().into_owned();
    run(Path::new("tar"), &["-xzf", &path, "-C", &into])?;
    if !binary.is_file() {
        return Err(UpdateError::ProbeFailed(
            "archive carries no mclient".to_owned(),
        ));
    }
    Ok(binary)
}

pub(super) fn probe_staged(
    binary: &Path,
    release: &ReleaseDoc,
    host: Option<u64>,
) -> Result<(), UpdateError> {
    let identity: Identity = serde_json::from_slice(&run(binary, &["--version", "--json"])?)
        .map_err(|error| UpdateError::ProbeFailed(format!("version report: {error}")))?;
    if identity.version != release.version {
        return Err(UpdateError::ProbeFailed(format!(
            "staged version {} is not {}",
            identity.version, release.version
        )));
    }
    let document = binary
        .with_file_name("release.json")
        .to_string_lossy()
        .into_owned();
    let host = host.map(|host| host.to_string());
    let mut args = vec!["update", "--check", "--file", &document];
    if let Some(host) = &host {
        args.extend(["--host-contract", host]);
    }
    run(binary, &args).map(drop)
}

#[cfg(test)]
mod tests {
    use super::super::{fixtures::release_for, parse_release};
    use super::*;

    #[test]
    fn contracts_must_match_release_and_known_host() {
        assert!(compatible(2, 2, None).is_ok());
        assert!(compatible(2, 2, Some(2)).is_ok());
        for (release, host) in [(3, None), (2, Some(3))] {
            assert!(matches!(
                compatible(2, release, host),
                Err(UpdateError::ProbeFailed(_))
            ));
        }
    }

    #[test]
    fn verify_checks_length_and_digest() {
        let artifact = parse_release(release_for(b"archive", "1", "a"))
            .and_then(|release| release.artifact(Some("linux-x86_64")))
            .expect("artifact");
        assert!(verify(b"archive", &artifact).is_ok());
        for archive in [&b"archiv"[..], &b"ARCHIVE"[..]] {
            assert!(matches!(
                verify(archive, &artifact),
                Err(UpdateError::ChecksumMismatch)
            ));
        }
    }
}
