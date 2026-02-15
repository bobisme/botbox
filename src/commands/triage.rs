use std::collections::HashSet;
use std::io::IsTerminal;

use serde::Deserialize;

use crate::subprocess::Tool;

/// Triage output structure from bv --robot-triage
#[derive(Debug, Deserialize)]
pub struct TriageResponse {
    pub triage: Triage,
}

#[derive(Debug, Deserialize)]
pub struct Triage {
    pub quick_ref: QuickRef,
    pub blockers_to_clear: Vec<BeadInfo>,
    pub quick_wins: Vec<BeadInfo>,
    pub recommendations: Vec<Recommendation>,
    pub project_health: Option<ProjectHealth>,
}

#[derive(Debug, Deserialize)]
pub struct QuickRef {
    pub open_count: i32,
    pub actionable_count: i32,
    pub blocked_count: i32,
    pub in_progress_count: i32,
    pub top_picks: Vec<Pick>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Pick {
    pub id: String,
    pub title: String,
    pub score: f64,
    pub unblocks: i32,
}

#[derive(Debug, Deserialize, Clone)]
pub struct BeadInfo {
    pub id: String,
    pub title: String,
    pub blocks_count: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct Recommendation {
    pub id: String,
    pub title: String,
    pub priority: i32,
    pub status: Option<String>,
    pub labels: Option<Vec<String>>,
    pub reasons: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct ProjectHealth {
    pub counts: HealthCounts,
    pub velocity: Option<Velocity>,
}

#[derive(Debug, Deserialize)]
pub struct HealthCounts {
    pub total: i32,
    pub closed: i32,
    pub open: i32,
}

#[derive(Debug, Deserialize)]
pub struct Velocity {
    pub closed_last_7_days: i32,
    pub avg_days_to_close: f64,
}

// ANSI color codes — conditionally applied based on TTY detection
struct Colors {
    use_color: bool,
}

impl Colors {
    fn new(use_color: bool) -> Self {
        Self { use_color }
    }

    fn reset(&self) -> &'static str {
        if self.use_color { "\x1b[0m" } else { "" }
    }

    fn bold(&self) -> &'static str {
        if self.use_color { "\x1b[1m" } else { "" }
    }

    fn dim(&self) -> &'static str {
        if self.use_color { "\x1b[2m" } else { "" }
    }

    fn cyan(&self) -> &'static str {
        if self.use_color { "\x1b[36m" } else { "" }
    }

    fn green(&self) -> &'static str {
        if self.use_color { "\x1b[32m" } else { "" }
    }

    fn yellow(&self) -> &'static str {
        if self.use_color { "\x1b[33m" } else { "" }
    }
}

fn h1(s: &str, c: &Colors) -> String {
    format!("{}{}# {}{}",
        c.bold(),
        c.cyan(),
        s,
        c.reset())
}

fn h2(s: &str, c: &Colors) -> String {
    format!("{}{}## {}{}",
        c.bold(),
        c.green(),
        s,
        c.reset())
}

fn warn(s: &str, c: &Colors) -> String {
    format!("{}{}! {}{}",
        c.bold(),
        c.yellow(),
        s,
        c.reset())
}

fn hint(s: &str, c: &Colors) -> String {
    format!("{}> {}{}",
        c.dim(),
        s,
        c.reset())
}

/// Get the agent name from BOTBUS_AGENT env var, falling back to "$AGENT"
fn agent_name() -> String {
    std::env::var("BOTBUS_AGENT").unwrap_or_else(|_| "$AGENT".to_string())
}

/// Run triage: wraps `maw exec default -- bv --robot-triage` and formats output
pub fn run_triage() -> anyhow::Result<()> {
    let use_color = std::io::stdout().is_terminal();
    let c = Colors::new(use_color);

    // Run bv --robot-triage in the default workspace
    let output = Tool::new("bv")
        .arg("--robot-triage")
        .in_workspace("default")?
        .run()?;

    if !output.success() {
        eprintln!("Error running bv --robot-triage: {}", output.stderr);
        anyhow::bail!("bv --robot-triage failed");
    }

    let data: TriageResponse = output.parse_json()?;
    let triage = data.triage;

    // Build set of deferred bead IDs from recommendations
    let deferred_ids: HashSet<&str> = triage.recommendations.iter()
        .filter(|r| r.status.as_deref() == Some("deferred"))
        .map(|r| r.id.as_str())
        .collect();

    // Extract quick ref
    let qr = &triage.quick_ref;
    println!("{}", h1("Triage Summary", &c));
    println!("   Open: {} | Actionable: {} | Blocked: {} | In Progress: {}",
        qr.open_count,
        qr.actionable_count,
        qr.blocked_count,
        qr.in_progress_count);
    println!();

    // Top picks (exclude deferred)
    let top_picks: Vec<_> = qr.top_picks.iter()
        .filter(|p| !deferred_ids.contains(p.id.as_str()))
        .collect();
    if !top_picks.is_empty() {
        println!("{}", h2("Top Picks", &c));
        for pick in top_picks.iter().take(5) {
            let score = (pick.score * 100.0).round() as i32;
            let unblocks = if pick.unblocks > 0 {
                format!(" (unblocks {})", pick.unblocks)
            } else {
                String::new()
            };
            println!("   {}: {}", pick.id, pick.title);
            println!("      Score: {}%{}", score, unblocks);
        }
        println!();
    }

    // Blockers to clear (exclude deferred)
    let blockers: Vec<_> = triage.blockers_to_clear.iter()
        .filter(|b| !deferred_ids.contains(b.id.as_str()))
        .collect();
    if !blockers.is_empty() {
        println!("{}", warn("Blockers to Clear", &c));
        for blocker in blockers.iter().take(5) {
            let blocks = blocker.blocks_count.unwrap_or(0);
            println!("   {}: {} (blocks {})", blocker.id, blocker.title, blocks);
        }
        println!();
    }

    // Quick wins (exclude deferred)
    let quick_wins: Vec<_> = triage.quick_wins.iter()
        .filter(|w| !deferred_ids.contains(w.id.as_str()))
        .collect();
    if !quick_wins.is_empty() {
        println!("{}", h2("Quick Wins", &c));
        for win in quick_wins.iter().take(3) {
            println!("   {}: {}", win.id, win.title);
        }
        println!();
    }

    // Recommendations (exclude deferred)
    let recs: Vec<_> = triage.recommendations.iter()
        .filter(|r| r.status.as_deref() != Some("deferred"))
        .collect();
    if !recs.is_empty() {
        println!("{}", h2("Recommendations", &c));
        for rec in recs.iter().take(6) {
            let labels = rec.labels
                .as_ref()
                .map(|l| format!(" [{}]", l.join(", ")))
                .unwrap_or_default();
            let priority = format!("P{}", rec.priority);
            println!("   {} ({}{}): {}", rec.id, priority, labels, rec.title);
            if let Some(reasons) = &rec.reasons
                && !reasons.is_empty() {
                    println!("      - {}", reasons[0]);
                }
        }
        println!();
    }

    // Health summary
    if let Some(health) = &triage.project_health {
        println!("{}", h2("Project Health", &c));
        println!("   Total: {} | Closed: {} | Open: {}",
            health.counts.total,
            health.counts.closed,
            health.counts.open);
        if let Some(vel) = &health.velocity {
            println!("   Velocity: {} closed/week | Avg {:.1} days to close",
                vel.closed_last_7_days,
                vel.avg_days_to_close);
        }
    }

    // Command hint
    let agent = agent_name();
    println!();
    if let Some(first_pick) = top_picks.first() {
        println!("{}", hint(&format!("Claim top: br update --actor {} {} --status in_progress", agent, first_pick.id), &c));
    }

    Ok(())
}
