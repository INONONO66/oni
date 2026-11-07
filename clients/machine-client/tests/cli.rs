#[path = "support/tls.rs"]
mod tls;

use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    process::{Command, Output, Stdio},
};

fn mclient(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_mclient"))
        .args(args)
        .output()
        .expect("mclient runs")
}

fn release_fixture(home: &std::path::Path) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    let package = home.join("package");
    std::fs::create_dir(&package).expect("archive staging");
    std::fs::copy(env!("CARGO_BIN_EXE_mclient"), package.join("mclient")).expect("binary");
    let archive = home.join("archive.tgz");
    assert!(Command::new("tar")
        .args([
            "-czf",
            archive.to_str().expect("archive"),
            "-C",
            package.to_str().expect("package"),
            "mclient"
        ])
        .status()
        .expect("tar")
        .success());
    let bytes = std::fs::read(&archive).expect("archive bytes");
    let platform = if cfg!(target_os = "macos") {
        "darwin-universal"
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux-x86_64"
    };
    let release = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "contractVersion": oni_protocol::CONTRACT_VERSION,
        "artifacts": { platform: {
            "name": "archive.tgz",
            "bytes": bytes.len(),
            "sha256": hex::encode(Sha256::digest(&bytes)),
            "url": "archive.tgz"
        }}
    });
    let path = home.join("release.json");
    std::fs::write(&path, release.to_string()).expect("release");
    path
}

fn update_fixture(home: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::symlink;
    let release = release_fixture(home);
    let root = home.join(".oni");
    std::fs::create_dir_all(root.join("machine-client")).expect("client");
    std::fs::create_dir_all(root.join("bin")).expect("bin");
    let old = home.join("old-client");
    std::fs::write(&old, "#!/bin/sh\nprintf '{\"version\":\"old\"}\\n'\n").expect("old");
    std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o755)).expect("old executable");
    symlink(&old, root.join("bin/current")).expect("current");
    #[cfg(target_os = "macos")]
    std::fs::copy(&old, root.join("bin/mclient")).expect("old service executable");
    std::fs::write(
        root.join("machine-client/pin.json"),
        r#"{"pinnedVersion":"old","pinned":true}"#,
    )
    .expect("pin");
    (release, old)
}

fn update_manager(home: &std::path::Path) -> (String, std::path::PathBuf) {
    let bin = home.join("manager");
    std::fs::create_dir(&bin).expect("manager directory");
    let command = bin.join(if cfg!(target_os = "macos") {
        "launchctl"
    } else {
        "systemctl"
    });
    let service_binary = if cfg!(target_os = "macos") {
        "mclient"
    } else {
        "current"
    };
    std::fs::write(&command, format!("#!/bin/sh\nif [ -f \"$MCLIENT_FAIL_ONCE\" ]; then\n  rm \"$MCLIENT_FAIL_ONCE\"\n  exit 1\nfi\n\"$HOME/.oni/bin/{service_binary}\" --version --json >> \"$MCLIENT_SERVICE_LOG\"\n")).expect("manager");
    std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755))
        .expect("manager executable");
    (
        format!("{}:{}", bin.display(), std::env::var("PATH").expect("PATH")),
        home.join("manager.log"),
    )
}

#[test]
fn successful_update_restarts_and_records_the_selected_binary() {
    let home = tempfile::tempdir().expect("home");
    let (release, _) = update_fixture(home.path());
    let (path, log) = update_manager(home.path());
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .env("PATH", path)
        .env("MCLIENT_SERVICE_LOG", &log)
        .env("MCLIENT_FAIL_ONCE", home.path().join("absent-marker"))
        .args(["update", "--file", release.to_str().expect("release")])
        .current_dir("/")
        .output()
        .expect("update");
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("switched result");
    assert_eq!(result["status"], "switched");
    let version: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&log).expect("manager restarted binary"))
            .expect("new binary version");
    assert_eq!(version["version"], env!("CARGO_PKG_VERSION"));
    let root = home.path().join(".oni");
    let pin: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("machine-client/pin.json")).expect("pin"))
            .expect("pin json");
    assert_eq!(pin["pinnedVersion"], env!("CARGO_PKG_VERSION"));
    #[cfg(target_os = "macos")]
    {
        let executable = root.join("bin/mclient");
        assert_eq!(
            std::fs::canonicalize(&executable).expect("real path"),
            std::fs::canonicalize(root.join("bin"))
                .expect("real bin directory")
                .join("mclient")
        );
        assert_eq!(
            std::fs::read(&executable).expect("installed binary"),
            std::fs::read(root.join("bin/current")).expect("selected binary")
        );
    }
    let receipt: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("machine-client/metrics.jsonl")).expect("receipt"),
    )
    .expect("receipt json");
    assert_eq!(receipt["status"], "switched");
}

#[test]
fn failed_restart_recovers_previous_service_and_records_refusal() {
    let home = tempfile::tempdir().expect("home");
    let (release, old) = update_fixture(home.path());
    let (path, log) = update_manager(home.path());
    let marker = home.path().join("fail-once");
    std::fs::write(&marker, "").expect("fail first restart");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .env("PATH", path)
        .env("MCLIENT_SERVICE_LOG", &log)
        .env("MCLIENT_FAIL_ONCE", &marker)
        .args(["update", "--file", release.to_str().expect("release")])
        .output()
        .expect("update");
    assert_eq!(output.status.code(), Some(2));
    let refusal: serde_json::Value = serde_json::from_slice(&output.stderr).expect("refusal");
    assert_eq!(refusal["reason"], "update_failed");
    assert_eq!(refusal["class"], "io");
    let root = home.path().join(".oni");
    assert_eq!(
        std::fs::read_link(root.join("bin/current")).expect("restored link"),
        old
    );
    let version: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&log).expect("old client ran"))
            .expect("recovered service");
    assert_eq!(version["version"], "old");
    #[cfg(target_os = "macos")]
    assert_eq!(
        std::fs::read(root.join("bin/mclient")).expect("restored executable"),
        std::fs::read(&old).expect("previous executable")
    );
    let receipt: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("machine-client/metrics.jsonl")).expect("receipt"),
    )
    .expect("receipt json");
    assert_eq!(receipt["status"], "refused");
}

#[test]
fn failed_restart_without_previous_selection_removes_new_link() {
    let home = tempfile::tempdir().expect("home");
    let (release, _) = update_fixture(home.path());
    let current = home.path().join(".oni/bin/current");
    std::fs::remove_file(&current).expect("no prior binary");
    let (path, log) = update_manager(home.path());
    let marker = home.path().join("fail-once");
    std::fs::write(&marker, "").expect("fail first restart");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .env("PATH", path)
        .env("MCLIENT_SERVICE_LOG", &log)
        .env("MCLIENT_FAIL_ONCE", marker)
        .args(["update", "--file", release.to_str().expect("release")])
        .output()
        .expect("update");
    assert_eq!(output.status.code(), Some(2));
    let refusal: serde_json::Value = serde_json::from_slice(&output.stderr).expect("refusal");
    assert_eq!(refusal["class"], "io");
    assert!(!current.exists());
    #[cfg(target_os = "macos")]
    assert!(!home.path().join(".oni/bin/mclient").exists());
    assert!(!log.exists());
}

#[test]
fn failed_restart_and_rollback_report_both_errors() {
    let home = tempfile::tempdir().expect("home");
    let (release, _) = update_fixture(home.path());
    let (path, log) = update_manager(home.path());
    let manager = home.path().join(if cfg!(target_os = "macos") {
        "manager/launchctl"
    } else {
        "manager/systemctl"
    });
    std::fs::write(
        manager,
        "#!/bin/sh\nrm \"$HOME/.oni/bin/current\"\nrmdir \"$HOME/.oni/bin\"\nprintf blocked > \"$HOME/.oni/bin\"\nexit 1\n",
    )
    .expect("manager sabotages rollback");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .env("PATH", path)
        .env("MCLIENT_SERVICE_LOG", log)
        .args(["update", "--file", release.to_str().expect("release")])
        .output()
        .expect("update");
    assert_eq!(output.status.code(), Some(2));
    let refusal: serde_json::Value = serde_json::from_slice(&output.stderr).expect("refusal");
    assert_eq!(refusal["class"], "io");
    assert!(refusal["detail"]
        .as_str()
        .expect("detail")
        .contains("recovery failed:"));
}

#[test]
fn blocked_receipt_prevents_switch_and_restart() {
    let home = tempfile::tempdir().expect("home");
    let (release, old) = update_fixture(home.path());
    let root = home.path().join(".oni");
    std::fs::create_dir(root.join("machine-client/metrics.jsonl")).expect("blocked receipt");
    let (path, log) = update_manager(home.path());
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .env("PATH", path)
        .env("MCLIENT_SERVICE_LOG", &log)
        .args(["update", "--file", release.to_str().expect("release")])
        .output()
        .expect("update");
    assert_eq!(output.status.code(), Some(2));
    let refusal: serde_json::Value = serde_json::from_slice(&output.stderr).expect("refusal");
    assert_eq!(refusal["reason"], "update_failed");
    assert_eq!(
        std::fs::read_link(root.join("bin/current")).expect("original link"),
        old
    );
    assert!(!log.exists());
}

#[test]
fn receipt_failure_after_restart_restores_previous_service() {
    let home = tempfile::tempdir().expect("home");
    let (release, old) = update_fixture(home.path());
    let (path, log) = update_manager(home.path());
    let manager = home.path().join(if cfg!(target_os = "macos") {
        "manager/launchctl"
    } else {
        "manager/systemctl"
    });
    std::fs::write(
        manager,
        "#!/bin/sh\n\"$HOME/.oni/bin/current\" --version --json >> \"$MCLIENT_SERVICE_LOG\"\nif [ -f \"$MCLIENT_BLOCK_RECEIPT\" ]; then\n  rm \"$MCLIENT_BLOCK_RECEIPT\"\n  rm \"$HOME/.oni/machine-client/metrics.jsonl\"\n  mkdir \"$HOME/.oni/machine-client/metrics.jsonl\"\nfi\n",
    )
    .expect("manager");
    let marker = home.path().join("block-after-restart");
    std::fs::write(&marker, "").expect("receipt failure marker");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .env("PATH", path)
        .env("MCLIENT_SERVICE_LOG", &log)
        .env("MCLIENT_BLOCK_RECEIPT", &marker)
        .args(["update", "--file", release.to_str().expect("release")])
        .output()
        .expect("update");
    assert_eq!(output.status.code(), Some(2));
    let refusal: serde_json::Value = serde_json::from_slice(&output.stderr).expect("refusal");
    assert_eq!(refusal["reason"], "update_failed");
    assert_eq!(refusal["class"], "io");
    let root = home.path().join(".oni");
    assert_eq!(
        std::fs::read_link(root.join("bin/current")).expect("restored link"),
        old
    );
    let records = std::fs::read_to_string(log).expect("restarted versions");
    let versions = records
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line).expect("version")["version"].clone()
        })
        .collect::<Vec<_>>();
    assert_eq!(versions, [env!("CARGO_PKG_VERSION"), "old"]);
}

#[tokio::test]
async fn failed_join_service_install_restores_previous_host_pin_and_client() {
    let home = tempfile::tempdir().expect("home");
    let (release, old) = update_fixture(home.path());
    let mut document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&release).expect("release")).expect("document");
    let platform = if cfg!(target_os = "macos") {
        "darwin-universal"
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux-x86_64"
    };
    document["artifacts"][platform]["url"] = serde_json::json!(format!(
        "file://{}",
        home.path().join("archive.tgz").display()
    ));
    let socket = home.path().join("host.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("release host");
    let (path, log) = update_manager(home.path());
    if cfg!(target_os = "macos") {
        std::fs::write(
            home.path().join("manager/launchctl"),
            "#!/bin/sh\nif [ \"$1\" = print ]; then exit 1; fi\nif [ -f \"$MCLIENT_FAIL_ONCE\" ]; then rm \"$MCLIENT_FAIL_ONCE\"; exit 1; fi\n\"$HOME/.oni/bin/current\" --version --json >> \"$MCLIENT_SERVICE_LOG\"\n",
        )
        .expect("manager refuses bootstrap");
    }
    let marker = home.path().join("fail-once");
    std::fs::write(&marker, "").expect("manager failure");
    let service_dir = home.path().join("services");
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .env("PATH", path)
        .env("MCLIENT_SERVICE_LOG", &log)
        .env("MCLIENT_FAIL_ONCE", &marker)
        .args([
            "join",
            "localhost",
            "--unix",
            socket.to_str().expect("socket"),
            "--service-dir",
            service_dir.to_str().expect("service path"),
            "--no-open",
        ])
        .current_dir("/")
        .output();
    let exchange = async {
        use oni_machine_client::transport::framing::{write_frame, Framed};
        use tokio::io::AsyncWriteExt;
        let (stream, _) = listener.accept().await.expect("release connection");
        let (reader, mut writer) = tokio::io::split(stream);
        let request = Framed::new(reader)
            .next()
            .await
            .expect("release frame")
            .expect("release request");
        assert_eq!(request["method"], "machine.release");
        write_frame(
            &mut writer,
            &serde_json::json!({
                "v": 2, "type": "response", "id": request["id"],
                "result": {"status": "available", "release": document}
            }),
        )
        .await
        .expect("release reply");
        writer.flush().await.expect("flush response");
    };
    let (output, ()) = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        tokio::join!(child, exchange)
    })
    .await
    .expect("join release handshake");
    let output = output.expect("join process");
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("service install failed"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let root = home.path().join(".oni");
    assert_eq!(
        std::fs::read_link(root.join("bin/current")).expect("old current"),
        old
    );
    let pin: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("machine-client/pin.json")).expect("old pin"),
    )
    .expect("pin json");
    assert_eq!(pin["pinnedVersion"], "old");
    let running: serde_json::Value =
        serde_json::from_slice(&std::fs::read(log).expect("original client restarted"))
            .expect("version");
    assert_eq!(running["version"], "old");
}

#[test]
fn update_check_verifies_release_contract_without_connecting_or_switching() {
    let home = tempfile::tempdir().expect("home");
    let release = release_fixture(home.path());
    let path = release.to_str().expect("release path");
    let check = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home.path())
            .args(["update", "--check", "--file", path])
            .args(args)
            .output()
            .expect("update --check")
    };
    let own = oni_protocol::CONTRACT_VERSION.to_string();
    let accepted = check(&["--host-contract", &own]);
    assert_eq!(accepted.status.code(), Some(0));
    let response: serde_json::Value = serde_json::from_slice(&accepted.stdout).expect("check");
    assert_eq!(response["status"], "compatible");
    assert_eq!(response["version"], env!("CARGO_PKG_VERSION"));
    let refused = check(&["--host-contract", "2"]);
    assert_eq!(refused.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&refused.stderr).expect("refusal");
    assert_eq!(error["class"], "probe_failed");
    assert!(!home.path().join(".oni/bin/current").exists());
    assert!(!home
        .path()
        .join(".oni/machine-client/metrics.jsonl")
        .exists());
    let orphan = mclient(&["update", "--host-contract", "4"]);
    assert_eq!(orphan.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&orphan.stderr).contains("--check"));
    // A client staging this binary from a release before `update --check` still
    // calls `probe --release`; the hidden alias answers exactly like the check.
    let legacy = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args(["probe", "--release", path, "--host-contract", &own])
        .output()
        .expect("probe --release");
    assert_eq!(legacy.status.code(), Some(0));
    assert_eq!(legacy.stdout, accepted.stdout);
}

#[tokio::test]
async fn update_check_without_a_document_asks_the_host_for_its_release() {
    let home = tempfile::tempdir().expect("home");
    let release = release_fixture(home.path());
    let mut document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&release).expect("release")).expect("document");
    // A hosted document carries absolute artifact URLs; the fixture's is relative.
    let platform =
        oni_machine_client::release::platform(std::env::consts::OS, std::env::consts::ARCH)
            .expect("supported build platform");
    document["artifacts"][platform]["url"] = serde_json::json!(format!(
        "file://{}",
        home.path().join("archive.tgz").display()
    ));
    let socket = home.path().join("host.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("release host");
    let joined = mclient_at(
        home.path(),
        &[
            "join",
            "localhost",
            "--unix",
            socket.to_str().expect("socket"),
            "--no-service",
            "--no-open",
        ],
    );
    let listener = &listener;
    let serve = |response: serde_json::Value| async move {
        use oni_machine_client::transport::framing::{write_frame, Framed};
        use tokio::io::AsyncWriteExt;
        let (stream, _) = listener.accept().await.expect("release connection");
        let (reader, mut writer) = tokio::io::split(stream);
        let request = Framed::new(reader)
            .next()
            .await
            .expect("release frame")
            .expect("release request");
        assert_eq!(request["method"], "machine.release");
        write_frame(
            &mut writer,
            &serde_json::json!({
                "v": 2, "type": "response", "id": request["id"], "result": response
            }),
        )
        .await
        .expect("release reply");
        writer.flush().await.expect("flush response");
    };
    let (joined, ()) = tokio::join!(
        joined,
        serve(serde_json::json!({"status": "refused", "reason": "release_unavailable"}))
    );
    assert_eq!(
        joined.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&joined.stderr)
    );
    let current = home.path().join(".oni/bin/current");
    let adopted = std::fs::read_link(&current).expect("join adopted the running binary");
    let metrics = home.path().join(".oni/machine-client/metrics.jsonl");
    let receipts = std::fs::read_to_string(&metrics).ok();
    let check = mclient_at(home.path(), &["update", "--check"]);
    let (checked, ()) = tokio::join!(
        check,
        serve(serde_json::json!({"status": "available", "release": document}))
    );
    assert_eq!(
        checked.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&checked.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&checked.stdout).expect("check");
    assert_eq!(response["status"], "compatible");
    assert_eq!(std::fs::read_link(&current).expect("current"), adopted);
    assert_eq!(std::fs::read_to_string(&metrics).ok(), receipts);
}

/// Runs the binary with `HOME` isolated, off the test thread so a fake host
/// on the same runtime can answer it.
fn mclient_at(
    home: &std::path::Path,
    args: &[&str],
) -> impl std::future::Future<Output = Output> + use<> {
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home)
        .args(args)
        .output();
    async move { output.await.expect("mclient runs") }
}

#[test]
fn update_refusals_preserve_selection_and_record_class() {
    let home = tempfile::tempdir().expect("home");
    let (release, old) = update_fixture(home.path());
    let source = release.to_str().expect("release");
    let run = |path: &str| {
        Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home.path())
            .args(["update", "--file", path])
            .output()
            .expect("update")
    };
    let missing = run(&home.path().join("missing.json").to_string_lossy());
    assert_eq!(missing.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&missing.stderr).expect("refusal");
    assert_eq!(error["class"], "release_unavailable");
    let mut document: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&release).expect("release")).expect("json");
    document["artifacts"][if cfg!(target_os = "macos") {
        "darwin-universal"
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux-x86_64"
    }]["sha256"] = serde_json::json!("0".repeat(64));
    std::fs::write(&release, document.to_string()).expect("corrupt digest");
    let mismatch = run(source);
    assert_eq!(mismatch.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&mismatch.stderr).expect("refusal");
    assert_eq!(error["class"], "checksum_mismatch");
    assert_eq!(
        std::fs::read_link(home.path().join(".oni/bin/current")).expect("current"),
        old
    );
    let receipts = std::fs::read_to_string(home.path().join(".oni/machine-client/metrics.jsonl"))
        .expect("receipts");
    let entries = receipts
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("json"))
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["class"], "release_unavailable");
    assert_eq!(entries[1]["class"], "checksum_mismatch");
}

#[test]
fn version_prints_client_and_contract_version() {
    let output = mclient(&["--version"]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(output.stdout).expect("utf-8 stdout"),
        format!(
            "mclient {} contract {}\n",
            env!("CARGO_PKG_VERSION"),
            oni_protocol::CONTRACT_VERSION
        )
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn version_json_reports_machine_consumed_identity() {
    let output = mclient(&["--version", "--json"]);
    assert_eq!(output.status.code(), Some(0));
    let identity: serde_json::Value = serde_json::from_slice(&output.stdout).expect("identity");
    assert_eq!(identity["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(identity["contractVersion"], oni_protocol::CONTRACT_VERSION);
}

#[test]
fn run_requires_a_saved_pin_before_opening_a_connection() {
    let directory = tempfile::tempdir().expect("isolated config");
    let file = directory.path().join("client.json");
    let output = mclient(&["run", "--config", file.to_str().expect("path")]);
    assert_eq!(output.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("refusal");
    assert_eq!(error["reason"], "unpinned_binary");
    assert_eq!(error["class"], "unpinned_binary");
}

#[test]
fn run_admits_a_saved_offline_pin_before_loading_config() {
    let directory = tempfile::tempdir().expect("isolated config");
    std::fs::write(
        directory.path().join("pin.json"),
        format!(
            r#"{{"pinnedVersion":"{}","pinned":false}}"#,
            env!("CARGO_PKG_VERSION")
        ),
    )
    .expect("offline pin");
    let file = directory.path().join("client.json");
    let output = mclient(&["run", "--once", "--config", file.to_str().expect("path")]);
    assert_eq!(output.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("refusal");
    assert!(error["reason"]
        .as_str()
        .expect("reason")
        .contains("configuration I/O"));
}

/// A network host is shown to the operator with its verified pin and the
/// answer comes from stdin: a closed stdin records nothing and refuses typed,
/// `y` records exactly the pin that was shown, and `--yes` never prompts.
#[tokio::test]
async fn join_prompts_for_the_host_pin_unless_yes() {
    struct TlsHost {
        endpoint: String,
        certificate: String,
    }
    /// A host for one `join` to verify: it answers one TLS handshake with a
    /// fresh identity and serves nothing after it. The client's own key is
    /// not enrolled here, so the acceptor refuses it once the server
    /// certificate (all the join reads) has gone out.
    async fn tls_host() -> TlsHost {
        let (certificate, private_key) = tls::identity();
        let acceptor = tls::acceptor(&certificate, &private_key, &[&rustls::version::TLS13]);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind TCP socket");
        let endpoint = listener.local_addr().expect("listener address").to_string();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept TCP peer");
            let _ = acceptor.accept(tcp).await;
        });
        TlsHost {
            endpoint,
            certificate,
        }
    }
    /// Joins `host` over `--host-cert` with stdin closed, or answering `answer`.
    async fn join(
        home: &std::path::Path,
        cert: &str,
        host: &TlsHost,
        yes: bool,
        answer: Option<&[u8]>,
    ) -> Output {
        std::fs::write(cert, &host.certificate).expect("certificate");
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_mclient"));
        command
            .env("HOME", home)
            .args([
                "join",
                &host.endpoint,
                "--host-cert",
                cert,
                "--no-service",
                "--no-open",
            ])
            .args(if yes { &["--yes"][..] } else { &[] })
            .stdin(if answer.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().expect("mclient spawns");
        if let Some(answer) = answer {
            let mut stdin = child.stdin.take().expect("stdin");
            tokio::io::AsyncWriteExt::write_all(&mut stdin, answer)
                .await
                .expect("answer");
        }
        child.wait_with_output().await.expect("mclient runs")
    }
    let home = tempfile::tempdir().expect("home");
    let certificate = home.path().join("host-cert.pem");
    let cert = certificate.to_str().expect("certificate path");
    let client = home.path().join(".oni/machine-client");
    let host = tls_host().await;
    let declined = join(home.path(), cert, &host, false, None).await;
    assert_eq!(declined.status.code(), Some(3));
    assert!(declined.stdout.is_empty());
    let stderr = String::from_utf8(declined.stderr).expect("stderr");
    let mut lines = stderr.lines();
    assert_eq!(
        lines.next(),
        Some(format!("host: {}", host.endpoint).as_str())
    );
    let shown = lines
        .next()
        .and_then(|line| line.strip_prefix("host pin: "))
        .expect("pin line");
    assert_eq!(shown.len(), 64);
    assert_eq!(lines.next(), Some("trust this host? [y/N] "));
    let refusal: serde_json::Value =
        serde_json::from_str(lines.next().expect("refusal")).expect("JSON refusal");
    assert_eq!(refusal["reason"], "host_untrusted");
    assert!(!client.join("host-pin").exists());
    assert!(!client.join("client.json").exists());

    let host = tls_host().await;
    let approved = join(home.path(), cert, &host, false, Some(b"y\n")).await;
    let stderr = String::from_utf8(approved.stderr).expect("stderr");
    assert_eq!(approved.status.code(), Some(0), "{stderr}");
    let shown = stderr
        .lines()
        .nth(1)
        .and_then(|line| line.strip_prefix("host pin: "))
        .expect("pin line");
    assert_eq!(
        std::fs::read_to_string(client.join("host-pin")).expect("recorded pin"),
        shown
    );
    assert!(client.join("client.json").exists());

    let host = tls_host().await;
    let scripted = join(home.path(), cert, &host, true, None).await;
    let stderr = String::from_utf8(scripted.stderr).expect("stderr");
    assert_eq!(scripted.status.code(), Some(0), "{stderr}");
    assert!(!stderr.contains("trust this host?"));
}

#[test]
fn join_requires_an_explicit_pin_or_certificate_for_a_network_host() {
    let directory = tempfile::tempdir().expect("isolated home");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", directory.path())
        .args(["join", "127.0.0.1"])
        .output()
        .expect("mclient runs");
    assert_eq!(output.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("JSON refusal");
    assert_eq!(error["reason"], "pin_required");
    assert!(output.stdout.is_empty());
}

#[test]
fn run_reports_missing_config() {
    let directory = tempfile::tempdir().expect("temporary config directory");
    let path = directory.path().join("absent.json");
    let output = mclient(&[
        "run",
        "--allow-unpinned",
        "--once",
        "--config",
        path.to_str().expect("path"),
    ]);
    assert_eq!(output.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("JSON refusal");
    assert!(error["reason"]
        .as_str()
        .expect("reason")
        .contains("configuration I/O"));
    assert!(output.stdout.is_empty());
}

#[test]
fn reconnect_refuses_missing_or_dead_service_without_spawning() {
    let home = tempfile::tempdir().expect("isolated home");
    let directory = home.path().join(".oni/machine-client");
    std::fs::create_dir_all(&directory).expect("state directory");
    for state in [None, Some(r#"{"generation":1,"pid":99999999}"#)] {
        if let Some(state) = state {
            std::fs::write(directory.join("state.json"), state).expect("dead pid");
        }
        let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home.path())
            .arg("reconnect")
            .output()
            .expect("mclient reconnect");
        assert_eq!(output.status.code(), Some(2));
        let error: serde_json::Value =
            serde_json::from_slice(&output.stderr).expect("typed refusal");
        assert_eq!(error["reason"], "service_unavailable");
        assert!(output.stdout.is_empty());
    }
}

#[tokio::test]
async fn reconnect_signals_the_running_service_for_an_immediate_reprobe() {
    use tokio::io::AsyncBufReadExt;
    let home = tempfile::tempdir().expect("isolated home");
    let mut service = tokio::process::Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args(["run", "--allow-unpinned"])
        .stderr(Stdio::piped())
        .spawn()
        .expect("service starts");
    let stderr = service.stderr.take().expect("service stderr");
    let mut lines = tokio::io::BufReader::new(stderr).lines();
    let first = tokio::time::timeout(std::time::Duration::from_secs(5), lines.next_line())
        .await
        .expect("first configuration observation")
        .expect("stderr")
        .expect("line");
    let fact: serde_json::Value = serde_json::from_str(&first).expect("class fact");
    assert_eq!(fact["class"], "configuration");
    let reconnect = tokio::process::Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .arg("reconnect")
        .output()
        .await
        .expect("reconnect command");
    assert_eq!(reconnect.status.code(), Some(0));
    let second = tokio::time::timeout(std::time::Duration::from_secs(5), lines.next_line())
        .await
        .expect("immediate retry")
        .expect("stderr")
        .expect("line");
    let fact: serde_json::Value = serde_json::from_str(&second).expect("reprobe class");
    assert_eq!(fact["class"], "configuration");
    service.kill().await.expect("stop service");
}

#[test]
fn no_arguments_reports_usage_and_exits_two() {
    let output = mclient(&[]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(output.stderr).expect("utf-8 stderr"),
        "usage: mclient --version | join <host> | status | run | update|upgrade | reconnect\n"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn help_lists_user_commands_and_hides_agent_hook_plumbing() {
    let output = mclient(&["--help"]);
    assert_eq!(output.status.code(), Some(0));
    let help = String::from_utf8(output.stdout).expect("utf-8 help");
    let listed = |name: &str| {
        help.lines()
            .any(|line| line.split_whitespace().next() == Some(name))
    };
    for command in ["join", "status", "run", "update", "reconnect"] {
        assert!(listed(command), "{help}");
    }
    for hidden in ["hook", "probe", "retry"] {
        assert!(!listed(hidden), "{help}");
    }
    let update = mclient(&["update", "--help"]);
    let help = String::from_utf8(update.stdout).expect("utf-8 help");
    assert!(
        help.contains("--check") && help.contains("--host-contract"),
        "{help}"
    );
}

#[test]
fn status_json_reports_setup_work_for_an_uninstalled_service() {
    let home = tempfile::tempdir().expect("isolated home");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args(["status", "--json"])
        .output()
        .expect("status");
    assert!(output.status.success());
    let record: serde_json::Value = serde_json::from_slice(&output.stdout).expect("status JSON");
    assert_eq!(record["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(record["os"], std::env::consts::OS);
    assert_eq!(record["ok"], false);
    assert!(record["needs"]
        .as_array()
        .expect("needs")
        .iter()
        .any(|row| row["step"] == "service_install" && row["onScreen"] == false));
}

#[test]
fn join_unix_persists_private_identity_and_enrollment() {
    let directory = tempfile::tempdir().expect("home directory");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", directory.path())
        .args([
            "join",
            "localhost",
            "--unix",
            "/tmp/oni.sock",
            "--export",
            "notes=/tmp",
            "--memory-budget-mb",
            "64",
            "--no-service",
            "--no-open",
        ])
        .output()
        .expect("mclient runs");
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("stdout");
    let receipt: serde_json::Value =
        serde_json::from_str(stdout.lines().next().expect("enrollment JSON"))
            .expect("enrollment JSON");
    assert!(!receipt["machineId"]
        .as_str()
        .expect("machine id")
        .is_empty());
    assert_eq!(receipt["allowedExports"], serde_json::json!(["notes"]));
    assert_eq!(
        receipt["allowedCapabilities"]
            .as_array()
            .expect("capabilities")
            .len(),
        9
    );
    assert!(stdout.contains("service: none (skipped)"));
    assert!(stdout.contains(&format!(
        "config: {}",
        directory
            .path()
            .join(".oni/machine-client/client.json")
            .display()
    )));
    assert!(stdout.contains("offered capabilities: fs.read, fs.write, shell.exec"));
    #[cfg(target_os = "linux")]
    assert!(stdout.contains("screen recording: unsupported\n"));
    #[cfg(target_os = "macos")]
    assert!(stdout.contains("screen recording: the service requests it on first start"));
    let client = directory.path().join(".oni/machine-client");
    let pin: serde_json::Value =
        serde_json::from_slice(&std::fs::read(client.join("pin.json")).expect("persisted pin"))
            .expect("pin json");
    assert_eq!(pin["pinnedVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(pin["pinned"], false);
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&client)
            .expect("directory")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    for name in ["client-key.pem", "client-cert.pem", "client.json"] {
        assert_eq!(
            std::fs::metadata(client.join(name))
                .expect("identity")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(client.join("client.json")).expect("config"))
            .expect("json");
    assert_eq!(config["memoryBudgetMb"], 64);
    assert_eq!(
        config["declared"],
        serde_json::json!(oni_machine_client::handlers::SUPPORTED),
        "a join without --capability declares exactly what this client serves"
    );
    // Key custody: the private key stays in its 0600 file; neither the
    // receipt nor the prompts carry its bytes, only the public-key pin.
    let key = std::fs::read_to_string(client.join("client-key.pem")).expect("private key");
    let key_body = key
        .lines()
        .find(|line| !line.starts_with("-----"))
        .expect("key body");
    assert!(key.contains("PRIVATE KEY"));
    assert!(!stdout.contains(key_body) && !stdout.contains("PRIVATE KEY"));
    let stderr = String::from_utf8(output.stderr).expect("stderr");
    assert!(!stderr.contains(key_body) && !stderr.contains("PRIVATE KEY"));
    let public_key = receipt["publicKey"].as_str().expect("public key pin");
    assert_eq!(public_key.len(), 64);
    let status = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", directory.path())
        .args(["status", "--json"])
        .output()
        .expect("status");
    let record: serde_json::Value = serde_json::from_slice(&status.stdout).expect("status JSON");
    assert_eq!(record["identity"], public_key);
    assert_eq!(record["consentRequired"], serde_json::Value::Null);
}

/// Consent is the operator's choice at `join`: the declared set bounds the
/// enrollment receipt, and a capability this client cannot serve is refused.
#[test]
fn join_declares_only_the_selected_capabilities() {
    let home = tempfile::tempdir().expect("isolated home");
    let join = |capabilities: &[&str]| {
        let mut args = vec![
            "join",
            "localhost",
            "--unix",
            "/tmp/oni.sock",
            "--no-service",
            "--no-open",
        ];
        for capability in capabilities {
            args.extend(["--capability", capability]);
        }
        Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home.path())
            .args(args)
            .output()
            .expect("mclient runs")
    };
    let refused = join(&["fs.read", "mind.read"]);
    assert_eq!(refused.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("unsupported_capability: mind.read"));
    assert!(!home.path().join(".oni/machine-client/client.json").exists());

    let output = join(&["fs.read", "shell.exec", "fs.read"]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("stdout");
    let receipt: serde_json::Value =
        serde_json::from_str(stdout.lines().next().expect("enrollment JSON"))
            .expect("enrollment JSON");
    assert_eq!(
        receipt["allowedCapabilities"],
        serde_json::json!(["fs.read", "shell.exec"])
    );
    assert!(stdout.contains("offered capabilities: fs.read, shell.exec\n"));
    let config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(home.path().join(".oni/machine-client/client.json")).expect("config"),
    )
    .expect("json");
    assert_eq!(
        config["declared"],
        serde_json::json!(["fs.read", "shell.exec"])
    );
}

/// `mclient grant` is the only way the offer grows: it records consent in
/// the saved config, reports the declared set, and tells a stopped service
/// nothing needs restarting. Unknown names are refused.
#[test]
fn grant_records_consent_in_the_saved_config() {
    let home = tempfile::tempdir().expect("isolated home");
    let join = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args([
            "join",
            "localhost",
            "--unix",
            "/tmp/oni.sock",
            "--capability",
            "fs.read",
            "--no-service",
            "--no-open",
        ])
        .output()
        .expect("mclient runs");
    assert_eq!(join.status.code(), Some(0));
    let grant = |capability: &str| {
        Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home.path())
            .args(["grant", capability])
            .output()
            .expect("mclient runs")
    };
    let refused = grant("mind.read");
    assert_eq!(refused.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("unsupported_capability: mind.read"));

    let granted = grant("shell.exec");
    assert_eq!(
        granted.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&granted.stderr)
    );
    let stdout = String::from_utf8(granted.stdout).expect("stdout");
    assert!(stdout.contains("declared capabilities: fs.read, shell.exec\n"));
    assert!(stdout.contains("service: not running\n"));
    let config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(home.path().join(".oni/machine-client/client.json")).expect("config"),
    )
    .expect("json");
    assert_eq!(
        config["declared"],
        serde_json::json!(["fs.read", "shell.exec"])
    );
    // Granting again keeps the set as it is.
    let again = grant("shell.exec");
    assert!(String::from_utf8_lossy(&again.stdout)
        .contains("declared capabilities: fs.read, shell.exec\n"));
}

const UNPINNED_CONFIG: &str = r#"{"machineId":"m","name":"m","host":"127.0.0.1:9","exports":[],"tags":[],"memoryBudgetMb":96,"unix":null,"declared":["fs.read"]}"#;

/// Consent is recorded before the service is signalled, so a service state
/// that cannot be read is reported after the declared set rather than
/// instead of it; only a missing service is tolerated as "not running".
#[test]
fn grant_reports_an_unreadable_service_state_after_recording_consent() {
    let home = tempfile::tempdir().expect("isolated home");
    let directory = home.path().join(".oni/machine-client");
    std::fs::create_dir_all(&directory).expect("client directory");
    std::fs::write(directory.join("client.json"), UNPINNED_CONFIG).expect("config");
    let state = directory.join("state.json");
    let grant = |capability: &str| {
        Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home.path())
            .args(["grant", capability])
            .output()
            .expect("mclient runs")
    };

    std::fs::write(&state, "{").expect("corrupt state");
    let corrupt = grant("shell.exec");
    assert_eq!(corrupt.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(corrupt.stdout).expect("stdout"),
        "declared capabilities: fs.read, shell.exec\n"
    );
    let error: serde_json::Value = serde_json::from_slice(&corrupt.stderr).expect("JSON refusal");
    assert!(
        error["reason"]
            .as_str()
            .expect("reason")
            .starts_with("invalid saved generation:"),
        "{error}"
    );

    std::fs::remove_file(&state).expect("remove state");
    std::fs::create_dir(&state).expect("blocking state");
    let unreadable = grant("pty.session");
    assert_eq!(unreadable.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(unreadable.stdout).expect("stdout"),
        "declared capabilities: fs.read, shell.exec, pty.session\n"
    );
    let error: serde_json::Value =
        serde_json::from_slice(&unreadable.stderr).expect("JSON refusal");
    assert!(
        error["reason"]
            .as_str()
            .expect("reason")
            .starts_with("I/O:"),
        "{error}"
    );

    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("client.json")).expect("config"))
            .expect("json");
    assert_eq!(
        config["declared"],
        serde_json::json!(["fs.read", "shell.exec", "pty.session"])
    );
}

/// `mclient grant` reaches the running service through the reconnect signal
/// and says so: the service re-attaches at once instead of waiting out its
/// reprobe timer, so the host sees the wider offer now.
#[tokio::test]
async fn grant_signals_the_running_service_to_reconnect() {
    use tokio::io::AsyncBufReadExt;
    let home = tempfile::tempdir().expect("isolated home");
    let directory = home.path().join(".oni/machine-client");
    std::fs::create_dir_all(&directory).expect("client directory");
    std::fs::write(directory.join("client.json"), UNPINNED_CONFIG).expect("config");
    let mut service = tokio::process::Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args(["run", "--allow-unpinned"])
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("service starts");
    let stderr = service.stderr.take().expect("service stderr");
    let mut lines = tokio::io::BufReader::new(stderr).lines();
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), lines.next_line())
        .await
        .expect("first configuration observation")
        .expect("stderr")
        .expect("line");
    let fact: serde_json::Value = serde_json::from_str(&first).expect("class fact");
    assert_eq!(fact["class"], "configuration");

    let grant = tokio::process::Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args(["grant", "shell.exec"])
        .output()
        .await
        .expect("grant command");
    assert_eq!(
        grant.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&grant.stderr)
    );
    assert_eq!(
        String::from_utf8(grant.stdout).expect("stdout"),
        "declared capabilities: fs.read, shell.exec\nservice: reconnecting\n"
    );

    let second = tokio::time::timeout(std::time::Duration::from_secs(10), lines.next_line())
        .await
        .expect("immediate reprobe")
        .expect("stderr")
        .expect("line");
    let fact: serde_json::Value = serde_json::from_str(&second).expect("reprobe class");
    assert_eq!(fact["class"], "configuration");
    service.kill().await.expect("stop service");
}

/// `status` surfaces the host's outstanding wish so the operator can answer
/// it, naming the exact `grant` command per capability.
#[test]
fn status_reports_the_consent_the_host_still_wants() {
    let home = tempfile::tempdir().expect("isolated home");
    let client = home.path().join(".oni/machine-client");
    std::fs::create_dir_all(&client).expect("client directory");
    std::fs::write(
        client.join("consent.json"),
        br#"{"status":"consent_required","capabilities":["shell.exec"],"exports":["notes"]}"#,
    )
    .expect("consent record");
    let json = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args(["status", "--json"])
        .output()
        .expect("status");
    let record: serde_json::Value = serde_json::from_slice(&json.stdout).expect("status JSON");
    assert_eq!(
        record["consentRequired"],
        serde_json::json!({"capabilities":["shell.exec"],"exports":["notes"]})
    );
    assert_eq!(record["identity"], serde_json::Value::Null);
    let text = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args(["status"])
        .output()
        .expect("status");
    let stdout = String::from_utf8(text.stdout).expect("stdout");
    assert!(stdout.contains("consent required: capability shell.exec — mclient grant shell.exec\n"));
    assert!(
        stdout.contains("consent required: export notes — re-join with --export notes=<path>\n")
    );
}

/// Consent survives a re-join: without `--capability` the saved declared set
/// is kept (including what `grant` added), and an explicit selection
/// replaces it.
#[test]
fn rejoin_without_capability_keeps_the_declared_set() {
    let home = tempfile::tempdir().expect("isolated home");
    let join = |capabilities: &[&str]| {
        let mut args = vec![
            "join",
            "localhost",
            "--unix",
            "/tmp/oni.sock",
            "--no-service",
            "--no-open",
        ];
        for capability in capabilities {
            args.extend(["--capability", capability]);
        }
        let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home.path())
            .args(args)
            .output()
            .expect("mclient runs");
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).expect("stdout");
        let receipt: serde_json::Value =
            serde_json::from_str(stdout.lines().next().expect("receipt")).expect("JSON receipt");
        receipt["allowedCapabilities"].clone()
    };
    let declared = || -> serde_json::Value {
        let config: serde_json::Value = serde_json::from_slice(
            &std::fs::read(home.path().join(".oni/machine-client/client.json")).expect("config"),
        )
        .expect("json");
        config["declared"].clone()
    };
    assert_eq!(join(&["fs.read"]), serde_json::json!(["fs.read"]));
    assert_eq!(join(&[]), serde_json::json!(["fs.read"]));
    assert_eq!(declared(), serde_json::json!(["fs.read"]));

    let granted = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args(["grant", "shell.exec"])
        .output()
        .expect("mclient runs");
    assert_eq!(granted.status.code(), Some(0));
    assert_eq!(join(&[]), serde_json::json!(["fs.read", "shell.exec"]));
    assert_eq!(declared(), serde_json::json!(["fs.read", "shell.exec"]));

    assert_eq!(join(&["pty.session"]), serde_json::json!(["pty.session"]));
    assert_eq!(declared(), serde_json::json!(["pty.session"]));
}

/// A consent record or saved identity that no longer parses is a typed
/// refusal from `status`, never a report that reads as healthy.
#[test]
fn status_refuses_a_corrupt_consent_record_or_identity() {
    let home = tempfile::tempdir().expect("isolated home");
    let client = home.path().join(".oni/machine-client");
    std::fs::create_dir_all(&client).expect("client directory");
    let status = || {
        Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home.path())
            .args(["status", "--json"])
            .output()
            .expect("status")
    };
    std::fs::write(client.join("consent.json"), b"{not json").expect("corrupt consent");
    let refused = status();
    assert_eq!(refused.status.code(), Some(2));
    assert!(refused.stdout.is_empty());
    let refusal: serde_json::Value = serde_json::from_slice(&refused.stderr).expect("JSON refusal");
    assert_eq!(
        refusal["reason"],
        "invalid consent record (consent.json); delete it and reconnect"
    );

    std::fs::remove_file(client.join("consent.json")).expect("remove consent");
    std::fs::write(client.join("client-cert.pem"), b"not a certificate").expect("corrupt cert");
    let refused = status();
    assert_eq!(refused.status.code(), Some(2));
    assert!(refused.stdout.is_empty());
    let refusal: serde_json::Value = serde_json::from_slice(&refused.stderr).expect("JSON refusal");
    assert_eq!(
        refusal["reason"]
            .as_str()
            .map(|reason| reason.starts_with("invalid saved client identity")),
        Some(true)
    );

    std::fs::remove_file(client.join("client-cert.pem")).expect("remove certificate");
    let healthy = status();
    assert_eq!(healthy.status.code(), Some(0));
    let record: serde_json::Value = serde_json::from_slice(&healthy.stdout).expect("status JSON");
    assert_eq!(record["identity"], serde_json::Value::Null);
    assert_eq!(record["consentRequired"], serde_json::Value::Null);
}

#[test]
fn rejoin_preserves_enrolled_identity_and_receipt_until_rekey() {
    let home = tempfile::tempdir().expect("isolated home");
    let join = |rekey: bool| {
        let mut args = vec![
            "join",
            "localhost",
            "--name",
            "macbook",
            "--unix",
            "/tmp/oni.sock",
            "--no-service",
            "--no-open",
        ];
        if rekey {
            args.push("--rekey");
        }
        let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home.path())
            .args(args)
            .output()
            .expect("mclient runs");
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).expect("stdout");
        let receipt: serde_json::Value =
            serde_json::from_str(stdout.lines().next().expect("receipt")).expect("JSON receipt");
        receipt["publicKey"]
            .as_str()
            .expect("public key")
            .to_owned()
    };
    let first = join(false);
    let directory = home.path().join(".oni/machine-client");
    let key = std::fs::read(directory.join("client-key.pem")).expect("first key");
    let cert = std::fs::read(directory.join("client-cert.pem")).expect("first certificate");
    let second = join(false);
    assert_eq!(second, first);
    assert_eq!(
        std::fs::read(directory.join("client-key.pem")).expect("rejoined key"),
        key
    );
    assert_eq!(
        std::fs::read(directory.join("client-cert.pem")).expect("rejoined certificate"),
        cert
    );
    // Rotation is a re-invitation: the receipt carries a new pin the host does
    // not know yet, and the rotated pair has replaced the old one on disk.
    let rotated = join(true);
    assert_ne!(rotated, first);
    assert_eq!(rotated.len(), 64);
    let rotated_key = std::fs::read(directory.join("client-key.pem")).expect("rotated key");
    assert_ne!(rotated_key, key);
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(directory.join("client-key.pem"))
            .expect("rotated key")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let status = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args(["status", "--json"])
        .output()
        .expect("status");
    let record: serde_json::Value = serde_json::from_slice(&status.stdout).expect("status JSON");
    assert_eq!(record["identity"], rotated);
}

#[test]
fn json_join_reports_setup_without_human_join_output() {
    let home = tempfile::tempdir().expect("isolated home");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args([
            "join",
            "localhost",
            "--unix",
            "/tmp/oni.sock",
            "--json",
            "--no-service",
            "--no-open",
        ])
        .output()
        .expect("mclient runs");
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let status: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("single JSON status");
    assert!(status["needs"].as_array().is_some());
    assert!(status["verdict"].as_str().is_some());
    assert!(home.path().join(".oni/machine-client/client.json").exists());
}

#[test]
fn join_presents_the_environment_token_without_persisting_it() {
    let home = tempfile::tempdir().expect("isolated home");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .env("ONI_MCLIENT_JOIN_TOKEN", "secret-join-token")
        .args([
            "join",
            "localhost",
            "--unix",
            "/tmp/oni.sock",
            "--no-service",
            "--no-open",
        ])
        .output()
        .expect("mclient runs");
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("join text");
    let receipt: serde_json::Value =
        serde_json::from_str(stdout.lines().next().expect("receipt line")).expect("receipt JSON");
    assert_eq!(receipt["tokenPresented"], serde_json::json!(true));
    assert!(!stdout.contains("secret-join-token"), "{stdout}");
    let client = std::fs::read_to_string(home.path().join(".oni/machine-client/client.json"))
        .expect("client.json");
    assert!(
        !client.contains("joinToken") && !client.contains("secret-join-token"),
        "{client}"
    );
    let without = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .env_remove("ONI_MCLIENT_JOIN_TOKEN")
        .args([
            "join",
            "localhost",
            "--unix",
            "/tmp/oni.sock",
            "--no-service",
            "--no-open",
        ])
        .output()
        .expect("mclient runs");
    let stdout = String::from_utf8(without.stdout).expect("join text");
    let receipt: serde_json::Value =
        serde_json::from_str(stdout.lines().next().expect("receipt line")).expect("receipt JSON");
    assert_eq!(receipt["tokenPresented"], serde_json::json!(false));
}

#[test]
fn human_status_prints_missing_service_setup_action() {
    let home = tempfile::tempdir().expect("isolated home");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args(["status"])
        .output()
        .expect("mclient status");
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).expect("status text");
    assert!(stdout.contains("screen:"));
    assert!(stdout.contains("setup: \"service_install\""), "{stdout}");
}

#[cfg(target_os = "linux")]
#[test]
fn wayland_only_status_prints_each_required_setup_action() {
    let home = tempfile::tempdir().expect("isolated home");
    let _socket = std::os::unix::net::UnixListener::bind(home.path().join("wayland-0"))
        .expect("Wayland socket");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .env("XDG_RUNTIME_DIR", home.path())
        .env("WAYLAND_DISPLAY", "wayland-0")
        .env_remove("DISPLAY")
        .args(["status"])
        .output()
        .expect("mclient status");
    assert_eq!(output.status.code(), Some(0));
    let stdout = String::from_utf8(output.stdout).expect("status text");
    assert!(stdout.contains("setup: \"x11_session\""), "{stdout}");
    assert!(stdout.contains("setup: \"service_install\""), "{stdout}");
}

#[test]
fn rejoin_refuses_incomplete_identity_without_rotating_key() {
    let home = tempfile::tempdir().expect("isolated home");
    let first = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args([
            "join",
            "localhost",
            "--name",
            "macbook",
            "--unix",
            "/tmp/oni.sock",
            "--no-service",
            "--no-open",
        ])
        .output()
        .expect("first join");
    assert_eq!(first.status.code(), Some(0));
    let directory = home.path().join(".oni/machine-client");
    let config = std::fs::read(directory.join("client.json")).expect("saved config");
    let key = std::fs::read(directory.join("client-key.pem")).expect("saved key");
    std::fs::remove_file(directory.join("client-cert.pem")).expect("interrupted identity");
    let service = home.path().join("services");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args([
            "join",
            "otherhost.example",
            "--name",
            "renamed",
            "--unix",
            "/tmp/oni.sock",
            "--service-dir",
            service.to_str().expect("service path"),
            "--no-open",
        ])
        .output()
        .expect("mclient runs");
    assert_eq!(output.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("JSON refusal");
    let reason = error["reason"].as_str().expect("reason");
    assert!(reason.contains("client-cert.pem"));
    assert!(reason.contains("client-key.pem"));
    assert!(reason.contains("re-enroll"));
    assert!(output.stdout.is_empty());
    assert_eq!(
        std::fs::read(directory.join("client-key.pem")).expect("saved key"),
        key
    );
    assert_eq!(
        std::fs::read(directory.join("client.json")).expect("saved config"),
        config
    );
    assert!(!directory.join("client-cert.pem").exists());
    assert!(!service.exists());
}

#[test]
fn rejoin_refuses_mismatched_certificate_and_key_without_writes() {
    let first = tempfile::tempdir().expect("first home");
    let second = tempfile::tempdir().expect("second home");
    for home in [first.path(), second.path()] {
        let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home)
            .args([
                "join",
                "localhost",
                "--unix",
                "/tmp/oni.sock",
                "--no-service",
                "--no-open",
            ])
            .output()
            .expect("join");
        assert_eq!(output.status.code(), Some(0));
    }
    let directory = first.path().join(".oni/machine-client");
    let cert = std::fs::read(directory.join("client-cert.pem")).expect("first certificate");
    let key = std::fs::read(second.path().join(".oni/machine-client/client-key.pem"))
        .expect("second key");
    std::fs::write(directory.join("client-key.pem"), &key).expect("mismatched key");
    let config = std::fs::read(directory.join("client.json")).expect("first config");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", first.path())
        .args([
            "join",
            "otherhost.example",
            "--name",
            "renamed",
            "--unix",
            "/tmp/oni.sock",
            "--no-service",
        ])
        .output()
        .expect("rejoin");
    assert_eq!(output.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("JSON refusal");
    assert!(error["reason"]
        .as_str()
        .expect("reason")
        .contains("invalid saved client identity"));
    assert!(output.stdout.is_empty());
    assert_eq!(
        std::fs::read(directory.join("client.json")).expect("config"),
        config
    );
    assert_eq!(
        std::fs::read(directory.join("client-cert.pem")).expect("cert"),
        cert
    );
    assert_eq!(
        std::fs::read(directory.join("client-key.pem")).expect("key"),
        key
    );
}

#[test]
fn first_join_refuses_key_write_failure_without_a_receipt() {
    let home = tempfile::tempdir().expect("isolated home");
    let directory = home.path().join(".oni/machine-client");
    std::fs::create_dir_all(&directory).expect("client directory");
    std::os::unix::fs::symlink(
        home.path().join("missing/key"),
        directory.join("client-key.pem"),
    )
    .expect("dangling key path");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .args([
            "join",
            "localhost",
            "--unix",
            "/tmp/oni.sock",
            "--no-service",
            "--no-open",
        ])
        .output()
        .expect("join");
    assert_eq!(output.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("JSON refusal");
    assert!(error["reason"]
        .as_str()
        .expect("reason")
        .contains("configuration I/O"));
    assert!(output.stdout.is_empty());
    assert!(!directory.join("client.json").exists());
    assert!(directory.join("client-cert.pem").exists());
}

#[test]
fn join_installs_restarts_and_reports_manager_failure() {
    let directory = tempfile::tempdir().expect("isolated home");
    let service = directory.path().join("services");
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).expect("fake binaries");
    #[cfg(target_os = "macos")]
    let manager = "launchctl";
    #[cfg(target_os = "linux")]
    let manager = "systemctl";
    let script = bin.join(manager);
    let log = directory.path().join("manager.log");
    let state = directory.path().join("loaded");
    std::fs::write(&script, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$MCLIENT_SERVICE_LOG\"\nif [ \"$1\" = print ]; then\n  if [ \"$(cat \"$MCLIENT_SERVICE_STATE\" 2>/dev/null)\" = pending ]; then\n    rm \"$MCLIENT_SERVICE_STATE\"\n    exit 0\n  fi\n  test -f \"$MCLIENT_SERVICE_STATE\"\n  exit $?\nfi\nif [ \"${MCLIENT_SERVICE_FAIL:-0}\" = 1 ]; then exit 1; fi\nif [ \"$1\" = bootstrap ]; then touch \"$MCLIENT_SERVICE_STATE\"; fi\nif [ \"$1\" = bootout ]; then printf pending > \"$MCLIENT_SERVICE_STATE\"; fi\n").expect("fake manager");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).expect("executable");
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").expect("PATH"));
    let run = |fail: bool| {
        Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", directory.path())
            .env("PATH", &path)
            .env("MCLIENT_SERVICE_LOG", &log)
            .env("MCLIENT_SERVICE_STATE", &state)
            .env("MCLIENT_SERVICE_FAIL", if fail { "1" } else { "0" })
            .args([
                "join",
                "localhost",
                "--unix",
                "/tmp/oni.sock",
                "--service-dir",
                service.to_str().expect("path"),
                "--no-open",
            ])
            .output()
            .expect("mclient runs")
    };
    let first = run(false);
    assert_eq!(
        first.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let stdout = String::from_utf8(first.stdout).expect("status");
    assert!(
        serde_json::from_str::<serde_json::Value>(stdout.lines().next().expect("receipt")).is_ok()
    );
    let lines = stdout.lines().skip(1).collect::<Vec<_>>();
    assert!(lines.len() >= 6);
    assert!(lines[5].starts_with("screen: "));
    assert_eq!(
        lines[0],
        format!(
            "config: {}",
            directory
                .path()
                .join(".oni/machine-client/client.json")
                .display()
        )
    );
    #[cfg(target_os = "macos")]
    let service_name = "ai.oni.machine";
    #[cfg(target_os = "linux")]
    let service_name = "oni-machine-client.service";
    assert_eq!(lines[1], format!("service: {service_name} (started)"));
    assert_eq!(
        lines[2],
        format!(
            "offered capabilities: {}",
            oni_machine_client::handlers::SUPPORTED.join(", ")
        )
    );
    let pin: serde_json::Value = serde_json::from_slice(
        &std::fs::read(directory.path().join(".oni/machine-client/pin.json")).expect("pin"),
    )
    .expect("pin json");
    assert_eq!(pin["pinnedVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(pin["pinned"], false);
    #[cfg(target_os = "linux")]
    assert_eq!(lines[3], "screen recording: unsupported");
    #[cfg(target_os = "macos")]
    assert!(stdout.contains("screen recording: the service requests it on first start"));
    #[cfg(target_os = "macos")]
    let unit = service.join("ai.oni.machine.plist");
    #[cfg(target_os = "linux")]
    let unit = service.join("oni-machine-client.service");
    let contents = std::fs::read_to_string(&unit).expect("service file");
    let installed = directory.path().join(if cfg!(target_os = "macos") {
        ".oni/bin/mclient"
    } else {
        ".oni/bin/current"
    });
    assert!(contents.contains(&installed.display().to_string()));
    #[cfg(target_os = "macos")]
    assert_eq!(
        std::fs::canonicalize(&installed).expect("real service path"),
        std::fs::canonicalize(installed.parent().expect("bin directory"))
            .expect("real bin directory")
            .join("mclient")
    );
    assert!(contents.contains(
        &directory
            .path()
            .join(".oni/machine-client/client.json")
            .display()
            .to_string()
    ));
    let modified = std::fs::metadata(&unit)
        .expect("service metadata")
        .modified()
        .expect("mtime");
    let second = run(false);
    assert_eq!(
        second.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(&unit).expect("unchanged unit"),
        contents
    );
    assert_eq!(
        std::fs::metadata(&unit)
            .expect("service metadata")
            .modified()
            .expect("mtime"),
        modified
    );
    let calls = std::fs::read_to_string(&log).expect("manager calls");
    #[cfg(target_os = "linux")]
    {
        let commands = calls.lines().collect::<Vec<_>>();
        let expected = if nix::unistd::getuid().as_raw() == 0 {
            vec![
                "daemon-reload",
                "enable --now oni-machine-client.service",
                "restart oni-machine-client.service",
            ]
        } else {
            vec![
                "--user daemon-reload",
                "--user enable --now oni-machine-client.service",
                "--user restart oni-machine-client.service",
            ]
        };
        assert_eq!(commands, expected);
    }
    #[cfg(target_os = "macos")]
    {
        assert_eq!(
            calls
                .lines()
                .filter(|line| line.starts_with("bootstrap "))
                .count(),
            1
        );
        assert_eq!(
            calls
                .lines()
                .filter(|line| line.starts_with("kickstart -k "))
                .count(),
            1
        );
        std::fs::write(&unit, "old service content").expect("old unit");
        let changed = run(false);
        assert_eq!(
            changed.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&changed.stderr)
        );
        let calls = std::fs::read_to_string(&log).expect("manager calls");
        assert_eq!(
            calls
                .lines()
                .filter(|line| line.starts_with("bootout "))
                .count(),
            1
        );
        assert_eq!(
            calls
                .lines()
                .filter(|line| line.starts_with("bootstrap "))
                .count(),
            2
        );
        let commands = calls.lines().collect::<Vec<_>>();
        let bootout = commands
            .iter()
            .position(|line| line.starts_with("bootout "))
            .expect("bootout");
        assert!(commands[bootout + 1].starts_with("print "));
        assert!(commands[bootout + 2].starts_with("print "));
        assert!(commands[bootout + 3].starts_with("bootstrap "));
    }
    let failed = run(true);
    assert_eq!(failed.status.code(), Some(2));
    assert!(serde_json::from_str::<serde_json::Value>(
        String::from_utf8_lossy(&failed.stdout)
            .lines()
            .next()
            .expect("receipt")
    )
    .is_ok());
    let error = String::from_utf8_lossy(&failed.stderr);
    assert!(error.contains("service install failed"), "{error}");
    assert!(error.contains("recovery:"), "{error}");
    assert!(error.contains(manager), "{error}");
    #[cfg(target_os = "linux")]
    assert!(error.contains("restart"), "{error}");
    #[cfg(target_os = "macos")]
    assert!(error.contains("kickstart"), "{error}");
}

#[cfg(target_os = "linux")]
#[test]
fn join_uses_xdg_user_unit_before_enabling_it() {
    if nix::unistd::getuid().as_raw() == 0 {
        return;
    }
    let directory = tempfile::tempdir().expect("isolated home");
    let home = directory.path().join("home");
    let xdg = directory.path().join("xdg");
    let bin = directory.path().join("bin");
    std::fs::create_dir(&home).expect("home");
    std::fs::create_dir(&bin).expect("fake binaries");
    let script = bin.join("systemctl");
    std::fs::write(
        &script,
        "#!/bin/sh\n\
         test -f \"$XDG_CONFIG_HOME/systemd/user/oni-machine-client.service\" || exit 1\n\
         printf '%s\\n' \"$*\" >> \"$MCLIENT_SERVICE_LOG\"\n",
    )
    .expect("fake manager");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).expect("executable");
    let log = directory.path().join("manager.log");
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").expect("PATH"));
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", &xdg)
        .env("PATH", path)
        .env("MCLIENT_SERVICE_LOG", &log)
        .args(["join", "localhost", "--unix", "/tmp/oni.sock"])
        .output()
        .expect("mclient runs");
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let unit = xdg.join("systemd/user/oni-machine-client.service");
    assert!(unit.is_file());
    assert!(!home
        .join(".config/systemd/user/oni-machine-client.service")
        .exists());
    assert_eq!(
        std::fs::read_to_string(log).expect("manager calls"),
        "--user daemon-reload\n--user enable --now oni-machine-client.service\n"
    );
}

#[test]
fn run_without_config_reads_default_home_path() {
    let directory = tempfile::tempdir().expect("isolated home");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", directory.path())
        .args(["run", "--allow-unpinned", "--once"])
        .output()
        .expect("mclient runs");
    assert_eq!(output.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("JSON refusal");
    assert!(error["reason"]
        .as_str()
        .expect("reason")
        .contains("configuration I/O"));
}

#[test]
fn one_shot_without_recorded_host_pin_refuses_configuration() {
    let directory = tempfile::tempdir().expect("client directory");
    let path = directory.path().join("client.json");
    std::fs::write(
        &path,
        r#"{"machineId":"m","name":"m","host":"127.0.0.1:9","exports":[],"tags":[],"memoryBudgetMb":96,"unix":null}"#,
    )
    .expect("config");
    let output = mclient(&[
        "run",
        "--allow-unpinned",
        "--once",
        "--config",
        path.to_str().expect("path"),
    ]);
    assert_eq!(output.status.code(), Some(3));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("JSON refusal");
    assert_eq!(error["reason"], "configuration");
}

const CLAUDE_INPUT: &str =
    r#"{"session_id":"s","tool_name":"Bash","tool_input":{},"tool_use_id":"t"}"#;

fn hook_permission(home: &std::path::Path) -> std::process::Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home)
        .args(["hook", "permission", "--cli", "claude-code"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("mclient runs");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(CLAUDE_INPUT.as_bytes())
        .expect("hook input");
    child
}

#[test]
fn hook_permission_without_a_running_client_blocks() {
    let home = tempfile::tempdir().expect("isolated home");
    let output = hook_permission(home.path())
        .wait_with_output()
        .expect("hook exits");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let reason = String::from_utf8(output.stderr).expect("utf-8 stderr");
    assert!(reason.starts_with("oni: client not reachable"), "{reason}");
}
