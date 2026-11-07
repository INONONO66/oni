#[path = "support/script.rs"]
mod script;

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

use oni_machine_client::{
    config::{JoinOptions, DEFAULT_MEMORY_BUDGET_MB},
    tailnet::{self, Platform, Reason, Receipted, Setup, State, Step},
};

const RUNNING: &str = r#"{"BackendState":"Running","Peer":{}}"#;

/// The `tailscale` of a node that is logged out until `up` runs: `status`
/// answers `NeedsLogin` until `up` leaves its marker, and `up` records the
/// arguments it was given.
fn logged_out(home: &Path) -> String {
    let dir = home.display();
    format!(
        "#!/bin/sh\ncase \"$1\" in\n  status) if [ -f \"{dir}/up\" ]; then printf '%s' '{RUNNING}'; else printf '%s' '{{\"BackendState\":\"NeedsLogin\"}}'; fi ;;\n  up) printf '%s\\n' \"$@\" > \"{dir}/up-args\"; : > \"{dir}/up\" ;;\nesac\n"
    )
}

fn bin(home: &Path) -> PathBuf {
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).expect("bin");
    bin
}

fn setup(bin: &Path) -> Setup {
    Setup {
        search_path: bin.as_os_str().to_owned(),
        platform: Platform::default(),
        auth_key: None,
        login_deadline: Duration::from_secs(5),
        ready_deadline: Duration::ZERO,
        ready_poll: Duration::from_millis(1),
    }
}

fn step(step: &'static str, via: Option<&str>, ok: bool) -> Receipted {
    Receipted {
        step,
        via: via.map(str::to_owned),
        ok,
    }
}

fn up_args(home: &Path) -> Vec<String> {
    std::fs::read_to_string(home.join("up-args"))
        .expect("up recorded its arguments")
        .lines()
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn running_node_needs_only_locate_and_status() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    let cli = script::script(&bin, "tailscale", &format!("#!/bin/sh\nprintf '%s' '{RUNNING}'\n"));
    let receipt = tailnet::ensure(&setup(&bin)).await.expect("running node");
    assert_eq!(receipt.state, State::Running);
    assert_eq!(receipt.cli, cli);
    assert_eq!(
        receipt.steps,
        [
            step("locate", Some(&cli.display().to_string()), true),
            step("status", Some("Running"), true),
        ]
    );
    let json = serde_json::to_value(&receipt).expect("receipt json");
    assert_eq!(json["state"], "Running");
    assert_eq!(json.get("cli"), None);
    assert_eq!(json["steps"][1], serde_json::json!({"step":"status","via":"Running","ok":true}));
}

#[tokio::test]
async fn logged_out_node_is_logged_in_and_ready_once_running() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    let cli = script::script(&bin, "tailscale", &logged_out(home.path()));
    let receipt = tailnet::ensure(&setup(&bin)).await.expect("logged in");
    assert_eq!(receipt.cli, cli);
    assert_eq!(
        receipt.steps,
        [
            step("locate", Some(&cli.display().to_string()), true),
            step("status", Some("NeedsLogin"), true),
            step("up", Some("login"), true),
            step("status", Some("Running"), true),
        ]
    );
    assert_eq!(up_args(home.path()), ["up"]);
}

#[tokio::test]
async fn auth_key_is_presented_to_up_and_never_recorded() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    script::script(&bin, "tailscale", &logged_out(home.path()));
    let setup = Setup {
        auth_key: Some("tskey-auth-secret".into()),
        ..setup(&bin)
    };
    let receipt = tailnet::ensure(&setup).await.expect("logged in with the key");
    assert_eq!(receipt.steps[2], step("up", Some("auth-key"), true));
    assert_eq!(up_args(home.path()), ["up", "--auth-key=tskey-auth-secret"]);
    let json = serde_json::to_string(&receipt).expect("receipt json");
    assert!(!json.contains("tskey"), "{json}");
}

#[tokio::test]
async fn absent_tailscale_without_a_recipe_refuses_tailscale_absent() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    let refusal = tailnet::ensure(&setup(&bin)).await.expect_err("absent");
    assert_eq!(refusal.reason, Reason::Absent);
    assert_eq!(refusal.steps, [step("locate", None, false)]);
    assert_eq!(refusal.to_string(), "tailscale_absent");
    assert!(refusal.reason.next_step().contains("install Tailscale"));
}

#[tokio::test]
async fn absent_tailscale_is_installed_by_the_platform_recipe_then_logged_in() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    let staged = script::script(home.path(), "staged-tailscale", &logged_out(home.path()));
    let installed = home.path().join("installed/tailscale");
    script::script(
        &bin,
        "install-tailscale",
        &format!(
            "#!/bin/sh\nmkdir -p \"{}\" && cp \"{}\" \"{}\"\n",
            home.path().join("installed").display(),
            staged.display(),
            installed.display()
        ),
    );
    let setup = Setup {
        platform: Platform {
            install: vec![Step::new("install-tailscale", &[])],
            installed: vec![installed.clone()],
            start: vec![],
            elevate: vec![],
        },
        ..setup(&bin)
    };
    let receipt = tailnet::ensure(&setup).await.expect("installed and logged in");
    assert_eq!(receipt.cli, installed);
    assert_eq!(
        receipt.steps,
        [
            step("locate", None, false),
            step("install", Some("install-tailscale"), true),
            step("locate", Some(&installed.display().to_string()), true),
            step("status", Some("NeedsLogin"), true),
            step("up", Some("login"), true),
            step("status", Some("Running"), true),
        ]
    );
}

#[tokio::test]
async fn install_step_failure_refuses_tailscale_install_failed() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    script::script(&bin, "fail-install", "#!/bin/sh\nexit 1\n");
    for (recipe, via) in [
        (Step::new("brew", &["install", "--cask", "tailscale"]), "brew install --cask tailscale"),
        (Step::new("fail-install", &[]), "fail-install"),
    ] {
        let setup = Setup {
            platform: Platform {
                install: vec![recipe],
                ..Platform::default()
            },
            ..setup(&bin)
        };
        let refusal = tailnet::ensure(&setup).await.expect_err("install failed");
        assert_eq!(refusal.reason, Reason::InstallFailed { via: via.into() });
        assert_eq!(refusal.steps, [step("locate", None, false), step("install", Some(via), false)]);
        assert_eq!(refusal.to_string(), "tailscale_install_failed");
        assert!(refusal.reason.next_step().contains(via), "{}", refusal.reason.next_step());
    }
}

#[tokio::test]
async fn install_that_leaves_no_binary_refuses_tailscale_install_failed() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    script::script(&bin, "noop-install", "#!/bin/sh\nexit 0\n");
    let setup = Setup {
        platform: Platform {
            install: vec![Step::new("noop-install", &[])],
            installed: vec![home.path().join("never/tailscale")],
            ..Platform::default()
        },
        ..setup(&bin)
    };
    let refusal = tailnet::ensure(&setup).await.expect_err("nothing installed");
    assert_eq!(
        refusal.reason,
        Reason::InstallFailed {
            via: "locate after install".into()
        }
    );
    assert_eq!(
        refusal.steps,
        [
            step("locate", None, false),
            step("install", Some("noop-install"), true),
            step("locate", None, false),
        ]
    );
}

#[tokio::test]
async fn unanswering_daemon_without_a_start_recipe_refuses_tailscale_down() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    for body in ["#!/bin/sh\nexit 1\n", "#!/bin/sh\nprintf 'not json'\n"] {
        let cli = script::script(&bin, "tailscale", body);
        let refusal = tailnet::ensure(&setup(&bin)).await.expect_err("down");
        assert_eq!(refusal.reason, Reason::Down { via: None });
        assert_eq!(
            refusal.steps,
            [
                step("locate", Some(&cli.display().to_string()), true),
                step("status", None, false),
            ]
        );
        assert_eq!(refusal.to_string(), "tailscale_down");
        assert_eq!(
            refusal.reason.next_step(),
            "start Tailscale and re-join once `tailscale status` answers"
        );
    }
}

#[tokio::test]
async fn start_step_failure_refuses_tailscale_down_naming_the_step() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    script::script(&bin, "tailscale", "#!/bin/sh\nexit 1\n");
    let setup = Setup {
        platform: Platform {
            start: vec![Step::new("open", &["-a", "Tailscale"])],
            ..Platform::default()
        },
        ..setup(&bin)
    };
    let refusal = tailnet::ensure(&setup).await.expect_err("start failed");
    assert_eq!(
        refusal.reason,
        Reason::Down {
            via: Some("open -a Tailscale".into())
        }
    );
    assert_eq!(refusal.steps[2], step("start", Some("open -a Tailscale"), false));
    assert!(
        refusal.reason.next_step().starts_with("`open -a Tailscale` did not bring tailscaled up"),
        "{}",
        refusal.reason.next_step()
    );
}

#[tokio::test]
async fn started_daemon_that_never_answers_refuses_tailscale_down() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    script::script(&bin, "tailscale", "#!/bin/sh\nexit 1\n");
    script::script(&bin, "start-tailscaled", "#!/bin/sh\nexit 0\n");
    let setup = Setup {
        platform: Platform {
            start: vec![Step::new("start-tailscaled", &[])],
            ..Platform::default()
        },
        ..setup(&bin)
    };
    let refusal = tailnet::ensure(&setup).await.expect_err("never answered");
    assert_eq!(
        refusal.reason,
        Reason::Down {
            via: Some("start-tailscaled".into())
        }
    );
    assert_eq!(
        &refusal.steps[1..],
        [
            step("status", None, false),
            step("start", Some("start-tailscaled"), true),
            step("status", None, false),
        ]
    );
}

#[tokio::test]
async fn started_daemon_is_polled_until_it_runs() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    let dir = home.path().display();
    script::script(
        &bin,
        "tailscale",
        &format!(
            "#!/bin/sh\n[ -f \"{dir}/started\" ] || exit 1\nn=$(cat \"{dir}/n\" 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > \"{dir}/n\"\nif [ \"$n\" -ge 2 ]; then printf '%s' '{RUNNING}'; else printf '%s' '{{\"BackendState\":\"Starting\"}}'; fi\n"
        ),
    );
    script::script(&bin, "start-tailscaled", &format!("#!/bin/sh\n: > \"{dir}/started\"\n"));
    let setup = Setup {
        platform: Platform {
            start: vec![Step::new("start-tailscaled", &[])],
            ..Platform::default()
        },
        ready_deadline: Duration::from_secs(30),
        ..setup(&bin)
    };
    let receipt = tailnet::ensure(&setup).await.expect("started and running");
    assert_eq!(
        &receipt.steps[1..],
        [
            step("status", None, false),
            step("start", Some("start-tailscaled"), true),
            step("status", Some("Starting"), true),
            step("status", Some("Running"), true),
        ]
    );
}

#[tokio::test]
async fn failed_login_refuses_tailscale_login_failed() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    script::script(
        &bin,
        "tailscale",
        "#!/bin/sh\ncase \"$1\" in status) printf '%s' '{\"BackendState\":\"NeedsLogin\"}' ;; up) exit 1 ;; esac\n",
    );
    let refusal = tailnet::ensure(&setup(&bin)).await.expect_err("login failed");
    assert_eq!(refusal.reason, Reason::LoginFailed);
    assert_eq!(refusal.steps[2], step("up", Some("login"), false));
    assert_eq!(refusal.to_string(), "tailscale_login_failed");
    assert!(refusal.reason.next_step().starts_with("`tailscale up` failed"));
}

#[tokio::test]
async fn login_past_the_deadline_refuses_tailscale_login_timeout() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    script::script(
        &bin,
        "tailscale",
        "#!/bin/sh\ncase \"$1\" in status) printf '%s' '{\"BackendState\":\"NeedsLogin\"}' ;; up) exec tail -f /dev/null ;; esac\n",
    );
    let setup = Setup {
        login_deadline: Duration::from_millis(10),
        ..setup(&bin)
    };
    let refusal = tailnet::ensure(&setup).await.expect_err("login timed out");
    assert_eq!(refusal.reason, Reason::LoginTimeout);
    assert_eq!(refusal.to_string(), "tailscale_login_timeout");
    assert!(refusal.reason.next_step().starts_with("finish the browser login"));
}

#[tokio::test]
async fn elevated_login_runs_the_cli_through_the_elevation_program() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    let cli = script::script(&bin, "tailscale", &logged_out(home.path()));
    let dir = home.path().display();
    script::script(
        &bin,
        "sudo",
        &format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{dir}/sudo-args\"\nshift\nexec \"$@\"\n"),
    );
    let setup = Setup {
        platform: Platform {
            elevate: vec!["sudo".into(), "-n".into()],
            ..Platform::default()
        },
        auth_key: Some("tskey-k".into()),
        ..setup(&bin)
    };
    let receipt = tailnet::ensure(&setup).await.expect("elevated login");
    assert_eq!(receipt.steps[2], step("up", Some("auth-key"), true));
    assert_eq!(
        std::fs::read_to_string(home.path().join("sudo-args")).expect("sudo ran"),
        format!("-n\n{}\nup\n--auth-key=tskey-k\n", cli.display())
    );
    assert_eq!(up_args(home.path()), ["up", "--auth-key=tskey-k"]);
}

#[tokio::test]
async fn missing_or_unexecutable_elevation_program_refuses_tailscale_login_failed() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    script::script(&bin, "tailscale", &logged_out(home.path()));
    let setup = Setup {
        platform: Platform {
            elevate: vec!["sudo".into()],
            ..Platform::default()
        },
        ..setup(&bin)
    };
    let refusal = tailnet::ensure(&setup).await.expect_err("no sudo");
    assert_eq!(refusal.reason, Reason::LoginFailed);
    assert_eq!(refusal.steps[2], step("up", Some("login"), false));
    std::fs::write(bin.join("sudo"), "not executable").expect("plain file");
    let refusal = tailnet::ensure(&setup).await.expect_err("unexecutable sudo");
    assert_eq!(refusal.reason, Reason::LoginFailed);
    assert!(!home.path().join("up").exists());
}

#[tokio::test]
async fn node_still_not_running_after_login_refuses_tailscale_not_ready() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    for (reported, state) in [
        ("NeedsMachineAuth", State::NeedsMachineAuth),
        ("Weird", State::Unknown),
    ] {
        script::script(
            &bin,
            "tailscale",
            &format!(
                "#!/bin/sh\ncase \"$1\" in status) printf '%s' '{{\"BackendState\":\"{reported}\"}}' ;; up) exit 0 ;; esac\n"
            ),
        );
        let refusal = tailnet::ensure(&setup(&bin)).await.expect_err("not ready");
        assert_eq!(refusal.reason, Reason::NotReady { state });
        assert_eq!(refusal.to_string(), "tailscale_not_ready");
        assert_eq!(
            refusal.reason.next_step(),
            format!("tailscale reports {state:?}; re-join once it reports Running")
        );
    }
}

#[tokio::test]
async fn daemon_lost_after_login_refuses_tailscale_down() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    let dir = home.path().display();
    script::script(
        &bin,
        "tailscale",
        &format!(
            "#!/bin/sh\ncase \"$1\" in status) [ -f \"{dir}/up\" ] && exit 1; printf '%s' '{{\"BackendState\":\"Stopped\"}}' ;; up) : > \"{dir}/up\" ;; esac\n"
        ),
    );
    let refusal = tailnet::ensure(&setup(&bin)).await.expect_err("lost");
    assert_eq!(refusal.reason, Reason::Down { via: None });
    assert_eq!(
        &refusal.steps[1..],
        [
            step("status", Some("Stopped"), true),
            step("up", Some("login"), true),
            step("status", None, false),
        ]
    );
}

#[test]
fn platform_recipes_name_the_os_install_start_and_elevation() {
    let macos = Platform::for_os("macos");
    assert_eq!(macos.install, [Step::new("brew", &["install", "--cask", "tailscale"])]);
    assert_eq!(
        macos.installed,
        [PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale")]
    );
    assert_eq!(macos.start, [Step::new("open", &["-a", "Tailscale"])]);
    assert!(macos.elevate.is_empty());
    let linux = Platform::for_os("linux");
    assert_eq!(linux.install[0].display(), "sh -c curl -fsSL https://tailscale.com/install.sh | sh");
    assert_eq!(
        linux.installed,
        [PathBuf::from("/usr/bin/tailscale"), PathBuf::from("/usr/sbin/tailscale")]
    );
    assert_eq!(linux.start[0].display(), "sudo systemctl start tailscaled");
    assert_eq!(linux.elevate, ["sudo"]);
    assert_eq!(Platform::for_os("plan9"), Platform::default());
    assert_eq!(Platform::current(), Platform::for_os(std::env::consts::OS));
}

#[test]
fn locate_prefers_the_search_path_over_platform_locations() {
    let home = tempfile::tempdir().expect("home");
    let bin = bin(home.path());
    let installed = script::script(home.path(), "tailscale", "#!/bin/sh\n");
    let path = OsString::from(format!("{}:{}", home.path().join("absent").display(), bin.display()));
    assert_eq!(
        tailnet::locate(&path, &[installed.clone()]),
        Some(installed.clone())
    );
    let on_path = script::script(&bin, "tailscale", "#!/bin/sh\n");
    assert_eq!(tailnet::locate(&path, &[installed]), Some(on_path));
    assert_eq!(tailnet::locate(&OsString::new(), &[]), None);
}

#[test]
fn setup_from_env_reads_the_search_path_and_auth_key() {
    let options = |key: Option<&str>| JoinOptions {
        host: "127.0.0.1".into(),
        mode: None,
        tailscale_auth_key: key.map(str::to_owned),
        json: false,
        name: None,
        tags: vec![],
        exports: vec![],
        host_pin: None,
        unix: None,
        memory_budget_mb: DEFAULT_MEMORY_BUDGET_MB,
        no_service: true,
        service_dir: None,
        no_open: true,
        token: None,
    };
    let env = |name: &str| match name {
        "PATH" => Some("/one:/two".to_owned()),
        tailnet::AUTH_KEY_VARIABLE => Some("tskey-env".to_owned()),
        _ => None,
    };
    let setup = Setup::from_env(&options(Some("tskey-flag")), &env);
    assert_eq!(setup.search_path, "/one:/two");
    assert_eq!(setup.auth_key.as_deref(), Some("tskey-flag"));
    assert_eq!(setup.platform, Platform::current());
    assert_eq!(setup.login_deadline, tailnet::LOGIN_DEADLINE);
    assert_eq!(setup.ready_deadline, tailnet::READY_DEADLINE);
    assert_eq!(setup.ready_poll, tailnet::READY_POLL);
    assert_eq!(
        Setup::from_env(&options(None), &env).auth_key.as_deref(),
        Some("tskey-env")
    );
    let bare = Setup::from_env(&options(Some("")), &|_| None);
    assert_eq!(bare.search_path, "");
    assert_eq!(bare.auth_key, None);
}
