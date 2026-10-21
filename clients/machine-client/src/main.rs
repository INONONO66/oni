//! `mclient`: the machine-side client that joins a machine to an oni host.
//! This phase only fixes the command surface; `join` and `run` are not
//! implemented yet.

use std::process::ExitCode;

use clap::{Parser, Subcommand};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser)]
#[command(name = "mclient", disable_version_flag = true)]
struct Cli {
    /// Print the client version and the machine contract version.
    #[arg(long)]
    version: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Enroll this machine with an oni host.
    Join {
        /// Host to join.
        host: String,
    },
    /// Serve the machine contract for an enrolled host.
    Run,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if cli.version {
        println!(
            "mclient {VERSION} contract {}",
            oni_protocol::CONTRACT_VERSION
        );
        return ExitCode::SUCCESS;
    }
    match cli.command {
        Some(Command::Join { .. } | Command::Run) => {
            eprintln!("not implemented in this phase");
            ExitCode::from(2)
        }
        None => {
            eprintln!("usage: mclient --version | join <host> | run");
            ExitCode::from(2)
        }
    }
}
