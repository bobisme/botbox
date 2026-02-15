use std::path::PathBuf;

use clap::Subcommand;

#[derive(Debug, Subcommand)]
pub enum RunCommand {
    /// Run Claude Code with stream-JSON output parsing
    Agent {
        /// Agent type (currently only 'claude' is supported)
        agent_type: String,
        /// Prompt to send to Claude
        #[arg(short, long)]
        prompt: String,
        /// Model to use (sonnet, opus, haiku)
        #[arg(short, long)]
        model: Option<String>,
        /// Timeout in seconds
        #[arg(short, long, default_value = "600")]
        timeout: u64,
        /// Output format (pretty or text)
        #[arg(long)]
        format: Option<String>,
        /// Skip Claude Code permission checks (DANGEROUS: allows unrestricted file/command access)
        #[arg(long)]
        skip_permissions: bool,
    },
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
            RunCommand::Agent { agent_type, prompt, model, timeout, format, skip_permissions } => {
                crate::commands::run_agent::run_agent(agent_type, prompt, model.as_deref(), *timeout, format.as_deref(), *skip_permissions)
            }
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
                crate::commands::triage::run_triage()
            }
            RunCommand::IterationStart { agent, .. } => {
                crate::commands::iteration_start::run_iteration_start(agent.as_deref())
            }
        }
    }
}
