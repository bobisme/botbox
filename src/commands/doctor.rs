use std::path::PathBuf;

use anyhow::Context;
use clap::Args;

use crate::config::Config;
use crate::subprocess::Tool;

#[derive(Debug, Args)]
pub struct DoctorArgs {
    /// Project root directory
    #[arg(long)]
    pub project_root: Option<PathBuf>,
    /// Strict mode: also verify companion tool versions
    #[arg(long)]
    pub strict: bool,
    /// Output format
    #[arg(long, value_enum, default_value_t = OutputFormat::Pretty)]
    pub format: OutputFormat,
}

#[derive(Debug, Clone, clap::ValueEnum)]
pub enum OutputFormat {
    Pretty,
    Text,
    Json,
}

impl DoctorArgs {
    pub fn execute(&self) -> anyhow::Result<()> {
        let project_root = match self.project_root.clone() {
            Some(p) => p,
            None => std::env::current_dir()
                .context("could not determine current directory")?,
        };

        let config_path = project_root.join(".botbox.json");
        println!("Checking .botbox.json...");

        let config = Config::load(&config_path)?;
        println!("  project: {}", config.project.name);
        println!("  version: {}", config.version);
        println!("  agent:   {}", config.default_agent());
        println!("  channel: {}", config.channel());

        println!("\nTools:");
        print_tool_status("beads (br)", config.tools.beads, "br");
        print_tool_status("maw", config.tools.maw, "maw");
        print_tool_status("crit", config.tools.crit, "crit");
        print_tool_status("botbus (bus)", config.tools.botbus, "bus");
        print_tool_status("botty", config.tools.botty, "botty");

        if config.review.enabled {
            println!("\nReview: enabled");
            println!("  reviewers: {}", config.review.reviewers.join(", "));
        } else {
            println!("\nReview: disabled");
        }

        Ok(())
    }
}

fn print_tool_status(label: &str, enabled: bool, binary: &str) {
    if enabled {
        let version = Tool::new(binary)
            .arg("--version")
            .run()
            .map(|o| o.stdout.trim().to_string())
            .unwrap_or_else(|_| "NOT FOUND".into());
        println!("  {label}: {version}");
    } else {
        println!("  {label}: disabled");
    }
}
