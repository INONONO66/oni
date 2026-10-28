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
    assert!(stdout.ends_with("screen recording: unsupported\n"));
    #[cfg(target_os = "macos")]
    assert!(stdout.contains("screen recording: the service requests it on first start"));
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
fn join_installs_restarts_and_reports_manager_failure() {
    let directory = tempfile::tempdir().expect("isolated home");
    let service = directory.path().join("services");
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).expect("fake binaries");
    let manager = if cfg!(target_os = "macos") {
        "launchctl"
    } else {
        "systemctl"
    };
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
    assert_eq!(lines.len(), 4);
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
    assert_eq!(
        lines[1],
        format!(
            "service: {} (started)",
            if cfg!(target_os = "macos") {
                "ai.oni.machine"
            } else {
                "oni-machine-client.service"
            }
        )
    );
    assert_eq!(
        lines[2],
        format!(
            "offered capabilities: {}",
            oni_machine_client::handlers::SUPPORTED.join(", ")
        )
    );
    #[cfg(target_os = "linux")]
    assert!(stdout.ends_with("screen recording: unsupported\n"));
    #[cfg(target_os = "macos")]
    assert!(stdout.contains("screen recording: the service requests it on first start"));
    #[cfg(target_os = "macos")]
    let unit = service.join("ai.oni.machine.plist");
    #[cfg(target_os = "linux")]
    let unit = service.join("oni-machine-client.service");
    let contents = std::fs::read_to_string(&unit).expect("service file");
    assert!(contents.contains(env!("CARGO_BIN_EXE_mclient")));
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
    assert!(error.contains("rerun with --no-service"), "{error}");
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
