use std::{
    env::consts::{ARCH, OS},
    io::{BufRead, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{SystemTime, UNIX_EPOCH},
};

use clap::{Parser, Subcommand};
use oni_machine_client::{
    agent::hook,
    attach::{self, AttachError},
    config::{self, JoinOptions},
    handlers,
    release::{self, Identity, Layout, UpdateError, VERSION},
    service,
    transport::classes,
};

#[derive(Parser)]
#[command(name = "mclient", disable_version_flag = true)]
struct Cli {
    #[arg(long)]
    version: bool,
    #[arg(long, requires = "version")]
    json: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    #[command(
        after_help = "Manual service restart: launchctl kickstart -k gui/<uid>/ai.oni.machine"
    )]
    Join(Box<JoinOptions>),
    Status {
        #[arg(long)]
        json: bool,
    },
    Run {
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        allow_unpinned: bool,
        #[arg(long)]
        once: bool,
    },
    /// Fetch the host's release, verify its sha256, switch the current
    /// binary and restart the service; `upgrade` is the same verb under the
    /// name the install script and `oni machine bootstrap` print.
    #[command(alias = "upgrade")]
    Update {
        #[arg(long, conflicts_with = "file")]
        from: Option<String>,
        #[arg(long)]
        file: Option<PathBuf>,
        /// Verify the release's contract against this binary without switching.
        #[arg(long)]
        check: bool,
        /// The host's contract version when it is already known; only with --check.
        #[arg(long, requires = "check")]
        host_contract: Option<u64>,
    },
    /// `update --check --file <release>` under the name clients published before
    /// it call while they verify this binary as their staged release.
    #[command(hide = true)]
    Probe {
        #[arg(long)]
        release: PathBuf,
        #[arg(long)]
        host_contract: Option<u64>,
    },
    /// Ask the running service to reconnect now instead of after its backoff.
    Reconnect {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Consent to offer one more capability the host's enrollment allows;
    /// the running service re-attaches with it.
    Grant {
        capability: String,
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Plumbing for launched CLI agents; not a user entry point.
    #[command(subcommand, hide = true)]
    Hook(Hook),
}

#[derive(Subcommand)]
enum Hook {
    Permission {
        #[arg(long)]
        cli: String,
    },
    Ready,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    if cli.version {
        version(cli.json);
        return ExitCode::SUCCESS;
    }
    let result = match cli.command {
        Some(Command::Join(options)) => join(&options).await,
        Some(Command::Status { json }) => status(json),
        Some(Command::Run {
            config,
            allow_unpinned,
            once,
        }) => run(config, allow_unpinned, once).await,
        Some(Command::Update {
            from,
            file,
            check: true,
            host_contract,
        }) => check(from, file, host_contract).await,
        Some(Command::Update { from, file, .. }) => update(from, file).await,
        Some(Command::Probe {
            release,
            host_contract,
        }) => check(None, Some(release), host_contract).await,
        Some(Command::Reconnect { config }) => reconnect(config.as_deref()),
        Some(Command::Grant { capability, config }) => grant(&capability, config.as_deref()),
        Some(Command::Hook(Hook::Permission { cli })) => {
            let socket = config::agent_hook_socket();
            let outcome =
                hook::run(&cli, std::io::stdin().lock(), &socket, hook::ASK_DEADLINE).await;
            print!("{}", outcome.stdout);
            eprint!("{}", outcome.stderr);
            return ExitCode::from(outcome.code);
        }
        Some(Command::Hook(Hook::Ready)) => {
            let file = std::env::var_os(config::AGENT_READY_FILE_VARIABLE).map(PathBuf::from);
            return match hook::ready(file, std::io::stdin().lock()) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("oni: ready hook: {error}");
                    ExitCode::from(1)
                }
            };
        }
        None => {
            eprintln!(
                "usage: mclient --version | join <host> | status | run | update|upgrade | reconnect"
            );
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let refusal = match &error {
                AttachError::Update(update) => serde_json::json!({
                    "reason": error.reason(), "class": update.class(), "detail": update.to_string()
                }),
                AttachError::Config(config::ConfigError::LegacyHostPin) => serde_json::json!({
                    "reason": error.reason(), "class": classes::classify(&error), "nextStep": error.next_step()
                }),
                _ => serde_json::json!({"reason": error.reason()}),
            };
            eprintln!("{refusal}");
            exit_error(&error, ExitCode::from)
        }
    }
}

fn exit_error(error: &AttachError, exit: impl FnOnce(u8) -> ExitCode) -> ExitCode {
    exit(error.exit_code())
}

fn version(json: bool) {
    let contract_version = u64::from(oni_protocol::CONTRACT_VERSION);
    if json {
        let identity = Identity {
            version: VERSION.to_owned(),
            contract_version,
        };
        println!("{}", serde_json::json!(identity));
    } else {
        println!("mclient {VERSION} contract {contract_version}");
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

async fn run(path: Option<PathBuf>, allow_unpinned: bool, once: bool) -> Result<(), AttachError> {
    let file = path.unwrap_or_else(|| config::root().join("machine-client/client.json"));
    let pin = release::load_pin(file.parent().unwrap_or(&file))?;
    release::admit(pin.as_ref(), VERSION, allow_unpinned)?;
    if once {
        attach::run_service_once(&file).await
    } else {
        attach::run_service(&file).await
    }
}

/// `update --check`: the release an update would select, verified against
/// this binary's contract and the host's, without staging or switching.
/// An explicit `--from`/`--file` document is checked without connecting, so
/// the host's contract then comes only from `--host-contract`; the staged
/// binary is checked this way before every switch.
async fn check(
    from: Option<String>,
    file: Option<PathBuf>,
    host: Option<u64>,
) -> Result<(), AttachError> {
    let location = from.or_else(|| file.map(|path| path.to_string_lossy().into_owned()));
    let (document, host) = match location {
        Some(location) => (release::document(&location)?, host),
        None => {
            let (document, _, hosted) = source(&Layout::new(config::root()), None, None).await?;
            (document, host.or(hosted))
        }
    };
    let release = release::parse_release(document)?;
    release::compatible(
        u64::from(oni_protocol::CONTRACT_VERSION),
        release.contract_version,
        host,
    )?;
    println!(
        "{}",
        serde_json::json!({"status": "compatible", "version": release.version})
    );
    Ok(())
}

async fn source(
    layout: &Layout,
    from: Option<String>,
    file: Option<PathBuf>,
) -> Result<(serde_json::Value, String, Option<u64>), UpdateError> {
    let hosted = hosted_release(&layout.client()).await;
    let host = hosted
        .as_ref()
        .and_then(|document| document["contractVersion"].as_u64());
    if let Some(location) = from.or_else(|| file.map(|path| path.to_string_lossy().into_owned())) {
        return Ok((release::document(&location)?, location, host));
    }
    hosted_source(hosted)
}

fn hosted_source(
    hosted: Option<serde_json::Value>,
) -> Result<(serde_json::Value, String, Option<u64>), UpdateError> {
    let document = hosted.ok_or(UpdateError::ReleaseUnavailable)?;
    release::hosted_artifact(&document, release::platform(OS, ARCH))?;
    let host = document["contractVersion"].as_u64();
    Ok((document, String::new(), host))
}

async fn hosted_release(directory: &Path) -> Option<serde_json::Value> {
    let config = config::load(&directory.join("client.json")).ok()?;
    attach::release(&config, directory).await.ok().flatten()
}

async fn update(from: Option<String>, file: Option<PathBuf>) -> Result<(), AttachError> {
    let layout = Layout::new(config::root());
    let previous = std::fs::read_link(layout.current()).ok();
    let pin = release::load_pin(&layout.client());
    let prepared = release::prepare_record(&layout);
    let outcome = match source(&layout, from, file).await {
        Ok((document, base, host)) => pin
            .as_ref()
            .map_err(|error| UpdateError::Io(std::io::Error::other(error.to_string())))
            .and_then(|_| prepared.map_err(UpdateError::Io))
            .and_then(|_| {
                release::update(&layout, document, &base, release::platform(OS, ARCH), host)
            })
            .and_then(|release| {
                #[cfg(target_os = "macos")]
                release::publish_executable(&layout)?;
                release::restart(&release::restart_argv(OS, nix::unistd::getuid().as_raw()))?;
                Ok(release)
            }),
        Err(error) => Err(error),
    };
    let receipt = release::record(&layout, &outcome, now_ms());
    let outcome = match (outcome, receipt) {
        (Ok(release), Ok(())) => Ok(release),
        (outcome, receipt) => {
            let error = outcome
                .err()
                .unwrap_or_else(|| UpdateError::Io(receipt.expect_err("failed receipt")));
            let switched = std::fs::read_link(layout.current()).ok() != previous;
            if switched {
                let recovery = release::rollback(
                    &layout,
                    previous.as_deref(),
                    pin.as_ref().ok().and_then(Option::as_ref),
                )
                .map_err(UpdateError::Io)
                .and_then(|_| {
                    if previous.is_some() {
                        release::restart(&release::restart_argv(OS, nix::unistd::getuid().as_raw()))
                    } else {
                        Ok(())
                    }
                });
                if let Err(recovery) = recovery {
                    return Err(UpdateError::Io(std::io::Error::other(format!(
                        "{error}; recovery failed: {recovery}"
                    )))
                    .into());
                }
            }
            Err(error)
        }
    };
    let release = outcome?;
    println!(
        "{}",
        serde_json::json!({"status": "switched", "version": release.version})
    );
    Ok(())
}

fn config_directory(config_path: Option<&Path>) -> PathBuf {
    config_path
        .and_then(Path::parent)
        .map_or_else(config::agent_registry_directory, Path::to_path_buf)
}

fn reconnect(config_path: Option<&Path>) -> Result<(), AttachError> {
    use nix::{
        sys::signal::{kill, Signal},
        unistd::Pid,
    };
    let directory = config_directory(config_path);
    let pid = attach::service_pid(&directory)?.ok_or(AttachError::ServiceUnavailable)?;
    let pid = i32::try_from(pid).map_err(|_| AttachError::ServiceUnavailable)?;
    kill(Pid::from_raw(pid), Signal::SIGUSR1).map_err(|_| AttachError::ServiceUnavailable)
}

/// Records the operator's consent and prints the declared set; a running
/// service is asked to re-attach so the host sees the wider offer now.
fn grant(capability: &str, config_path: Option<&Path>) -> Result<(), AttachError> {
    let directory = config_directory(config_path);
    let declared = config::grant(&directory, capability, &handlers::SUPPORTED)?;
    println!("declared capabilities: {}", declared.join(", "));
    match reconnect(config_path) {
        Ok(()) => println!("service: reconnecting"),
        Err(AttachError::ServiceUnavailable) => println!("service: not running"),
        Err(error) => return Err(error),
    }
    Ok(())
}

/// Shows the operator the host they are about to trust and reads one line
/// from stdin; only `y`/`yes` approves, a closed stdin leaves it untrusted.
/// The prompt goes to stderr so stdout stays the receipt; the refusal that
/// follows an unanswered prompt starts on its own line.
fn confirm_host(host: &str, pin: &str) -> bool {
    eprintln!("host: {host}");
    eprintln!("host pin: {pin}");
    eprint!("trust this host? [y/N] ");
    let _ = std::io::stderr().flush();
    let mut answer = String::new();
    let _ = std::io::stdin().lock().read_line(&mut answer);
    if !answer.ends_with('\n') {
        eprintln!();
    }
    matches!(answer.trim(), "y" | "Y" | "yes")
}

async fn join(options: &JoinOptions) -> Result<(), AttachError> {
    let enrollment =
        attach::join(options, &config::root(), &handlers::SUPPORTED, confirm_host).await?;
    let layout = Layout::new(config::root());
    let path = layout.client().join("client.json");
    if !options.json {
        println!("{}", enrollment.receipt);
        println!("config: {}", path.display());
    }
    let hosted = hosted_release(&layout.client()).await;
    let previous = std::fs::read_link(layout.current()).ok();
    let previous_pin = release::load_pin(&layout.client())?;
    let (binary, pin) = selected_binary(&layout, &std::env::current_exe()?, hosted)?;
    let (service_binary, state) = service_binary(&layout, binary)
        .and_then(|service_binary| {
            let state = service::install(options, &config::home(), &path, &service_binary)?;
            Ok((service_binary, state))
        })
        .map_err(|error| {
            recover_join_install(
                &layout,
                previous.as_deref(),
                previous_pin.as_ref(),
                options.no_service,
                error,
            )
        })?;
    if options.json {
        let mut record = status_record(options.service_dir.as_deref(), options.no_service)?;
        record["receipt"] = enrollment.receipt;
        println!("{record}");
        Ok(())
    } else {
        println!("service: {} ({})", state.name, state.state);
        println!("offered capabilities: {}", enrollment.declared.join(", "));
        println!("{}", service::screen(options.no_open, &service_binary)?);
        println!("{}", pin_line(&pin));
        print_status(false, options.service_dir.as_deref(), options.no_service)
    }
}

/// The binary the service runs: on macOS the published real path, so TCC
/// grants survive version switches; elsewhere the selected versioned binary.
#[cfg(target_os = "macos")]
fn service_binary(layout: &Layout, _selected: PathBuf) -> std::io::Result<PathBuf> {
    release::publish_executable(layout)?;
    Ok(layout.executable())
}

#[cfg(not(target_os = "macos"))]
fn service_binary(_layout: &Layout, selected: PathBuf) -> std::io::Result<PathBuf> {
    Ok(selected)
}

fn status(json: bool) -> Result<(), AttachError> {
    print_status(json, None, false)
}

/// A consent record or identity that no longer parses is a refusal, not a
/// blank line: the operator sees the typed reason instead of a healthy report.
fn status_record(
    service_dir: Option<&Path>,
    no_service: bool,
) -> Result<serde_json::Value, AttachError> {
    let (screen, input) = oni_machine_client::computer::platform();
    let mut verdict = screen.capability(input.ready());
    service::setup_needs(&mut verdict, &config::home(), service_dir, no_service);
    let directory = config::agent_registry_directory();
    let consent = attach::pending_consent(&directory)?;
    let identity = config::identity_pin(&directory)?;
    Ok(serde_json::json!({
        "ok": !verdict.needs.iter().any(|row| !row.on_screen),
        "version": VERSION,
        "os": OS,
        "verdict": verdict.verdict,
        "blockers": verdict.blockers,
        "needs": verdict.needs,
        "identity": identity,
        "consentRequired": consent,
    }))
}

fn print_status(
    json: bool,
    service_dir: Option<&Path>,
    no_service: bool,
) -> Result<(), AttachError> {
    let record = status_record(service_dir, no_service)?;
    if json {
        println!("{record}");
    } else {
        println!("screen: {} ({})", record["verdict"], record["blockers"]);
        for need in record["needs"]
            .as_array()
            .expect("needs is serialized as an array")
        {
            println!("setup: {} — {}", need["step"], need["action"]);
        }
        if let Some(pin) = record["identity"].as_str() {
            println!("identity: {pin}");
        }
        for capability in consent_rows(&record["consentRequired"]["capabilities"]) {
            println!("consent required: capability {capability} — mclient grant {capability}");
        }
        for export in consent_rows(&record["consentRequired"]["exports"]) {
            println!("consent required: export {export} — re-join with --export {export}=<path>");
        }
    }
    Ok(())
}

/// The names in one consent list, or nothing when no consent is pending.
fn consent_rows(list: &serde_json::Value) -> impl Iterator<Item = &str> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
}

fn selected_binary(
    layout: &Layout,
    running: &Path,
    hosted: Option<serde_json::Value>,
) -> Result<(PathBuf, release::Pin), UpdateError> {
    release::join_binary(layout, running, hosted, release::platform(OS, ARCH))
}

fn recover_join_install(
    layout: &Layout,
    previous: Option<&Path>,
    previous_pin: Option<&release::Pin>,
    no_service: bool,
    error: std::io::Error,
) -> AttachError {
    let recovery = release::rollback(layout, previous, previous_pin).and_then(|_| {
        if previous.is_some() && !no_service {
            release::restart(&release::restart_argv(OS, nix::unistd::getuid().as_raw()))
                .map_err(std::io::Error::other)
        } else {
            Ok(())
        }
    });
    AttachError::Io(std::io::Error::other(format!(
        "service install failed ({error}); recovery: {recovery:?}"
    )))
}

fn pin_line(pin: &release::Pin) -> String {
    format!(
        "pin: {} ({})",
        pin.pinned_version,
        if pin.pinned {
            "host release"
        } else {
            "unpinned"
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    static ENVIRONMENT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    struct RestoreEnv(&'static str, Option<OsString>);

    impl RestoreEnv {
        fn set(name: &'static str, value: &std::ffi::OsStr) -> Self {
            let previous = std::env::var_os(name);
            std::env::set_var(name, value);
            Self(name, previous)
        }
    }

    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            if let Some(previous) = &self.1 {
                std::env::set_var(self.0, previous);
            } else {
                std::env::remove_var(self.0);
            }
        }
    }

    #[tokio::test]
    async fn source_from_file_reads_document_and_refuses_missing_document() {
        let home = tempfile::tempdir().expect("isolated home");
        let layout = Layout::new(home.path().join(".oni"));
        let path = home.path().join("release.json");
        let document = serde_json::json!({"version": "2.0.0"});
        std::fs::write(&path, document.to_string()).expect("release document");
        let (selected, base, host) = source(&layout, None, Some(path.clone()))
            .await
            .expect("file source");
        assert_eq!(selected, document);
        assert_eq!(base, path.to_string_lossy());
        assert_eq!(host, None);
        std::fs::remove_file(&path).expect("remove document");
        assert!(matches!(
            source(&layout, Some(path.to_string_lossy().into_owned()), None).await,
            Err(UpdateError::ReleaseUnavailable)
        ));
    }

    #[tokio::test]
    async fn source_without_file_uses_hosted_release() {
        use oni_machine_client::transport::framing::{write_frame, Framed};
        use tokio::{io::AsyncWriteExt, net::UnixListener};

        let home = tempfile::tempdir().expect("isolated home");
        let layout = Layout::new(home.path().join(".oni"));
        let socket = home.path().join("host.sock");
        let listener = UnixListener::bind(&socket).expect("release host");
        config::save(
            &config::ClientConfig {
                machine_id: "machine".to_owned(),
                name: "Machine".to_owned(),
                host: "localhost".to_owned(),
                exports: vec![],
                tags: vec![],
                memory_budget_mb: config::DEFAULT_MEMORY_BUDGET_MB,
                unix: Some(socket),
                tmux_socket: None,
                declared: None,
            },
            &layout.client(),
        )
        .expect("client config");
        let platform = release::platform(OS, ARCH).expect("supported build platform");
        let document = serde_json::json!({
            "version": "2.0.0",
            "contractVersion": oni_protocol::CONTRACT_VERSION,
            "artifacts": {platform: {
                "name": "mclient.tar.gz",
                "bytes": 1,
                "sha256": "0".repeat(64),
                "url": "https://example.invalid/mclient.tar.gz"
            }}
        });
        let exchange = async {
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
        let (result, ()) = tokio::join!(source(&layout, None, None), exchange);
        let (selected, base, host) = result.expect("hosted source");
        assert_eq!(selected, document);
        assert!(base.is_empty());
        assert_eq!(host, Some(u64::from(oni_protocol::CONTRACT_VERSION)));
    }

    #[tokio::test]
    async fn source_without_file_refuses_missing_hosted_release() {
        let home = tempfile::tempdir().expect("isolated home");
        let layout = Layout::new(home.path().join(".oni"));
        assert!(matches!(
            source(&layout, None, None).await,
            Err(UpdateError::ReleaseUnavailable)
        ));
    }

    #[test]
    fn hosted_source_requires_a_release_with_a_platform_artifact() {
        assert!(matches!(
            hosted_source(None),
            Err(UpdateError::ReleaseUnavailable)
        ));
        let platform = release::platform(OS, ARCH).expect("supported build platform");
        let document = serde_json::json!({
            "version": "2.0.0",
            "contractVersion": oni_protocol::CONTRACT_VERSION,
            "artifacts": {platform: {
                "name": "mclient.tar.gz",
                "bytes": 1,
                "sha256": "0".repeat(64),
                "url": "https://example.invalid/mclient.tar.gz"
            }}
        });
        let (selected, base, host) = hosted_source(Some(document.clone())).expect("hosted");
        assert_eq!(selected, document);
        assert!(base.is_empty());
        assert_eq!(host, Some(u64::from(oni_protocol::CONTRACT_VERSION)));
    }

    #[test]
    fn join_binary_refusal_is_propagated_without_installing_a_service() {
        let home = tempfile::tempdir().expect("isolated home");
        let layout = Layout::new(home.path().join(".oni"));
        let platform = release::platform(OS, ARCH).expect("supported build platform");
        let document = serde_json::json!({
            "version": "2.0.0",
            "contractVersion": oni_protocol::CONTRACT_VERSION,
            "artifacts": {platform: {
                "name": "mclient.tar.gz",
                "bytes": 1,
                "sha256": "0".repeat(64),
                "url": "file:///absent/mclient.tar.gz"
            }}
        });
        let error = selected_binary(&layout, home.path(), Some(document)).expect_err("no archive");
        assert_eq!(error.class(), "release_unavailable");
        assert!(!layout.current().exists());
    }

    #[test]
    fn service_install_failure_without_previous_link_needs_no_restart() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().expect("isolated home");
        let layout = Layout::new(home.path().join(".oni"));
        std::fs::create_dir_all(layout.current().parent().expect("bin")).expect("bin");
        symlink("/new/mclient", layout.current()).expect("new link");
        std::fs::create_dir_all(layout.client()).expect("client");
        let pin = release::Pin {
            pinned_version: VERSION.to_owned(),
            pinned: false,
        };
        release::save_pin(&layout.client(), &pin).expect("initial pin");
        let error = recover_join_install(
            &layout,
            None,
            Some(&pin),
            false,
            std::io::Error::other("install refused"),
        );
        assert!(error.to_string().contains("recovery: Ok(())"));
        assert!(!layout.current().exists());
    }

    #[test]
    fn service_install_failure_with_previous_link_restarts_restored_binary() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let _environment = ENVIRONMENT.blocking_lock();
        let home = tempfile::tempdir().expect("isolated home");
        let layout = Layout::new(home.path().join(".oni"));
        let previous = home.path().join("old-mclient");
        std::fs::write(&previous, b"old binary").expect("previous binary");
        std::fs::create_dir_all(layout.current().parent().expect("bin")).expect("bin");
        symlink("/new/mclient", layout.current()).expect("new link");
        std::fs::create_dir_all(layout.client()).expect("client");
        let pin = release::Pin {
            pinned_version: "1.0.0".to_owned(),
            pinned: true,
        };
        release::save_pin(&layout.client(), &pin).expect("original pin");
        let restart = release::restart_argv(OS, nix::unistd::getuid().as_raw());
        let manager = home.path().join(&restart[0]);
        std::fs::write(
            &manager,
            "#!/bin/sh\nprintf restarted > \"$MCLIENT_SERVICE_LOG\"\n",
        )
        .expect("service manager");
        std::fs::set_permissions(&manager, std::fs::Permissions::from_mode(0o755))
            .expect("executable manager");
        let log = home.path().join("manager.log");
        let _path = RestoreEnv::set("PATH", home.path().as_os_str());
        let _log = RestoreEnv::set("MCLIENT_SERVICE_LOG", log.as_os_str());
        let error = recover_join_install(
            &layout,
            Some(&previous),
            Some(&pin),
            false,
            std::io::Error::other("install refused"),
        );
        assert_eq!(
            error.to_string(),
            "I/O: service install failed (install refused); recovery: Ok(())"
        );
        assert_eq!(
            std::fs::read_link(layout.current()).expect("restored link"),
            previous
        );
        assert_eq!(
            std::fs::read_to_string(log).expect("service restart"),
            "restarted"
        );
    }

    #[tokio::test]
    async fn update_maps_unreadable_pin_to_io_refusal() {
        let _environment = ENVIRONMENT.lock().await;
        let home = tempfile::tempdir().expect("isolated home");
        let _home = RestoreEnv::set("HOME", home.path().as_os_str());
        let layout = Layout::new(config::root());
        std::fs::create_dir_all(layout.client()).expect("client directory");
        std::fs::write(layout.client().join("pin.json"), "{").expect("malformed pin");
        let document = home.path().join("release.json");
        std::fs::write(&document, "{}").expect("readable document");
        let error = update(None, Some(document))
            .await
            .expect_err("pin read fails");
        assert!(matches!(
            error,
            AttachError::Update(UpdateError::Io(ref refusal))
                if refusal.kind() == std::io::ErrorKind::Other
        ));
        assert!(!layout.current().exists());
    }

    #[tokio::test]
    async fn join_refuses_an_unsupported_proxy_before_dialing() {
        use oni_machine_client::transport::{client::TransportError, ws::ProxyFailure};
        let _environment = ENVIRONMENT.lock().await;
        let home = tempfile::tempdir().expect("isolated home");
        let _home = RestoreEnv::set("HOME", home.path().as_os_str());
        let _proxy = RestoreEnv::set("HTTPS_PROXY", "https://proxy.example:3128".as_ref());
        let options = JoinOptions {
            host: "wss://127.0.0.1:1/machine".into(),
            token: None,
            json: false,
            name: None,
            tags: vec![],
            exports: vec![],
            host_pin: Some(config::encode_pin(&[0; 32])),
            unix: None,
            memory_budget_mb: 96,
            no_service: true,
            service_dir: None,
            no_open: true,
            capabilities: vec![],
            rekey: false,
            yes: false,
        };
        let error = join(&options).await.expect_err("proxy refused");
        assert!(matches!(
            error,
            AttachError::Transport(TransportError::Proxy(ProxyFailure::Unsupported))
        ));
    }

    #[test]
    fn upgrade_is_the_update_verb_on_the_same_verified_path() {
        let cli = Cli::try_parse_from(["mclient", "upgrade"]).expect("upgrade parses");
        assert!(matches!(
            cli.command,
            Some(Command::Update {
                from: None,
                file: None,
                check: false,
                host_contract: None
            })
        ));
        let cli = Cli::try_parse_from([
            "mclient",
            "upgrade",
            "--from",
            "https://host/machine/release",
        ])
        .expect("upgrade --from parses");
        assert!(matches!(
            cli.command,
            Some(Command::Update { from: Some(ref location), check: false, .. })
                if location == "https://host/machine/release"
        ));
        assert!(Cli::try_parse_from(["mclient", "upgrade", "--host-contract", "4"]).is_err());
    }

    fn join_options(argv: &[&str]) -> Option<config::JoinOptions> {
        match Cli::try_parse_from(argv).ok()?.command {
            Some(Command::Join(options)) => Some(*options),
            _ => None,
        }
    }

    #[test]
    fn join_reads_the_token_from_the_environment_unless_overridden() {
        let explicit = join_options(&["mclient", "join", "oni-host", "--token", "jt"])
            .expect("join --token parses");
        assert_eq!(explicit.token.as_deref(), Some("jt"));
        assert!(join_options(&["mclient", "join", "oni-host", "--token"]).is_none());
        assert!(join_options(&["mclient"]).is_none());
        let bare = join_options(&["mclient", "join", "oni-host"]).expect("join parses");
        assert!(bare.token.is_none());
        let from_env =
            |name: &str| (name == config::JOIN_TOKEN_VARIABLE).then(|| "env-token".to_string());
        assert_eq!(
            config::join_token(&bare, &from_env).as_deref(),
            Some("env-token")
        );
        assert_eq!(config::join_token(&bare, &|_| None), None);
        assert_eq!(config::join_token(&bare, &|_| Some(String::new())), None);
        assert_eq!(
            config::join_token(&explicit, &from_env).as_deref(),
            Some("jt")
        );
        assert_eq!(config::JOIN_TOKEN_VARIABLE, "ONI_MCLIENT_JOIN_TOKEN");
    }

    #[test]
    fn pin_line_identifies_host_release_or_offline_binary() {
        assert_eq!(
            pin_line(&release::Pin {
                pinned_version: "2.0.0".to_owned(),
                pinned: true,
            }),
            "pin: 2.0.0 (host release)"
        );
        assert_eq!(
            pin_line(&release::Pin {
                pinned_version: VERSION.to_owned(),
                pinned: false,
            }),
            format!("pin: {VERSION} (unpinned)")
        );
    }

    #[test]
    fn grant_restart_exits_with_tempfail_through_injected_exit() {
        let mut code = None;
        let status = exit_error(&AttachError::GrantRestart, |value| {
            code = Some(value);
            ExitCode::from(value)
        });
        assert_eq!(code, Some(75));
        assert_eq!(status, ExitCode::from(75));
    }
}
