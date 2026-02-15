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

// ANSI color codes
pub struct Colors;

impl Colors {
    pub const RESET: &'static str = "\x1b[0m";
    pub const BOLD: &'static str = "\x1b[1m";
    pub const DIM: &'static str = "\x1b[2m";
    pub const CYAN: &'static str = "\x1b[36m";
    pub const GREEN: &'static str = "\x1b[32m";
    pub const YELLOW: &'static str = "\x1b[33m";
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

pub fn warn(s: &str) -> String {
    format!("{}{}▲ {}{}",
        Colors::BOLD,
        Colors::YELLOW,
        s,
        Colors::RESET)
}

pub fn hint(s: &str) -> String {
    format!("{}→ {}{}",
        Colors::DIM,
        s,
        Colors::RESET)
}

/// Run triage: wraps `maw exec default -- bv --robot-triage` and formats output
pub fn run_triage() -> anyhow::Result<()> {
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

    // Extract quick ref
    let qr = &triage.quick_ref;
    println!("{}", h1("Triage Summary"));
    println!("   Open: {} | Actionable: {} | Blocked: {} | In Progress: {}",
        qr.open_count,
        qr.actionable_count,
        qr.blocked_count,
        qr.in_progress_count);
    println!();

    // Top picks
    if !qr.top_picks.is_empty() {
        println!("{}", h2("Top Picks"));
        for pick in qr.top_picks.iter().take(5) {
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

    // Blockers to clear
    if !triage.blockers_to_clear.is_empty() {
        println!("{}", warn("Blockers to Clear"));
        for blocker in triage.blockers_to_clear.iter().take(5) {
            let blocks = blocker.blocks_count.unwrap_or(0);
            println!("   {}: {} (blocks {})", blocker.id, blocker.title, blocks);
        }
        println!();
    }

    // Quick wins
    if !triage.quick_wins.is_empty() {
        println!("{}", h2("Quick Wins"));
        for win in triage.quick_wins.iter().take(3) {
            println!("   {}: {}", win.id, win.title);
        }
        println!();
    }

    // Recommendations
    if !triage.recommendations.is_empty() {
        println!("{}", h2("Recommendations"));
        for rec in triage.recommendations.iter().take(6) {
            let labels = rec.labels
                .as_ref()
                .map(|l| format!(" [{}]", l.join(", ")))
                .unwrap_or_default();
            let priority = format!("P{}", rec.priority);
            println!("   {} ({}{}): {}", rec.id, priority, labels, rec.title);
            if let Some(reasons) = &rec.reasons {
                if !reasons.is_empty() {
                    println!("      → {}", reasons[0]);
                }
            }
        }
        println!();
    }

    // Health summary
    if let Some(health) = &triage.project_health {
        println!("{}", h2("Project Health"));
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
    println!();
    if let Some(first_pick) = qr.top_picks.first() {
        println!("{}", hint(&format!("Claim top: br update --actor $AGENT {} --status in_progress", first_pick.id)));
    }

    Ok(())
}
