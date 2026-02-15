use std::io::IsTerminal;
use std::path::PathBuf;

use clap::Args;
use serde::{Serialize, Deserialize};

use crate::subprocess::Tool;
use super::doctor::OutputFormat;

#[derive(Debug, Args)]
pub struct StatusArgs {
    /// Project root directory
    #[arg(long)]
    pub project_root: Option<PathBuf>,
    /// Output format
    #[arg(long, value_enum)]
    pub format: Option<OutputFormat>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StatusReport {
    pub ready_beads: ReadyBeads,
    pub workspaces: WorkspaceSummary,
    pub inbox: InboxSummary,
    pub agents: AgentsSummary,
    pub claims: ClaimsSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advice: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadyBeads {
    pub count: usize,
    pub items: Vec<BeadSummary>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BeadSummary {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub total: usize,
    pub active: usize,
    pub stale: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InboxSummary {
    pub unread: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AgentsSummary {
    pub running: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClaimsSummary {
    pub active: usize,
}

impl StatusArgs {
    pub fn execute(&self) -> anyhow::Result<()> {
        let format = self.format.unwrap_or_else(|| {
            if std::io::stdout().is_terminal() {
                OutputFormat::Pretty
            } else {
                OutputFormat::Text
            }
        });

        let mut report = StatusReport {
            ready_beads: ReadyBeads {
                count: 0,
                items: vec![],
            },
            workspaces: WorkspaceSummary {
                total: 0,
                active: 0,
                stale: 0,
            },
            inbox: InboxSummary {
                unread: 0,
            },
            agents: AgentsSummary {
                running: 0,
            },
            claims: ClaimsSummary {
                active: 0,
            },
            advice: None,
        };

        // 1. Ready beads
        if let Ok(output) = Tool::new("br")
            .arg("ready")
            .arg("--format")
            .arg("json")
            .run()
            && let Ok(beads_json) = serde_json::from_str::<serde_json::Value>(&output.stdout)
                && let Some(items) = beads_json.get("items").and_then(|v| v.as_array()) {
                    report.ready_beads.count = items.len();
                    for item in items.iter().take(5) {
                        if let (Some(id), Some(title)) = (
                            item.get("id").and_then(|v| v.as_str()),
                            item.get("title").and_then(|v| v.as_str()),
                        ) {
                            report.ready_beads.items.push(BeadSummary {
                                id: id.to_string(),
                                title: title.to_string(),
                            });
                        }
                    }
                }

        // 2. Active workspaces
        if let Ok(output) = Tool::new("maw")
            .arg("ws")
            .arg("list")
            .arg("--format")
            .arg("json")
            .run()
            && let Ok(ws_json) = serde_json::from_str::<serde_json::Value>(&output.stdout) {
                if let Some(workspaces) = ws_json.get("workspaces").and_then(|v| v.as_array()) {
                    report.workspaces.total = workspaces.len();
                    for ws in workspaces {
                        if ws.get("is_default").and_then(|v| v.as_bool()).unwrap_or(false) {
                            continue;
                        }
                        report.workspaces.active += 1;
                    }
                }
                if let Some(advice) = ws_json.get("advice").and_then(|v| v.as_array()) {
                    report.workspaces.stale = advice
                        .iter()
                        .filter(|a| {
                            a.get("message")
                                .and_then(|v| v.as_str())
                                .map(|s| s.contains("stale"))
                                .unwrap_or(false)
                        })
                        .count();
                }
            }

        // 3. Pending inbox
        if let Ok(output) = Tool::new("bus")
            .arg("inbox")
            .arg("--format")
            .arg("json")
            .run()
            && let Ok(inbox_json) = serde_json::from_str::<serde_json::Value>(&output.stdout)
                && let Some(messages) = inbox_json.get("messages").and_then(|v| v.as_array()) {
                    report.inbox.unread = messages.len();
                }

        // 4. Running agents
        if let Ok(output) = Tool::new("botty")
            .arg("list")
            .arg("--format")
            .arg("json")
            .run()
            && let Ok(agents_json) = serde_json::from_str::<serde_json::Value>(&output.stdout)
                && let Some(agents) = agents_json.get("agents").and_then(|v| v.as_array()) {
                    report.agents.running = agents.len();
                }

        // 5. Active claims
        if let Ok(output) = Tool::new("bus")
            .arg("claims")
            .arg("list")
            .arg("--format")
            .arg("json")
            .run()
            && let Ok(claims_json) = serde_json::from_str::<serde_json::Value>(&output.stdout)
                && let Some(claims) = claims_json.get("claims").and_then(|v| v.as_array()) {
                    report.claims.active = claims.len();
                }

        match format {
            OutputFormat::Pretty => {
                self.print_pretty(&report);
            }
            OutputFormat::Text => {
                self.print_text(&report);
            }
            OutputFormat::Json => {
                println!("{}", serde_json::to_string_pretty(&report)?);
            }
        }

        Ok(())
    }

    fn print_pretty(&self, report: &StatusReport) {
        println!("=== Botbox Status ===\n");

        println!("Ready Beads: {}", report.ready_beads.count);
        for bead in report.ready_beads.items.iter().take(5) {
            println!("  • {} — {}", bead.id, bead.title);
        }
        if report.ready_beads.count > 5 {
            println!("  ... and {} more", report.ready_beads.count - 5);
        }

        println!("\nWorkspaces:");
        println!("  Total: {}  (Active: {}, Stale: {})",
            report.workspaces.total,
            report.workspaces.active,
            report.workspaces.stale);

        println!("\nInbox: {} unread", report.inbox.unread);
        println!("Running Agents: {}", report.agents.running);
        println!("Active Claims: {}", report.claims.active);
    }

    fn print_text(&self, report: &StatusReport) {
        println!("botbox-status");
        println!("ready-beads  count={}", report.ready_beads.count);
        for bead in report.ready_beads.items.iter().take(5) {
            println!("ready-bead  id={}  title={}", bead.id, bead.title);
        }
        println!("workspaces  total={}  active={}  stale={}",
            report.workspaces.total,
            report.workspaces.active,
            report.workspaces.stale);
        println!("inbox  unread={}", report.inbox.unread);
        println!("agents  running={}", report.agents.running);
        println!("claims  active={}", report.claims.active);
    }
}
