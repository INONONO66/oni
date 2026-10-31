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
    std::fs::write(&command, "#!/bin/sh\nif [ -f \"$MCLIENT_FAIL_ONCE\" ]; then\n  rm \"$MCLIENT_FAIL_ONCE\"\n  exit 1\nfi\n\"$HOME/.oni/bin/current\" --version --json >> \"$MCLIENT_SERVICE_LOG\"\n").expect("manager");
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
    let (output, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
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
fn probe_checks_release_contract_without_connecting() {
    let home = tempfile::tempdir().expect("home");
    let release = release_fixture(home.path());
    let path = release.to_str().expect("release path");
    let accepted = mclient(&["probe", "--release", path, "--host-contract", "4"]);
    assert_eq!(accepted.status.code(), Some(0));
    let response: serde_json::Value = serde_json::from_slice(&accepted.stdout).expect("probe");
    assert_eq!(response["status"], "compatible");
    let refused = mclient(&["probe", "--release", path, "--host-contract", "2"]);
    assert_eq!(refused.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&refused.stderr).expect("refusal");
    assert_eq!(error["class"], "probe_failed");
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

#[test]
fn join_requires_explicit_pin_or_tofu_for_network_host() {
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
fn retry_refuses_missing_or_dead_service_without_spawning() {
    let home = tempfile::tempdir().expect("isolated home");
    let directory = home.path().join(".oni/machine-client");
    std::fs::create_dir_all(&directory).expect("state directory");
    for state in [None, Some(r#"{"generation":1,"pid":99999999}"#)] {
        if let Some(state) = state {
            std::fs::write(directory.join("state.json"), state).expect("dead pid");
        }
        let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
            .env("HOME", home.path())
            .arg("retry")
            .output()
            .expect("mclient retry");
        assert_eq!(output.status.code(), Some(2));
        let error: serde_json::Value =
            serde_json::from_slice(&output.stderr).expect("typed refusal");
        assert_eq!(error["reason"], "service_unavailable");
        assert!(output.stdout.is_empty());
    }
}

#[tokio::test]
async fn retry_signals_the_running_service_for_an_immediate_reprobe() {
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
    let retry = tokio::process::Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", home.path())
        .arg("retry")
        .output()
        .await
        .expect("retry command");
    assert_eq!(retry.status.code(), Some(0));
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
        "usage: mclient --version | join <host> | status | run | update | probe\n"
    );
    assert!(output.stdout.is_empty());
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
}

#[test]
fn rejoin_preserves_enrolled_identity_and_receipt() {
    let home = tempfile::tempdir().expect("isolated home");
    let join = || {
        let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
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
    let first = join();
    let directory = home.path().join(".oni/machine-client");
    let key = std::fs::read(directory.join("client-key.pem")).expect("first key");
    let cert = std::fs::read(directory.join("client-cert.pem")).expect("first certificate");
    let second = join();
    assert_eq!(second, first);
    assert_eq!(
        std::fs::read(directory.join("client-key.pem")).expect("rejoined key"),
        key
    );
    assert_eq!(
        std::fs::read(directory.join("client-cert.pem")).expect("rejoined certificate"),
        cert
    );
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
    assert!(contents.contains(
        &directory
            .path()
            .join(".oni/bin/current")
            .display()
            .to_string()
    ));
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
