use std::path::PathBuf;

use clap::Args;

#[derive(Debug, Args)]
pub struct InitArgs {
    /// Project name
    #[arg(long)]
    pub name: Option<String>,
    /// Project types (comma-separated)
    #[arg(long, value_delimiter = ',')]
    pub r#type: Vec<String>,
    /// Tools to enable (comma-separated)
    #[arg(long, value_delimiter = ',')]
    pub tools: Vec<String>,
    /// Non-interactive mode
    #[arg(long)]
    pub no_interactive: bool,
    /// Project root directory
    #[arg(long)]
    pub project_root: Option<PathBuf>,
}

impl InitArgs {
    pub fn execute(&self) -> anyhow::Result<()> {
        eprintln!("init: not yet implemented");
        Ok(())
    }
}
