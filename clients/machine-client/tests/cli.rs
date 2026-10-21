use std::process::{Command, Output};

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
fn join_is_not_implemented() {
    let output = mclient(&["join", "x"]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(output.stderr).expect("utf-8 stderr"),
        "not implemented in this phase\n"
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn run_is_not_implemented() {
    let output = mclient(&["run"]);
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(output.stderr).expect("utf-8 stderr"),
        "not implemented in this phase\n"
    );
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
