use std::path::PathBuf;

use clap::Args;

#[derive(Debug, Args)]
pub struct StatusArgs {
    /// Project root directory
    #[arg(long)]
    pub project_root: Option<PathBuf>,
    /// Output format
    #[arg(long, value_enum, default_value_t = super::doctor::OutputFormat::Pretty)]
    pub format: super::doctor::OutputFormat,
}

impl StatusArgs {
    pub fn execute(&self) -> anyhow::Result<()> {
        eprintln!("status: not yet implemented");
        Ok(())
    }
}
