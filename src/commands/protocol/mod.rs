pub mod adapters;
pub mod cleanup;
pub mod context;
pub mod render;
pub mod review_gate;
pub mod shell;

use std::io::IsTerminal;
use std::path::PathBuf;

use anyhow::Context;
use clap::Subcommand;

use super::doctor::OutputFormat;
use crate::config::Config;

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
                Self::execute_start(bead_id, *dispatched, args)
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
                let project_root = match args.project_root.clone() {
                    Some(p) => p,
                    None => std::env::current_dir()
                        .context("could not determine current directory")?,
                };

                // Try .botbox.json at root, then ws/default/ (maw v2 bare repo)
                let config = if project_root.join(".botbox.json").exists() {
                    crate::config::Config::load(&project_root.join(".botbox.json"))?
                } else {
                    let ws_default = project_root.join("ws/default");
                    crate::config::Config::load(&ws_default.join(".botbox.json"))?
                };

                let agent = args.resolve_agent(&config);
                let project = args.resolve_project(&config);
                let format = args.resolve_format();
                cleanup::execute(&agent, &project, format)
            }
            ProtocolCommand::Resume { args } => {
                let _ = args;
                eprintln!("botbox protocol resume: not yet implemented");
                Ok(())
            }
        }
    }

    /// Execute the `botbox protocol start <bead-id>` command.
    ///
    /// Analyzes bead status and outputs shell commands to start work.
    fn execute_start(bead_id: &str, dispatched: bool, args: &ProtocolArgs) -> anyhow::Result<()> {
        // Determine project root and load config
        let project_root = match args.project_root.clone() {
            Some(p) => p,
            None => std::env::current_dir().context("could not determine current directory")?,
        };

        let config = if project_root.join(".botbox.json").exists() {
            Config::load(&project_root.join(".botbox.json"))?
        } else if project_root.join("ws/default/.botbox.json").exists() {
            Config::load(&project_root.join("ws/default/.botbox.json"))?
        } else {
            anyhow::bail!(
                "No .botbox.json found in {} or {}/ws/default",
                project_root.display(),
                project_root.display()
            );
        };

        let project = args.resolve_project(&config);
        let agent = args.resolve_agent(&config);
        let format = args.resolve_format();

        // Collect state from bus and maw
        let ctx = context::ProtocolContext::collect(&project, &agent)?;

        // Check if bead exists and get its status
        let bead_info = match ctx.bead_status(bead_id) {
            Ok(bead) => bead,
            Err(_) => {
                let mut guidance = render::ProtocolGuidance::new("start");
                guidance.blocked(format!(
                    "bead {} not found. Check the ID with: maw exec default -- br show {}",
                    bead_id, bead_id
                ));
                let output = render::render(&guidance, format)
                    .map_err(|e| anyhow::anyhow!("render error: {}", e))?;
                println!("{}", output);
                return Ok(());
            }
        };

        let mut guidance = render::ProtocolGuidance::new("start");
        guidance.bead = Some(render::BeadRef {
            id: bead_id.to_string(),
            title: bead_info.title.clone(),
        });

        // Status check: is bead closed?
        if bead_info.status == "closed" {
            guidance.blocked("bead is already closed".to_string());
            let output = render::render(&guidance, format)
                .map_err(|e| anyhow::anyhow!("render error: {}", e))?;
            println!("{}", output);
            return Ok(());
        }

        // Check for claim conflicts
        match ctx.check_bead_claim_conflict(bead_id) {
            Ok(Some(other_agent)) => {
                guidance.blocked(format!(
                    "bead already claimed by agent '{}'",
                    other_agent
                ));
                guidance.diagnostic(format!(
                    "Check current claims with: bus claims list --format json"
                ));
                let output = render::render(&guidance, format)
                    .map_err(|e| anyhow::anyhow!("render error: {}", e))?;
                println!("{}", output);
                return Ok(());
            }
            Err(e) => {
                guidance.blocked(format!("failed to check claim conflict: {}", e));
                let output = render::render(&guidance, format)
                    .map_err(|e| anyhow::anyhow!("render error: {}", e))?;
                println!("{}", output);
                return Ok(());
            }
            Ok(None) => {
                // No conflict, proceed
            }
        }

        // Check if agent already holds a bead claim for this ID
        let held_workspace = ctx.workspace_for_bead(bead_id);

        if let Some(ws_name) = held_workspace {
            // RESUMABLE: agent already has this bead and workspace
            guidance.status = render::ProtocolStatus::Resumable;
            guidance.workspace = Some(ws_name.to_string());
            guidance.advise(format!(
                "Resume work in workspace {} with: botbox protocol resume",
                ws_name
            ));
            let output = render::render(&guidance, format)
                .map_err(|e| anyhow::anyhow!("render error: {}", e))?;
            println!("{}", output);
            return Ok(());
        }

        // READY: generate start commands
        guidance.status = render::ProtocolStatus::Ready;

        // Build command steps: claim, create workspace, announce
        let mut steps = Vec::new();

        // 1. Stake bead claim
        steps.push(format!(
            "bus claims stake --agent $AGENT \"bead://{}/{}\" -m \"{}\"",
            project, bead_id, bead_id
        ));

        // 2. Create workspace
        steps.push("maw ws create --random".to_string());

        // 3. Capture workspace name (comment for human)
        steps.push("# Capture workspace name from output above, then stake workspace claim:".to_string());

        // 4. Stake workspace claim (template with $WS placeholder)
        steps.push(format!(
            "bus claims stake --agent $AGENT \"workspace://{}/$WS\" -m \"{}\"",
            project, bead_id
        ));

        // 5. Update bead status
        steps.push(format!(
            "maw exec default -- br update --actor $AGENT {} --status=in_progress --owner=$AGENT",
            bead_id
        ));

        // 6. Comment bead with workspace info
        steps.push(format!(
            "maw exec default -- br comments add --actor $AGENT --author $AGENT {} \"Started in workspace $WS\"",
            bead_id
        ));

        // 7. Announce on bus (unless --dispatched)
        if !dispatched {
            steps.push(format!(
                "bus send --agent $AGENT {} \"Working on {}: {}\" -L task-claim",
                project, bead_id, shell::shell_escape(&bead_info.title)
            ));
        }

        guidance.steps(steps);
        guidance.advise(
            "Stake bead claim first, then create workspace, stake workspace claim, update bead status, and announce on bus.".to_string()
        );

        let output = render::render(&guidance, format)
            .map_err(|e| anyhow::anyhow!("render error: {}", e))?;
        println!("{}", output);

        Ok(())
    }
}
