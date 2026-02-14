use std::path::PathBuf;

use clap::Args;

#[derive(Debug, Args)]
pub struct SyncArgs {
    /// Project root directory
    #[arg(long)]
    pub project_root: Option<PathBuf>,
    /// Check mode: exit non-zero if anything is stale, without making changes
    #[arg(long)]
    pub check: bool,
}

impl SyncArgs {
    pub fn execute(&self) -> anyhow::Result<()> {
        eprintln!("sync: not yet implemented");
        Ok(())
    }
}
