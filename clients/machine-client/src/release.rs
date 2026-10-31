//! Release pin, staged update and atomic `current` switch (#1696).
//!
//! Every decision lives here, free of `cfg(target_os)`: the platform key and
//! the service restart command take the OS as a value, so both branches run
//! in every test build.

use std::{
    fs, io,
    os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{config, report, service};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("release_unavailable")]
    ReleaseUnavailable,
    #[error("checksum_mismatch")]
    ChecksumMismatch,
    #[error("probe_failed: {0}")]
    ProbeFailed(String),
    #[error("unpinned_binary: running {running}, pinned {pinned}")]
    Unpinned { running: String, pinned: String },
    #[error("update I/O: {0}")]
    Io(#[from] io::Error),
}

impl UpdateError {
    pub fn class(&self) -> &'static str {
        match self {
            Self::ReleaseUnavailable => "release_unavailable",
            Self::ChecksumMismatch => "checksum_mismatch",
            Self::ProbeFailed(_) => "probe_failed",
            Self::Unpinned { .. } => "unpinned_binary",
            Self::Io(_) => "io",
        }
    }
}

/// Where staged versions, the `current` link and the pin live under `~/.oni`.
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn client(&self) -> PathBuf {
        self.root.join("machine-client")
    }

    pub fn stage(&self, version: &str) -> PathBuf {
        self.client().join("versions").join(version)
    }

    pub fn current(&self) -> PathBuf {
        self.root.join("bin/current")
    }

    pub fn executable(&self) -> PathBuf {
        self.root.join("bin/mclient")
    }

    pub fn previous(&self) -> PathBuf {
        self.root.join("bin/previous")
    }
}

/// `machine-client/pin.json`: the version this machine is pinned to, and
/// whether a host release supplied it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    pub pinned_version: String,
    pub pinned: bool,
}

#[derive(Debug)]
pub struct ReleaseDoc {
    pub version: String,
    pub contract_version: u64,
    document: Value,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Artifact {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
    pub url: String,
}

fn component(value: &str) -> Result<String, UpdateError> {
    if value.contains('/') || value == "." || value == ".." {
        return Err(UpdateError::ReleaseUnavailable);
    }
    Ok(value.to_owned())
}

pub fn parse_release(document: Value) -> Result<ReleaseDoc, UpdateError> {
    let release = oni_protocol::decode::<oni_protocol::Release>(document.clone())
        .map_err(|_| UpdateError::ReleaseUnavailable)?;
    Ok(ReleaseDoc {
        version: component(&release.version)?,
        contract_version: release.contract_version.get(),
        document,
    })
}

impl ReleaseDoc {
    pub fn artifact(&self, platform: Option<&str>) -> Result<Artifact, UpdateError> {
        let entry = platform.map_or(Value::Null, |key| self.document["artifacts"][key].clone());
        let artifact = oni_protocol::decode::<oni_protocol::ReleaseArtifact>(entry)
            .map_err(|_| UpdateError::ReleaseUnavailable)?;
        Ok(Artifact {
            name: component(&artifact.name)?,
            bytes: artifact.bytes.get(),
            sha256: artifact.sha256.to_string(),
            url: artifact.url.to_string(),
        })
    }
}

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

/// The release artifact key for an OS/arch pair, as `std::env::consts` names them.
pub fn platform(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", _) => Some("darwin-universal"),
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

/// A host release pins its version; without one the binary pins itself, unpinned.
pub fn pin_for(running: &str, release: Option<&ReleaseDoc>) -> Pin {
    release.map_or_else(
        || Pin {
            pinned_version: running.to_owned(),
            pinned: false,
        },
        |release| Pin {
            pinned_version: release.version.clone(),
            pinned: true,
        },
    )
}

pub fn load_pin(directory: &Path) -> io::Result<Option<Pin>> {
    match fs::read(directory.join("pin.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn save_pin(directory: &Path, pin: &Pin) -> io::Result<()> {
    let bytes = serde_json::to_vec(pin).map_err(io::Error::other)?;
    config::write_private(&directory.join("pin.json"), &bytes)
}

/// A binary without a matching recorded pin runs only when explicitly allowed.
pub fn admit(pin: Option<&Pin>, running: &str, allow_unpinned: bool) -> Result<(), UpdateError> {
    if !allow_unpinned && !pin.is_some_and(|pin| pin.pinned_version == running) {
        return Err(UpdateError::Unpinned {
            running: running.to_owned(),
            pinned: pin.map_or_else(|| "none".to_owned(), |pin| pin.pinned_version.clone()),
        });
    }
    Ok(())
}

/// The staged binary must speak the release's contract, and the host's when known.
pub fn compatible(own: u64, release: u64, host: Option<u64>) -> Result<(), UpdateError> {
    if own != release || host.is_some_and(|host| host != own) {
        return Err(UpdateError::ProbeFailed(format!(
            "contract {own}, release {release}, host {host:?}"
        )));
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

pub fn verify(archive: &[u8], artifact: &Artifact) -> Result<(), UpdateError> {
    let length = u64::try_from(archive.len()).map_err(|_| UpdateError::ChecksumMismatch)?;
    if length != artifact.bytes || hex::encode(Sha256::digest(archive)) != artifact.sha256 {
        return Err(UpdateError::ChecksumMismatch);
    }
    Ok(())
}

/// Points `link` at `target` through a rename, so readers see the old or the new link.
pub fn switch(link: &Path, target: &Path) -> io::Result<()> {
    let parent = link.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let name = link.file_name().unwrap_or_default().to_string_lossy();
    let staging = parent.join(format!(".{name}.{}", std::process::id()));
    match fs::remove_file(&staging) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    symlink(target, &staging)?;
    fs::rename(&staging, link)
}

/// Publish the selected binary at a real, version-independent path for macOS TCC.
pub fn publish_executable(layout: &Layout) -> io::Result<()> {
    let executable = layout.executable();
    let staging = executable.with_file_name(format!(".mclient.{}", std::process::id()));
    match fs::remove_file(&staging) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    fs::copy(layout.current(), &staging)?;
    fs::rename(staging, executable)
}

fn run(program: &Path, args: &[&str]) -> Result<Vec<u8>, UpdateError> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| UpdateError::ProbeFailed(format!("{}: {error}", program.display())))?;
    if !output.status.success() {
        return Err(UpdateError::ProbeFailed(format!(
            "{} {args:?}: {}",
            program.display(),
            output.status
        )));
    }
    Ok(output.stdout)
}

/// What `mclient --version --json` reports.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub version: String,
    pub contract_version: u64,
}

fn stage(
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

fn probe_staged(binary: &Path, release: &ReleaseDoc, host: Option<u64>) -> Result<(), UpdateError> {
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
    let mut args = vec!["probe", "--release", &document];
    if let Some(host) = &host {
        args.extend(["--host-contract", host]);
    }
    run(binary, &args).map(drop)
}

/// Stages, verifies and probes the release, then switches `current` to it.
/// Every refusal before the switch leaves `current`, the pin and the service untouched.
pub fn update(
    layout: &Layout,
    document: Value,
    base: &str,
    platform: Option<&str>,
    host: Option<u64>,
) -> Result<ReleaseDoc, UpdateError> {
    let release = parse_release(document)?;
    let artifact = release.artifact(platform)?;
    let archive =
        fetch(&resolve(base, &artifact.url)).map_err(|_| UpdateError::ReleaseUnavailable)?;
    verify(&archive, &artifact)?;
    let binary = stage(layout, &release, &artifact, &archive)?;
    let prior_pin = load_pin(&layout.client())?;
    probe_staged(&binary, &release, host)?;
    if let Ok(previous) = fs::read_link(layout.current()) {
        switch(&layout.previous(), &previous)?;
    }
    save_pin(
        &layout.client(),
        &Pin {
            pinned_version: release.version.clone(),
            pinned: true,
        },
    )?;
    if let Err(error) = switch(&layout.current(), &binary) {
        match prior_pin {
            Some(pin) => save_pin(&layout.client(), &pin)?,
            None => fs::remove_file(layout.client().join("pin.json"))?,
        }
        return Err(error.into());
    }
    Ok(release)
}

/// Copies the running binary into its version directory and points `current` at it.
pub fn adopt(layout: &Layout, running: &Path, version: &str) -> io::Result<PathBuf> {
    let target = layout.stage(version).join("mclient");
    if fs::canonicalize(running)? != fs::canonicalize(&target).unwrap_or_default() {
        fs::create_dir_all(layout.stage(version))?;
        let staging = target.with_extension("partial");
        fs::copy(running, &staging)?;
        fs::set_permissions(&staging, fs::Permissions::from_mode(0o755))?;
        fs::rename(&staging, &target)?;
    }
    switch(&layout.current(), &target)?;
    Ok(layout.current())
}

/// Join installs the verified host release when offered, and otherwise adopts itself.
pub fn join_binary(
    layout: &Layout,
    running: &Path,
    hosted: Option<Value>,
    platform: Option<&str>,
) -> Result<(PathBuf, Pin), UpdateError> {
    let Some(document) = hosted else {
        let binary = adopt(layout, running, VERSION)?;
        let pin = pin_for(VERSION, None);
        save_pin(&layout.client(), &pin)?;
        return Ok((binary, pin));
    };
    let release = parse_release(document.clone())?;
    hosted_artifact(&document, platform)?;
    let prior = load_pin(&layout.client())?;
    let current = fs::read_link(layout.current()).ok();
    if prior
        .as_ref()
        .is_some_and(|pin| pin.pinned && pin.pinned_version == release.version)
        && current.as_deref() == Some(layout.stage(&release.version).join("mclient").as_path())
    {
        return Ok((layout.current(), pin_for(VERSION, Some(&release))));
    }
    update(
        layout,
        document,
        "",
        platform,
        Some(release.contract_version),
    )?;
    Ok((layout.current(), pin_for(VERSION, Some(&release))))
}

/// The `metrics.jsonl` receipt one update attempt leaves.
pub fn receipt(outcome: &Result<ReleaseDoc, UpdateError>, at: u64) -> Value {
    match outcome {
        Ok(release) => {
            json!({"event":"update","status":"switched","version":release.version,"at":at})
        }
        Err(error) => {
            json!({"event":"update","status":"refused","reason":"update_failed","class":error.class(),"at":at})
        }
    }
}

pub fn record(
    layout: &Layout,
    outcome: &Result<ReleaseDoc, UpdateError>,
    at: u64,
) -> io::Result<()> {
    fs::create_dir_all(layout.client())?;
    report::append_line(
        &layout.client().join("metrics.jsonl"),
        &receipt(outcome, at).to_string(),
    )
}

/// Refuse a blocked receipt destination before changing the selected binary.
pub fn prepare_record(layout: &Layout) -> io::Result<()> {
    fs::create_dir_all(layout.client())?;
    fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(layout.client().join("metrics.jsonl"))?;
    Ok(())
}

pub fn restart_argv(os: &str, uid: u32) -> Vec<String> {
    if os == "macos" {
        let target = format!("gui/{uid}/ai.oni.machine");
        return ["launchctl", "kickstart", "-k", &target]
            .map(str::to_owned)
            .to_vec();
    }
    let scope: &[&str] = if uid == 0 { &[] } else { &["--user"] };
    [&["systemctl"], scope, &["restart", service::NAME]]
        .concat()
        .into_iter()
        .map(str::to_owned)
        .collect()
}

pub fn restart(argv: &[String]) -> Result<(), UpdateError> {
    let args = argv[1..].iter().map(String::as_str).collect::<Vec<_>>();
    run(Path::new(&argv[0]), &args)
        .map(drop)
        .map_err(|error| UpdateError::Io(io::Error::other(error.to_string())))
}

pub fn rollback(layout: &Layout, current: Option<&Path>, pin: Option<&Pin>) -> io::Result<()> {
    match current {
        Some(binary) => {
            switch(&layout.current(), binary)?;
            if cfg!(target_os = "macos") {
                publish_executable(layout)?;
            }
        }
        None => {
            fs::remove_file(layout.current())?;
            if cfg!(target_os = "macos") {
                match fs::remove_file(layout.executable()) {
                    Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                    _ => {}
                }
            }
        }
    }
    match pin {
        Some(pin) => save_pin(&layout.client(), pin),
        None => fs::remove_file(layout.client().join("pin.json")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(directory: &Path, body: &str, extra: &str) -> Vec<u8> {
        let mut writer = Command::new("/bin/sh")
            .args([
                "-c",
                "mkdir -p pkg && cat > pkg/mclient && chmod 755 pkg/mclient && eval \"$1\" && tar -czf archive.tgz -C pkg .",
                "sh",
                extra,
            ])
            .current_dir(directory)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("archive writer");
        std::io::Write::write_all(&mut writer.stdin.take().expect("stdin"), body.as_bytes())
            .expect("script body");
        assert!(writer.wait().expect("archive writer exit").success());
        fs::read(directory.join("archive.tgz")).expect("archive")
    }

    fn staged(version: &str, probe: u8) -> String {
        format!(
            "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '{{\"version\":\"{version}\",\"contractVersion\":2}}'; exit 0; fi\nprintf '%s ' \"$@\" > \"$(dirname \"$0\")/probe.args\"\nexit {probe}\n"
        )
    }

    fn release_for(archive: &[u8], version: &str, url: &str) -> Value {
        json!({
            "version": version,
            "contractVersion": 2,
            "artifacts": {"linux-x86_64": {
                "name": "mclient-linux-x86_64.tar.gz",
                "bytes": archive.len(),
                "sha256": hex::encode(Sha256::digest(archive)),
                "url": url,
            }},
        })
    }

    fn layout(directory: &Path) -> Layout {
        Layout::new(directory.join(".oni"))
    }

    #[test]
    fn classes_name_every_refusal() {
        let classes = [
            UpdateError::ReleaseUnavailable,
            UpdateError::ChecksumMismatch,
            UpdateError::ProbeFailed("x".to_owned()),
            UpdateError::Unpinned {
                running: "1".to_owned(),
                pinned: "2".to_owned(),
            },
            UpdateError::Io(io::Error::other("x")),
        ]
        .map(|error| error.class());
        assert_eq!(
            classes,
            [
                "release_unavailable",
                "checksum_mismatch",
                "probe_failed",
                "unpinned_binary",
                "io"
            ]
        );
    }

    #[test]
    fn layout_places_versions_current_and_previous_under_root() {
        let layout = Layout::new(PathBuf::from("/h/.oni"));
        assert_eq!(layout.client(), Path::new("/h/.oni/machine-client"));
        assert_eq!(
            layout.stage("1.2.0"),
            Path::new("/h/.oni/machine-client/versions/1.2.0")
        );
        assert_eq!(layout.current(), Path::new("/h/.oni/bin/current"));
        assert_eq!(layout.executable(), Path::new("/h/.oni/bin/mclient"));
        assert_eq!(layout.previous(), Path::new("/h/.oni/bin/previous"));
    }

    #[test]
    fn release_documents_are_schema_checked_and_path_safe() {
        let document = release_for(b"archive", "1.2.0", "a.tgz");
        let release = parse_release(document.clone()).expect("valid release");
        assert_eq!(
            (release.version.as_str(), release.contract_version),
            ("1.2.0", 2)
        );
        assert_eq!(
            release.artifact(Some("linux-x86_64")).expect("artifact"),
            Artifact {
                name: "mclient-linux-x86_64.tar.gz".to_owned(),
                bytes: 7,
                sha256: hex::encode(Sha256::digest(b"archive")),
                url: "a.tgz".to_owned(),
            }
        );
        for platform in [None, Some("linux-arm64")] {
            assert!(matches!(
                release.artifact(platform),
                Err(UpdateError::ReleaseUnavailable)
            ));
        }
        let mut unsafe_name = document.clone();
        unsafe_name["artifacts"]["linux-x86_64"]["name"] = json!("../mclient");
        let release = parse_release(unsafe_name).expect("schema accepts the name");
        assert!(matches!(
            release.artifact(Some("linux-x86_64")),
            Err(UpdateError::ReleaseUnavailable)
        ));
        for version in ["a/b", ".", ".."] {
            let mut document = document.clone();
            document["version"] = json!(version);
            assert!(matches!(
                parse_release(document),
                Err(UpdateError::ReleaseUnavailable)
            ));
        }
        assert!(matches!(
            parse_release(json!({"version": "1"})),
            Err(UpdateError::ReleaseUnavailable)
        ));
    }

    #[test]
    fn platform_keys_follow_os_and_arch() {
        assert_eq!(platform("macos", "aarch64"), Some("darwin-universal"));
        assert_eq!(platform("linux", "x86_64"), Some("linux-x86_64"));
        assert_eq!(platform("linux", "aarch64"), Some("linux-arm64"));
        assert_eq!(platform("linux", "riscv64"), None);
    }

    #[test]
    fn pins_come_from_the_host_release_or_the_running_binary() {
        let release = parse_release(release_for(b"a", "2.0.0", "a")).expect("release");
        assert_eq!(
            pin_for("1.0.0", Some(&release)),
            Pin {
                pinned_version: "2.0.0".to_owned(),
                pinned: true
            }
        );
        assert_eq!(
            pin_for("1.0.0", None),
            Pin {
                pinned_version: "1.0.0".to_owned(),
                pinned: false
            }
        );
    }

    #[test]
    fn pin_files_round_trip_and_refuse_garbage() {
        let directory = tempfile::tempdir().expect("directory");
        assert_eq!(load_pin(directory.path()).expect("absent pin"), None);
        let pin = Pin {
            pinned_version: "1.0.0".to_owned(),
            pinned: true,
        };
        save_pin(directory.path(), &pin).expect("save");
        assert_eq!(
            fs::read_to_string(directory.path().join("pin.json")).expect("pin"),
            r#"{"pinnedVersion":"1.0.0","pinned":true}"#
        );
        assert_eq!(load_pin(directory.path()).expect("pin"), Some(pin));
        fs::write(directory.path().join("pin.json"), "{").expect("garbage");
        assert!(load_pin(directory.path()).is_err());
        fs::remove_file(directory.path().join("pin.json")).expect("remove");
        fs::create_dir(directory.path().join("pin.json")).expect("directory pin");
        assert!(load_pin(directory.path()).is_err());
    }

    #[test]
    fn admission_refuses_only_an_unallowed_pin_mismatch() {
        let pin = Pin {
            pinned_version: "2".to_owned(),
            pinned: true,
        };
        assert!(matches!(
            admit(None, "1", false),
            Err(UpdateError::Unpinned { .. })
        ));
        assert!(admit(None, "1", true).is_ok());
        assert!(admit(Some(&pin), "2", false).is_ok());
        assert!(admit(Some(&pin), "1", true).is_ok());
        let error = admit(Some(&pin), "1", false).expect_err("unpinned");
        assert_eq!(error.to_string(), "unpinned_binary: running 1, pinned 2");
    }

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

    #[test]
    fn switch_replaces_links_atomically_and_reports_a_blocked_staging_path() {
        let directory = tempfile::tempdir().expect("directory");
        let link = directory.path().join("bin/current");
        switch(&link, Path::new("/one")).expect("first link");
        let staging = directory
            .path()
            .join(format!("bin/.current.{}", std::process::id()));
        fs::write(&staging, "stale").expect("stale staging");
        switch(&link, Path::new("/two")).expect("replace");
        assert_eq!(fs::read_link(&link).expect("link"), Path::new("/two"));
        assert!(!staging.exists());
        fs::create_dir(&staging).expect("blocking directory");
        fs::write(staging.join("f"), "x").expect("non-empty");
        assert!(switch(&link, Path::new("/three")).is_err());
        assert_eq!(fs::read_link(&link).expect("link"), Path::new("/two"));
    }

    #[test]
    fn published_executable_keeps_a_real_path_across_version_switches() {
        let directory = tempfile::tempdir().expect("directory");
        let layout = layout(directory.path());
        let first = directory.path().join("first");
        let second = directory.path().join("second");
        fs::write(&first, b"first").expect("first binary");
        fs::write(&second, b"second").expect("second binary");
        switch(&layout.current(), &first).expect("first version");
        publish_executable(&layout).expect("first publication");
        let original = fs::canonicalize(layout.executable()).expect("real executable");
        assert_eq!(
            original,
            fs::canonicalize(layout.root.join("bin"))
                .expect("real bin directory")
                .join("mclient")
        );
        switch(&layout.current(), &second).expect("next version");
        publish_executable(&layout).expect("next publication");
        assert_eq!(
            fs::canonicalize(layout.executable()).expect("real path"),
            original
        );
        assert_eq!(
            fs::read(layout.executable()).expect("next binary"),
            b"second"
        );
        let pin = Pin {
            pinned_version: "first".to_owned(),
            pinned: true,
        };
        fs::create_dir_all(layout.client()).expect("client directory");
        rollback(&layout, Some(&first), Some(&pin)).expect("restore selection");
        #[cfg(target_os = "macos")]
        assert_eq!(
            fs::read(layout.executable()).expect("restored binary"),
            b"first"
        );
    }

    #[test]
    fn update_stages_probes_switches_and_keeps_previous() {
        let directory = tempfile::tempdir().expect("directory");
        let archive = fixture(directory.path(), &staged("2.0.0", 0), "true");
        let layout = layout(directory.path());
        switch(&layout.current(), Path::new("/old/mclient")).expect("old current");
        fs::create_dir_all(layout.stage("2.0.0")).expect("stale stage");
        fs::write(layout.stage("2.0.0").join("stale"), "x").expect("stale file");
        let base = directory
            .path()
            .join("release.json")
            .to_string_lossy()
            .into_owned();
        let document = release_for(&archive, "2.0.0", "archive.tgz");
        let release =
            update(&layout, document, &base, Some("linux-x86_64"), Some(2)).expect("updated");
        assert_eq!(release.version, "2.0.0");
        assert_eq!(
            fs::read_link(layout.current()).expect("current"),
            layout.stage("2.0.0").join("mclient")
        );
        assert_eq!(
            fs::read_link(layout.previous()).expect("previous"),
            Path::new("/old/mclient")
        );
        assert!(!layout.stage("2.0.0").join("stale").exists());
        let release_path = layout.stage("2.0.0").join("release.json");
        assert_eq!(
            fs::read_to_string(layout.stage("2.0.0").join("probe.args")).expect("probe args"),
            format!(
                "probe --release {} --host-contract 2 ",
                release_path.display()
            )
        );
        assert_eq!(
            load_pin(&layout.client()).expect("pin"),
            Some(Pin {
                pinned_version: "2.0.0".to_owned(),
                pinned: true
            })
        );
    }

    fn refused(
        body: &str,
        extra: &str,
        edit: impl FnOnce(&mut Value),
    ) -> (UpdateError, Layout, tempfile::TempDir) {
        let directory = tempfile::tempdir().expect("directory");
        let archive = fixture(directory.path(), body, extra);
        let layout = layout(directory.path());
        switch(&layout.current(), Path::new("/old/mclient")).expect("old current");
        let mut document = release_for(&archive, "2.0.0", "archive.tgz");
        edit(&mut document);
        let base = format!("{}/release.json", directory.path().display());
        let error =
            update(&layout, document, &base, Some("linux-x86_64"), None).expect_err("refused");
        assert_eq!(
            fs::read_link(layout.current()).expect("current"),
            Path::new("/old/mclient")
        );
        assert!(!layout.previous().exists());
        assert_eq!(load_pin(&layout.client()).expect("pin"), None);
        (error, layout, directory)
    }

    #[test]
    fn every_refusal_leaves_current_and_pin_untouched() {
        let probe = staged("2.0.0", 0);
        type RefusalCase = (String, &'static str, fn(&mut Value), &'static str);
        let cases: [RefusalCase; 7] = [
            (
                probe.clone(),
                "",
                |d| d["artifacts"]["linux-x86_64"]["sha256"] = json!("0".repeat(64)),
                "checksum_mismatch",
            ),
            (
                probe.clone(),
                "",
                |d| d["artifacts"]["linux-x86_64"]["url"] = json!("absent.tgz"),
                "release_unavailable",
            ),
            (
                probe.clone(),
                "",
                |d| d["artifacts"] = json!({}),
                "release_unavailable",
            ),
            (
                probe.clone(),
                "mv pkg/mclient pkg/other",
                |_| {},
                "probe_failed",
            ),
            (staged("1.0.0", 0), "true", |_| {}, "probe_failed"),
            (staged("2.0.0", 1), "true", |_| {}, "probe_failed"),
            (
                "#!/bin/sh\necho not-json\n".to_owned(),
                "",
                |_| {},
                "probe_failed",
            ),
        ];
        for (body, extra, edit, class) in cases {
            let (error, _, _) = refused(&body, extra, edit);
            assert_eq!(error.class(), class, "{error}");
        }
    }

    #[test]
    fn updating_active_or_rollback_version_preserves_both_binaries() {
        for active in [true, false] {
            let directory = tempfile::tempdir().expect("directory");
            let archive = fixture(directory.path(), &staged("2.0.0", 0), "true");
            let layout = layout(directory.path());
            let binary = layout.stage("2.0.0").join("mclient");
            fs::create_dir_all(layout.stage("2.0.0")).expect("version directory");
            fs::write(&binary, b"retained binary").expect("retained binary");
            switch(
                &layout.current(),
                if active {
                    &binary
                } else {
                    Path::new("/old/mclient")
                },
            )
            .expect("current");
            if !active {
                switch(&layout.previous(), &binary).expect("previous");
            }
            let base = format!("{}/release.json", directory.path().display());
            let error = update(
                &layout,
                release_for(&archive, "2.0.0", "archive.tgz"),
                &base,
                Some("linux-x86_64"),
                None,
            )
            .expect_err("retained version must not be overwritten");
            assert_eq!(error.class(), "probe_failed");
            assert_eq!(
                fs::read(&binary).expect("retained binary"),
                b"retained binary"
            );
            assert_eq!(
                fs::read_link(layout.current()).expect("current"),
                if active {
                    binary
                } else {
                    PathBuf::from("/old/mclient")
                }
            );
        }
    }

    #[test]
    fn failed_pin_write_or_switch_preserves_current_and_original_pin() {
        for (block_switch, had_pin) in [(false, false), (true, true), (true, false)] {
            let directory = tempfile::tempdir().expect("directory");
            let archive = fixture(directory.path(), &staged("2.0.0", 0), "true");
            let layout = layout(directory.path());
            switch(&layout.current(), Path::new("/old/mclient")).expect("current");
            let old_pin = Pin {
                pinned_version: "1.0.0".to_owned(),
                pinned: true,
            };
            if block_switch {
                fs::create_dir_all(layout.client()).expect("client");
                if had_pin {
                    save_pin(&layout.client(), &old_pin).expect("old pin");
                }
                let staging = layout
                    .current()
                    .with_file_name(format!(".current.{}", std::process::id()));
                fs::create_dir(&staging).expect("blocked switch");
                fs::write(staging.join("occupied"), b"x").expect("occupied");
            } else {
                fs::create_dir_all(layout.client()).expect("client");
                fs::create_dir(layout.client().join("pin.json")).expect("blocked pin");
            }
            let base = format!("{}/release.json", directory.path().display());
            let error = update(
                &layout,
                release_for(&archive, "2.0.0", "archive.tgz"),
                &base,
                Some("linux-x86_64"),
                None,
            )
            .expect_err("publication refused");
            assert_eq!(error.class(), "io");
            assert_eq!(
                fs::read_link(layout.current()).expect("current"),
                Path::new("/old/mclient")
            );
            if block_switch {
                assert_eq!(
                    load_pin(&layout.client()).expect("old pin"),
                    had_pin.then_some(old_pin)
                );
            }
        }
    }

    #[test]
    fn pin_write_refusal_after_probe_does_not_switch_current() {
        let directory = tempfile::tempdir().expect("directory");
        let body = staged("2.0.0", 0).replace(
            "exit 0\n",
            "if [ \"$1\" = probe ]; then client=\"$(dirname \"$(dirname \"$(dirname \"$0\")\")\")\"; mv \"$client\" \"$client.moved\"; printf blocked > \"$client\"; fi\nexit 0\n",
        );
        let archive = fixture(directory.path(), &body, "true");
        let layout = layout(directory.path());
        switch(&layout.current(), Path::new("/old/mclient")).expect("old current");
        let base = format!("{}/release.json", directory.path().display());
        let error = update(
            &layout,
            release_for(&archive, "2.0.0", "archive.tgz"),
            &base,
            Some("linux-x86_64"),
            None,
        )
        .expect_err("pin write blocked");
        assert_eq!(
            fs::read_to_string(
                layout
                    .client()
                    .with_extension("moved")
                    .join("versions/2.0.0/probe.args")
            )
            .expect("successful probe"),
            "probe --release ".to_owned()
                + &layout
                    .stage("2.0.0")
                    .join("release.json")
                    .display()
                    .to_string()
                + " "
        );
        assert!(
            matches!(error, UpdateError::Io(ref refusal) if refusal.kind() == io::ErrorKind::NotADirectory),
            "expected pin write I/O refusal: {error}"
        );
        assert_eq!(
            error.to_string(),
            format!(
                "update I/O: {}",
                io::Error::from_raw_os_error(nix::libc::ENOTDIR)
            )
        );
        assert_eq!(
            fs::read_link(layout.current()).expect("original current"),
            Path::new("/old/mclient")
        );
    }

    #[test]
    fn corrupt_archives_and_blocked_stages_are_refused() {
        let directory = tempfile::tempdir().expect("directory");
        let layout = layout(directory.path());
        let base = format!("{}/release.json", directory.path().display());
        fs::write(directory.path().join("archive.tgz"), b"not gzip").expect("corrupt");
        let document = release_for(b"not gzip", "2.0.0", "archive.tgz");
        let error = update(&layout, document.clone(), &base, Some("linux-x86_64"), None)
            .expect_err("tar fails");
        assert_eq!(error.class(), "probe_failed");
        fs::remove_dir_all(layout.stage("2.0.0")).expect("clear stage");
        fs::write(layout.stage("2.0.0"), "file").expect("stage blocked by a file");
        let error =
            update(&layout, document, &base, Some("linux-x86_64"), None).expect_err("blocked");
        assert_eq!(error.class(), "io");
    }

    #[test]
    fn adopt_copies_the_running_binary_once() {
        let directory = tempfile::tempdir().expect("directory");
        let layout = layout(directory.path());
        let running = directory.path().join("mclient");
        fs::write(&running, "binary").expect("running binary");
        let current = adopt(&layout, &running, "1.0.0").expect("adopted");
        let target = layout.stage("1.0.0").join("mclient");
        assert_eq!(fs::read_link(&current).expect("current"), target);
        assert_eq!(fs::read_to_string(&target).expect("copy"), "binary");
        assert_eq!(
            fs::metadata(&target).expect("mode").permissions().mode() & 0o777,
            0o755
        );
        fs::write(&running, "changed").expect("rewrite");
        adopt(&layout, &current, "1.0.0").expect("re-adopted from current");
        assert_eq!(fs::read_to_string(&target).expect("unchanged"), "binary");
        assert!(adopt(&layout, &directory.path().join("absent"), "1.0.0").is_err());
    }

    #[test]
    fn join_installs_host_version_before_service_or_adopts_itself_without_release() {
        let directory = tempfile::tempdir().expect("directory");
        let layout = layout(directory.path());
        let running = directory.path().join("running");
        fs::write(&running, b"local client").expect("local binary");
        let archive = fixture(directory.path(), &staged("2.0.0", 0), "true");
        let document = release_for(
            &archive,
            "2.0.0",
            &format!("file://{}/archive.tgz", directory.path().display()),
        );
        let (current, pin) = join_binary(
            &layout,
            &running,
            Some(document.clone()),
            Some("linux-x86_64"),
        )
        .expect("host-pinned join");
        assert_eq!(pin.pinned_version, "2.0.0");
        assert!(pin.pinned);
        assert_eq!(
            fs::read_link(&current).expect("verified binary"),
            layout.stage("2.0.0").join("mclient")
        );
        join_binary(&layout, &running, Some(document), Some("linux-x86_64"))
            .expect("rejoin retains active version");
        assert_eq!(
            fs::read_link(&current).expect("retained binary"),
            layout.stage("2.0.0").join("mclient")
        );
        let other = Layout::new(directory.path().join("other/.oni"));
        let (current, pin) = join_binary(&other, &running, None, None).expect("offline join");
        assert!(!pin.pinned);
        assert_eq!(pin.pinned_version, VERSION);
        assert_eq!(
            fs::read_link(current).expect("adopted binary"),
            other.stage(VERSION).join("mclient")
        );
        let mut invalid = release_for(
            &archive,
            "2.0.0",
            &format!("file://{}/archive.tgz", directory.path().display()),
        );
        invalid["artifacts"]["linux-x86_64"]["sha256"] = json!("0".repeat(64));
        let error = join_binary(&other, &running, Some(invalid), Some("linux-x86_64"))
            .expect_err("bad host archive");
        assert_eq!(error.class(), "checksum_mismatch");
        assert_eq!(
            fs::read_link(other.current()).expect("original current"),
            other.stage(VERSION).join("mclient")
        );
        assert_eq!(
            load_pin(&other.client()).expect("original pin"),
            Some(Pin {
                pinned_version: VERSION.to_owned(),
                pinned: false,
            })
        );
    }

    #[test]
    fn receipts_record_switches_and_refusal_classes() {
        let directory = tempfile::tempdir().expect("directory");
        let layout = layout(directory.path());
        let switched = parse_release(release_for(b"a", "2.0.0", "a"));
        record(&layout, &switched, 7).expect("switched receipt");
        record(&layout, &Err(UpdateError::ChecksumMismatch), 8).expect("refused receipt");
        assert_eq!(
            fs::read_to_string(layout.client().join("metrics.jsonl")).expect("receipts"),
            "{\"at\":7,\"event\":\"update\",\"status\":\"switched\",\"version\":\"2.0.0\"}\n\
             {\"at\":8,\"class\":\"checksum_mismatch\",\"event\":\"update\",\"reason\":\"update_failed\",\"status\":\"refused\"}\n"
        );
    }

    #[test]
    fn restart_commands_follow_the_service_manager() {
        assert_eq!(
            restart_argv("macos", 501),
            ["launchctl", "kickstart", "-k", "gui/501/ai.oni.machine"]
        );
        assert_eq!(
            restart_argv("linux", 0),
            ["systemctl", "restart", service::NAME]
        );
        assert_eq!(
            restart_argv("linux", 1000),
            ["systemctl", "--user", "restart", service::NAME]
        );
        assert!(restart(&["true".to_owned()]).is_ok());
        assert!(matches!(
            restart(&["false".to_owned()]),
            Err(UpdateError::Io(_))
        ));
        assert!(matches!(
            restart(&["/absent/manager".to_owned()]),
            Err(UpdateError::Io(_))
        ));
    }

    #[test]
    fn rollback_restores_original_link_and_pin_after_restart_refusal() {
        for had_original in [false, true] {
            let directory = tempfile::tempdir().expect("directory");
            let layout = layout(directory.path());
            fs::create_dir_all(layout.client()).expect("client");
            let original = Pin {
                pinned_version: "1.0.0".to_owned(),
                pinned: true,
            };
            if had_original {
                let old = directory.path().join("old");
                fs::write(&old, b"old binary").expect("old binary");
                switch(&layout.current(), &old).expect("old");
                save_pin(&layout.client(), &original).expect("old pin");
            }
            let current = fs::read_link(layout.current()).ok();
            let pin = load_pin(&layout.client()).expect("original pin");
            switch(&layout.current(), Path::new("/new/mclient")).expect("new");
            save_pin(
                &layout.client(),
                &Pin {
                    pinned_version: "2.0.0".to_owned(),
                    pinned: true,
                },
            )
            .expect("new pin");
            rollback(&layout, current.as_deref(), pin.as_ref()).expect("rollback");
            assert_eq!(fs::read_link(layout.current()).ok(), current);
            assert_eq!(load_pin(&layout.client()).expect("restored pin"), pin);
        }
    }
}
