pub mod adapters;
pub mod context;
pub mod render;
pub mod shell;

use std::io::IsTerminal;
use std::path::PathBuf;

use clap::Subcommand;

use super::doctor::OutputFormat;

/// Shared flags for all protocol subcommands.
#[derive(Debug, clap::Args)]
pub struct ProtocolArgs {
    /// Agent name (default: $BOTBUS_AGENT or config defaultAgent)
    #[arg(long)]
    pub agent: Option<String>,
    /// Project name (default: from .botbox.json)
    #[arg(long)]
    pub project: Option<String>,
    /// Project root directory
    #[arg(long)]
    pub project_root: Option<PathBuf>,
    /// Output format
    #[arg(long, value_enum)]
    pub format: Option<OutputFormat>,
}

impl ProtocolArgs {
    /// Resolve the effective agent name from flag, env, or config.
    pub fn resolve_agent(&self, config: &crate::config::Config) -> String {
        if let Some(ref agent) = self.agent {
            return agent.clone();
        }
        if let Ok(agent) = std::env::var("BOTBUS_AGENT") {
            return agent;
        }
        config.default_agent()
    }

    /// Resolve the effective project name from flag or config.
    pub fn resolve_project(&self, config: &crate::config::Config) -> String {
        if let Some(ref project) = self.project {
            return project.clone();
        }
        config.project.name.clone()
    }

    /// Resolve the effective output format from flag or TTY detection.
    pub fn resolve_format(&self) -> OutputFormat {
        self.format.unwrap_or_else(|| {
            if std::io::stdout().is_terminal() {
                OutputFormat::Pretty
            } else {
                OutputFormat::Text
            }
        })
    }
}

#[derive(Debug, Subcommand)]
pub enum ProtocolCommand {
    /// Check state and output commands to start working on a bead
    Start {
        /// Bead ID to start working on
        bead_id: String,
        /// Omit bus send announcement (for dispatched workers)
        #[arg(long)]
        dispatched: bool,
        #[command(flatten)]
        args: ProtocolArgs,
    },
    /// Check state and output commands to finish a bead
    Finish {
        /// Bead ID to finish
        bead_id: String,
        /// Omit maw ws merge step (for dispatched workers whose lead handles merge)
        #[arg(long)]
        no_merge: bool,
        /// Output finish commands even without review approval
        #[arg(long)]
        force: bool,
        #[command(flatten)]
        args: ProtocolArgs,
    },
    /// Check state and output commands to request review
    Review {
        /// Bead ID to review
        bead_id: String,
        /// Override reviewer list (comma-separated)
        #[arg(long)]
        reviewers: Option<String>,
        /// Reference an existing review ID (skip creation)
        #[arg(long)]
        review_id: Option<String>,
        #[command(flatten)]
        args: ProtocolArgs,
    },
    /// Check for held resources and output cleanup commands
    Cleanup {
        #[command(flatten)]
        args: ProtocolArgs,
    },
    /// Check for in-progress work from a previous session
    Resume {
        #[command(flatten)]
        args: ProtocolArgs,
    },
}

impl ProtocolCommand {
    pub fn execute(&self) -> anyhow::Result<()> {
        match self {
            ProtocolCommand::Start { bead_id, dispatched, args } => {
                let _ = (bead_id, dispatched, args);
                eprintln!("botbox protocol start: not yet implemented");
                Ok(())
            }
            ProtocolCommand::Finish { bead_id, no_merge, force, args } => {
                let _ = (bead_id, no_merge, force, args);
                eprintln!("botbox protocol finish: not yet implemented");
                Ok(())
            }
            ProtocolCommand::Review { bead_id, reviewers, review_id, args } => {
                let _ = (bead_id, reviewers, review_id, args);
                eprintln!("botbox protocol review: not yet implemented");
                Ok(())
            }
            ProtocolCommand::Cleanup { args } => {
                let _ = args;
                eprintln!("botbox protocol cleanup: not yet implemented");
                Ok(())
            }
            ProtocolCommand::Resume { args } => {
                let _ = args;
                eprintln!("botbox protocol resume: not yet implemented");
                Ok(())
            }
        }
    }
}
