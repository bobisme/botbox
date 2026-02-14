use std::path::PathBuf;

use clap::Subcommand;

#[derive(Debug, Subcommand)]
pub enum HooksCommand {
    /// Install/update botbus and Claude Code hooks
    Install {
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
    },
    /// Audit hook registrations and report issues
    Audit {
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
        /// Output format
        #[arg(long, value_enum, default_value_t = super::doctor::OutputFormat::Pretty)]
        format: super::doctor::OutputFormat,
    },
}

impl HooksCommand {
    pub fn execute(&self) -> anyhow::Result<()> {
        match self {
            HooksCommand::Install { .. } => {
                eprintln!("hooks install: not yet implemented");
                Ok(())
            }
            HooksCommand::Audit { .. } => {
                eprintln!("hooks audit: not yet implemented");
                Ok(())
            }
        }
    }
}
