//! Where a release document and its artifact live, and how their bytes are read.

use std::{fs, io, process::Command};

use serde_json::Value;

use super::{parse_release, UpdateError};

pub fn hosted_artifact(document: &Value, platform: Option<&str>) -> Result<(), UpdateError> {
    let artifact = parse_release(document.clone())?.artifact(platform)?;
    if !["https://", "http://", "file://"]
        .iter()
        .any(|scheme| artifact.url.starts_with(scheme))
    {
        return Err(UpdateError::ReleaseUnavailable);
    }
    Ok(())
}

/// An artifact URL relative to the release document resolves beside it.
pub fn resolve(base: &str, url: &str) -> String {
    if url.contains("://") || url.starts_with('/') {
        return url.to_owned();
    }
    base.rsplit_once('/').map_or_else(
        || url.to_owned(),
        |(directory, _)| format!("{directory}/{url}"),
    )
}

pub fn fetch(location: &str) -> io::Result<Vec<u8>> {
    if !location.contains("://") {
        return fs::read(location);
    }
    let output = Command::new("curl").args(["-fsSL", location]).output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "curl {location}: {}",
            output.status
        )));
    }
    Ok(output.stdout)
}

pub fn document(location: &str) -> Result<Value, UpdateError> {
    let bytes = fetch(location).map_err(|_| UpdateError::ReleaseUnavailable)?;
    serde_json::from_slice(&bytes).map_err(|_| UpdateError::ReleaseUnavailable)
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::release_for;
    use super::*;
    use serde_json::json;

    #[test]
    fn relative_artifact_urls_resolve_beside_the_release() {
        assert_eq!(
            resolve("https://h/r/release.json", "a.tgz"),
            "https://h/r/a.tgz"
        );
        assert_eq!(
            resolve("https://h/r/release.json", "https://x/a.tgz"),
            "https://x/a.tgz"
        );
        assert_eq!(resolve("/r/release.json", "/abs/a.tgz"), "/abs/a.tgz");
        assert_eq!(resolve("release.json", "a.tgz"), "a.tgz");
    }

    #[test]
    fn hosted_artifacts_require_absolute_urls() {
        let relative = release_for(b"archive", "2.0.0", "archive.tgz");
        assert!(matches!(
            hosted_artifact(&relative, Some("linux-x86_64")),
            Err(UpdateError::ReleaseUnavailable)
        ));
        let absolute = release_for(b"archive", "2.0.0", "file:///release/archive.tgz");
        assert!(hosted_artifact(&absolute, Some("linux-x86_64")).is_ok());
    }

    #[test]
    fn fetch_reads_paths_and_urls() {
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("release.json");
        fs::write(&path, "{\"a\":1}").expect("document");
        let path = path.to_string_lossy().into_owned();
        assert_eq!(fetch(&path).expect("path"), b"{\"a\":1}");
        assert_eq!(fetch(&format!("file://{path}")).expect("url"), b"{\"a\":1}");
        assert!(fetch(&format!("file://{path}.absent")).is_err());
        assert_eq!(document(&path).expect("json"), json!({"a": 1}));
        assert!(matches!(
            document(&format!("{path}.absent")),
            Err(UpdateError::ReleaseUnavailable)
        ));
        fs::write(directory.path().join("bad.json"), "{").expect("bad");
        let bad = directory
            .path()
            .join("bad.json")
            .to_string_lossy()
            .into_owned();
        assert!(matches!(
            document(&bad),
            Err(UpdateError::ReleaseUnavailable)
        ));
    }
}
