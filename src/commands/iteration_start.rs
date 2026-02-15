use std::fs;

use serde::Deserialize;

use crate::config::Config;
use crate::subprocess::Tool;

// ===== Data Structures =====

#[derive(Debug, Deserialize)]
pub struct InboxResponse {
    pub total_unread: i32,
    pub channels: Option<Vec<InboxChannel>>,
}

#[derive(Debug, Deserialize)]
pub struct InboxChannel {
    pub messages: Option<Vec<InboxMessage>>,
}

#[derive(Debug, Deserialize)]
pub struct InboxMessage {
    pub agent: String,
    pub label: Option<String>,
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct Bead {
    pub id: String,
    pub title: String,
    pub priority: i32,
    pub owner: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReviewsResponse {
    pub reviews_awaiting_vote: Option<Vec<ReviewInfo>>,
    pub threads_with_new_responses: Option<Vec<ThreadInfo>>,
}

#[derive(Debug, Deserialize)]
pub struct ReviewInfo {
    pub review_id: String,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ThreadInfo {
    pub thread_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ClaimsResponse {
    pub claims: Option<Vec<Claim>>,
}

#[derive(Debug, Deserialize)]
pub struct Claim {
    pub patterns: Option<Vec<String>>,
    pub expires_in_secs: Option<i32>,
}

// ANSI color codes
pub struct Colors;

impl Colors {
    pub const RESET: &'static str = "\x1b[0m";
    pub const BOLD: &'static str = "\x1b[1m";
    pub const DIM: &'static str = "\x1b[2m";
    pub const CYAN: &'static str = "\x1b[36m";
    pub const GREEN: &'static str = "\x1b[32m";
    pub const RED: &'static str = "\x1b[31m";
}

pub fn h1(s: &str) -> String {
    format!("{}{}● {}{}",
        Colors::BOLD,
        Colors::CYAN,
        s,
        Colors::RESET)
}

pub fn h2(s: &str) -> String {
    format!("{}{}▸ {}{}",
        Colors::BOLD,
        Colors::GREEN,
        s,
        Colors::RESET)
}

pub fn hint(s: &str) -> String {
    format!("{}→ {}{}",
        Colors::DIM,
        s,
        Colors::RESET)
}

/// Fetch config from .botbox.json or ws/default/.botbox.json
fn load_config() -> anyhow::Result<Config> {
    let paths = vec![".botbox.json", "ws/default/.botbox.json"];

    for path in paths {
        if fs::metadata(path).is_ok() {
            return Config::load(std::path::Path::new(path));
        }
    }

    anyhow::bail!("Could not find .botbox.json in current directory or ws/default/");
}

/// Helper to run a tool and parse JSON output, returning None on failure
fn run_json_tool(tool: &str, args: &[&str]) -> Option<String> {
    if tool == "br" || tool == "bv" || tool == "crit" {
        // These need to be run in the default workspace
        let mut output = Tool::new(tool);
        for arg in args {
            output = output.arg(arg);
        }
        output = output.arg("--format").arg("json");

        let result = if tool == "br" || tool == "bv" {
            output.in_workspace("default").ok()?.run().ok()?
        } else {
            // For crit (which may need special handling), still use default
            output.in_workspace("default").ok()?.run().ok()?
        };

        if result.success() {
            Some(result.stdout)
        } else {
            None
        }
    } else {
        // Direct tool execution
        let mut output = Tool::new(tool);
        for arg in args {
            output = output.arg(arg);
        }
        output = output.arg("--format").arg("json");

        let result = output.run().ok()?;
        if result.success() {
            Some(result.stdout)
        } else {
            None
        }
    }
}

/// Run iteration-start with optional overrides
pub fn run_iteration_start(agent_override: Option<&str>) -> anyhow::Result<()> {
    let config = load_config()?;
    let default_agent = config.default_agent();
    let agent = agent_override.unwrap_or(default_agent.as_str());
    let project = config.channel();

    println!("{}", h1(&format!("Iteration Start: {}", agent)));
    println!();

    // 1. Inbox messages
    println!("{}", h2("Inbox"));
    let inbox_output = run_json_tool("bus", &["inbox", "--agent", agent, "--channels", &project]);

    if let Some(output) = inbox_output {
        if let Ok(inbox) = serde_json::from_str::<InboxResponse>(&output) {
            if inbox.total_unread > 0 {
                println!("   {} unread message(s)", inbox.total_unread);
                if let Some(channels) = inbox.channels {
                    for channel in channels {
                        if let Some(messages) = channel.messages {
                            for msg in messages.iter().take(5) {
                                let label = msg.label
                                    .as_ref()
                                    .map(|l| format!("[{}]", l))
                                    .unwrap_or_default();
                                let body = if msg.body.len() > 60 {
                                    format!("{}...", &msg.body[..60])
                                } else {
                                    msg.body.clone()
                                };
                                println!("   {}{}{} {}: {}",
                                    Colors::DIM,
                                    msg.agent,
                                    Colors::RESET,
                                    label,
                                    body);
                            }
                        }
                    }
                }
            } else {
                println!("   {}No unread messages{}", Colors::DIM, Colors::RESET);
            }
        } else {
            println!("   {}No unread messages{}", Colors::DIM, Colors::RESET);
        }
    } else {
        println!("   {}No unread messages{}", Colors::DIM, Colors::RESET);
    }
    println!();

    // 2. Ready beads
    println!("{}", h2("Ready Beads"));
    let beads_output = run_json_tool("br", &["ready"]);
    let mut has_beads = false;
    let mut first_bead_id = String::new();

    if let Some(output) = beads_output {
        if let Ok(beads) = serde_json::from_str::<Vec<Bead>>(&output) {
            if !beads.is_empty() {
                has_beads = true;
                if let Some(first) = beads.first() {
                    first_bead_id = first.id.clone();
                }
                println!("   {} bead(s) ready", beads.len());
                for bead in beads.iter().take(5) {
                    let priority = format!("P{}", bead.priority);
                    let owner = bead.owner
                        .as_ref()
                        .map(|o| format!("({})", o))
                        .unwrap_or_default();
                    println!("   {} {} {}: {}",
                        bead.id,
                        priority,
                        owner,
                        bead.title);
                }
                if beads.len() > 5 {
                    println!("   {}... and {} more{}", Colors::DIM, beads.len() - 5, Colors::RESET);
                }
            } else {
                println!("   {}No ready beads{}", Colors::DIM, Colors::RESET);
            }
        } else {
            println!("   {}No ready beads{}", Colors::DIM, Colors::RESET);
        }
    } else {
        println!("   {}No ready beads{}", Colors::DIM, Colors::RESET);
    }
    println!();

    // 3. Pending reviews
    println!("{}", h2("Pending Reviews"));
    let reviews_output = run_json_tool("crit", &["inbox", "--agent", agent]);
    let mut has_reviews = false;

    if let Some(output) = reviews_output {
        if let Ok(reviews) = serde_json::from_str::<ReviewsResponse>(&output) {
            let awaiting = reviews.reviews_awaiting_vote.unwrap_or_default();
            let threads = reviews.threads_with_new_responses.unwrap_or_default();

            if !awaiting.is_empty() || !threads.is_empty() {
                has_reviews = true;
                if !awaiting.is_empty() {
                    println!("   {} review(s) awaiting vote", awaiting.len());
                    for r in awaiting.iter().take(3) {
                        let no_title = "(no title)".to_string();
                        let title = r.title
                            .as_ref()
                            .or(r.description.as_ref())
                            .unwrap_or(&no_title);
                        println!("   {}: {}", r.review_id, title);
                    }
                }
                if !threads.is_empty() {
                    println!("   {} thread(s) with new responses", threads.len());
                }
            } else {
                println!("   {}No pending reviews{}", Colors::DIM, Colors::RESET);
            }
        } else {
            println!("   {}No pending reviews{}", Colors::DIM, Colors::RESET);
        }
    } else {
        println!("   {}Could not fetch reviews{}", Colors::DIM, Colors::RESET);
    }
    println!();

    // 4. Active claims
    println!("{}", h2("Active Claims"));
    let claims_output = run_json_tool("bus", &["claims", "list", "--agent", agent, "--mine"]);

    if let Some(output) = claims_output {
        if let Ok(claims_data) = serde_json::from_str::<ClaimsResponse>(&output) {
            if let Some(claims) = claims_data.claims {
                // Filter out agent identity claims (those that start with "agent://")
                let resource_claims: Vec<_> = claims.iter()
                    .filter(|c| {
                        c.patterns.as_ref()
                            .map(|p| !p.iter().all(|pat| pat.starts_with("agent://")))
                            .unwrap_or(true)
                    })
                    .collect();

                if !resource_claims.is_empty() {
                    println!("   {} active claim(s)", resource_claims.len());
                    for claim in resource_claims.iter().take(5) {
                        if let Some(patterns) = &claim.patterns {
                            let resource_patterns: Vec<_> = patterns.iter()
                                .filter(|p| !p.starts_with("agent://"))
                                .collect();
                            for pattern in resource_patterns {
                                let expires = claim.expires_in_secs
                                    .map(|s| format!("({}m left)", s / 60))
                                    .unwrap_or_default();
                                println!("   {} {}", pattern, expires);
                            }
                        }
                    }
                } else {
                    println!("   {}No resource claims{}", Colors::DIM, Colors::RESET);
                }
            } else {
                println!("   {}No active claims{}", Colors::DIM, Colors::RESET);
            }
        } else {
            println!("   {}No active claims{}", Colors::DIM, Colors::RESET);
        }
    } else {
        println!("   {}No active claims{}", Colors::DIM, Colors::RESET);
    }
    println!();

    // Summary hint
    if let Some(output) = run_json_tool("bus", &["inbox", "--agent", agent, "--channels", &project]) {
        if let Ok(inbox) = serde_json::from_str::<InboxResponse>(&output) {
            if inbox.total_unread > 0 {
                println!("{}", hint(&format!("Process inbox: bus inbox --agent {} --channels {} --mark-read", agent, project)));
            } else if has_reviews {
                println!("{}", hint(&format!("Start review: maw exec default -- crit inbox --agent {}", agent)));
            } else if has_beads && !first_bead_id.is_empty() {
                println!("{}", hint(&format!("Claim top: maw exec default -- br update --actor {} {} --status in_progress", agent, first_bead_id)));
            } else {
                println!("{}", hint("No work pending"));
            }
        }
    }

    Ok(())
}
