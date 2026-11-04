//! Publishing a verified binary as `current`, the receipt and service restart around
//! it, and the rollback that undoes a publication the service refuses.

use std::{
    fs, io,
    os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};

use super::{run, save_pin, Layout, Pin, ReleaseDoc, UpdateError};
use crate::{report, service};

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
    remove_if_present(&staging)?;
    fs::copy(layout.current(), &staging)?;
    fs::rename(staging, executable)
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
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
        Some(binary) => switch(&layout.current(), binary)?,
        None => fs::remove_file(layout.current())?,
    }
    #[cfg(target_os = "macos")]
    match current {
        Some(_) => publish_executable(layout)?,
        None => remove_if_present(&layout.executable())?,
    }
    match pin {
        Some(pin) => save_pin(&layout.client(), pin),
        None => fs::remove_file(layout.client().join("pin.json")),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        fixtures::{layout, release_for},
        load_pin, parse_release,
    };
    use super::*;

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
