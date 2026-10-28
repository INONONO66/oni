use std::{path::PathBuf, process::ExitCode};

use clap::{Parser, Subcommand};
use oni_machine_client::{
    agent::hook,
    attach::{self, AttachError},
    config::{self, JoinOptions},
    handlers, service,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "mclient", disable_version_flag = true)]
struct Cli {
    #[arg(long)]
    version: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    Join(Box<JoinOptions>),
    Run {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    #[command(subcommand)]
    Hook(Hook),
}

#[derive(Subcommand)]
enum Hook {
    Permission {
        #[arg(long)]
        cli: String,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    if cli.version {
        println!(
            "mclient {VERSION} contract {}",
            oni_protocol::CONTRACT_VERSION
        );
        return ExitCode::SUCCESS;
    }
    let result = match cli.command {
        Some(Command::Join(options)) => join(&options).await,
        Some(Command::Run { config }) => attach::run_service(config.as_deref()).await,
        Some(Command::Hook(Hook::Permission { cli })) => {
            let socket = config::agent_hook_socket();
            let outcome =
                hook::run(&cli, std::io::stdin().lock(), &socket, hook::ASK_DEADLINE).await;
            print!("{}", outcome.stdout);
            eprint!("{}", outcome.stderr);
            return ExitCode::from(outcome.code);
        }
        None => {
            eprintln!("usage: mclient --version | join <host> | run");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", serde_json::json!({"reason": error.reason()}));
            ExitCode::from(error.exit_code())
        }
    }
}

async fn join(options: &JoinOptions) -> Result<(), AttachError> {
    let enrollment = attach::join(options, &config::root(), &handlers::SUPPORTED).await?;
    let path = config::root().join("machine-client/client.json");
    eprint!("{}", enrollment.notice());
    println!("{}", enrollment.receipt);
    println!("config: {}", path.display());
    let state = service::install(options, &config::home(), &path).map_err(|error| {
        AttachError::Io(std::io::Error::other(format!(
            "service install failed ({error}); rerun with --no-service to skip, or fix the service manager"
        )))
    })?;
    println!("service: {} ({})", state.name, state.state);
    println!("offered capabilities: {}", handlers::SUPPORTED.join(", "));
    println!(
        "{}",
        service::screen(options.no_open, &std::env::current_exe()?)?
    );
    Ok(())
}
