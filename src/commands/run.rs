use std::path::PathBuf;

use clap::Subcommand;

#[derive(Debug, Subcommand)]
pub enum RunCommand {
    /// Run the dev-loop (lead agent)
    DevLoop {
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
        /// Agent name override
        #[arg(long)]
        agent: Option<String>,
        /// Model to use
        #[arg(long)]
        model: Option<String>,
    },
    /// Run the worker-loop (agent-loop)
    WorkerLoop {
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
        /// Agent name override
        #[arg(long)]
        agent: Option<String>,
        /// Model to use
        #[arg(long)]
        model: Option<String>,
    },
    /// Run the reviewer-loop
    ReviewerLoop {
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
        /// Agent name override
        #[arg(long)]
        agent: Option<String>,
        /// Model to use
        #[arg(long)]
        model: Option<String>,
    },
    /// Run the responder (message router)
    Responder {
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
        /// Agent name override
        #[arg(long)]
        agent: Option<String>,
        /// Model to use
        #[arg(long)]
        model: Option<String>,
    },
    /// Run triage (bead scoring and recommendations)
    Triage {
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
    },
    /// Run iteration-start (combined status snapshot)
    IterationStart {
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
        /// Agent name override
        #[arg(long)]
        agent: Option<String>,
    },
}

impl RunCommand {
    pub fn execute(&self) -> anyhow::Result<()> {
        match self {
            RunCommand::DevLoop { .. } => {
                eprintln!("dev-loop: not yet implemented");
                Ok(())
            }
            RunCommand::WorkerLoop { .. } => {
                eprintln!("worker-loop: not yet implemented");
                Ok(())
            }
            RunCommand::ReviewerLoop { .. } => {
                eprintln!("reviewer-loop: not yet implemented");
                Ok(())
            }
            RunCommand::Responder { .. } => {
                eprintln!("responder: not yet implemented");
                Ok(())
            }
            RunCommand::Triage { .. } => {
                eprintln!("triage: not yet implemented");
                Ok(())
            }
            RunCommand::IterationStart { .. } => {
                eprintln!("iteration-start: not yet implemented");
                Ok(())
            }
        }
    }
}
