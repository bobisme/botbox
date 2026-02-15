mod commands;
mod config;
mod error;
mod hooks;
mod subprocess;
mod template;

use std::process::ExitCode;

use clap::{Parser, Subcommand};

use commands::doctor::DoctorArgs;
use commands::hooks::HooksCommand;
use commands::init::InitArgs;
use commands::protocol::ProtocolCommand;
use commands::run::RunCommand;
use commands::status::StatusArgs;
use commands::sync::SyncArgs;

#[derive(Debug, Parser)]
#[command(name = "botbox", version, about = "Setup and sync tool for multi-agent workflows")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Run agent loops (dev, worker, reviewer, responder, triage, iteration-start)
    Run {
        #[command(subcommand)]
        command: RunCommand,
    },
    /// Sync docs, scripts, hooks, and config to a project
    Sync(SyncArgs),
    /// Initialize a new botbox project
    Init(InitArgs),
    /// Validate project config and companion tools
    Doctor(DoctorArgs),
    /// Show project status
    Status(StatusArgs),
    /// Manage hooks (install, audit)
    Hooks {
        #[command(subcommand)]
        command: HooksCommand,
    },
    /// Check protocol state and output guidance commands
    Protocol {
        #[command(subcommand)]
        command: ProtocolCommand,
    },
    /// Run triage (bead scoring and recommendations)
    Triage,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Run { command } => command.execute(),
        Commands::Sync(args) => args.execute(),
        Commands::Init(args) => args.execute(),
        Commands::Doctor(args) => args.execute(),
        Commands::Status(args) => args.execute(),
        Commands::Hooks { command } => command.execute(),
        Commands::Protocol { command } => command.execute(),
        Commands::Triage => commands::triage::run_triage(),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            if let Some(exit_err) = e.downcast_ref::<error::ExitError>() {
                eprintln!("error: {exit_err}");
                exit_err.exit_code()
            } else {
                eprintln!("error: {e:#}");
                ExitCode::FAILURE
            }
        }
    }
}
