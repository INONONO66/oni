//! Release pin, staged update and atomic `current` switch (#1696).
//!
//! Every decision lives here, free of `cfg(target_os)`: the platform key and
//! the service restart command take the OS as a value, so both branches run
//! in every test build.
//!
//! `fetch` reads release documents and archives, `verify` proves an archive
//! and its staged binary are the release they claim, and `switch` publishes
//! a verified binary and undoes a publication the service refuses; this
//! module owns the shared types and the two sequences built from them.

mod fetch;
mod switch;
mod verify;

#[cfg(test)]
mod fixtures;

use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use fetch::{document, fetch, hosted_artifact, resolve};
pub use switch::{
    adopt, prepare_record, publish_executable, receipt, record, restart, restart_argv, rollback,
    switch,
};
pub use verify::{compatible, verify, Identity};

use crate::config;

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
    let binary = verify::stage(layout, &release, &artifact, &archive)?;
    let prior_pin = load_pin(&layout.client())?;
    verify::probe_staged(&binary, &release, host)?;
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

#[cfg(test)]
mod tests {
    use super::fixtures::{fixture, layout, release_for, staged};
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};

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
                "update --check --file {} --host-contract 2 ",
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
            "if [ \"$2\" = --check ]; then client=\"$(dirname \"$(dirname \"$(dirname \"$0\")\")\")\"; mv \"$client\" \"$client.moved\"; printf blocked > \"$client\"; fi\nexit 0\n",
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
            "update --check --file ".to_owned()
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
}
