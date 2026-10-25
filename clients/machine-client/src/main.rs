use std::{path::PathBuf, process::ExitCode};

use clap::{Parser, Subcommand};
use oni_machine_client::{
    attach::{self, AttachError},
    config::{self, JoinOptions},
    handlers,
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
    Join(JoinOptions),
    Run {
        #[arg(long)]
        config: Option<PathBuf>,
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
        Some(Command::Run { config }) => attach::run_default(config.as_deref()).await,
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
    eprint!("{}", enrollment.notice());
    println!("{}", enrollment.receipt);
    Ok(())
}
