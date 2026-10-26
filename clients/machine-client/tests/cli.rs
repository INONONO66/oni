use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn mclient(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_mclient"))
        .args(args)
        .output()
        .expect("mclient runs")
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
    let output = mclient(&["run", "--config", path.to_str().expect("path")]);
    assert_eq!(output.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("JSON refusal");
    assert!(error["reason"]
        .as_str()
        .expect("reason")
        .contains("configuration I/O"));
    assert!(output.stdout.is_empty());
}

#[test]
fn no_arguments_reports_usage_and_exits_two() {
    let output = mclient(&[]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(output.stderr).expect("utf-8 stderr"),
        "usage: mclient --version | join <host> | run\n"
    );
    assert!(output.stdout.is_empty());
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
        ])
        .output()
        .expect("mclient runs");
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("enrollment JSON");
    assert!(!receipt["machineId"]
        .as_str()
        .expect("machine id")
        .is_empty());
    assert_eq!(receipt["allowedExports"], serde_json::json!(["notes"]));
    let client = directory.path().join(".oni/machine-client");
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
fn run_without_config_reads_default_home_path() {
    let directory = tempfile::tempdir().expect("isolated home");
    let output = Command::new(env!("CARGO_BIN_EXE_mclient"))
        .env("HOME", directory.path())
        .arg("run")
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
fn run_without_recorded_host_pin_exits_two() {
    let directory = tempfile::tempdir().expect("client directory");
    let path = directory.path().join("client.json");
    std::fs::write(
        &path,
        r#"{"machineId":"m","name":"m","host":"127.0.0.1:9","exports":[],"tags":[],"memoryBudgetMb":96,"unix":null}"#,
    )
    .expect("config");
    let output = mclient(&["run", "--config", path.to_str().expect("path")]);
    assert_eq!(output.status.code(), Some(2));
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).expect("JSON refusal");
    assert!(error["reason"].as_str().expect("reason").starts_with("I/O"));
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
