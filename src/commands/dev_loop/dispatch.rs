//! Worker dispatch helpers.
//!
//! The actual dispatch logic is prompt-driven (Claude decides what to dispatch).
//! These helpers support the dispatch infrastructure: workspace creation,
//! worker naming, claim staking, and botty spawn.

use crate::subprocess::Tool;

/// Create a random workspace and return its name.
pub fn create_workspace() -> anyhow::Result<String> {
    let output = Tool::new("maw")
        .args(&["ws", "create", "--random"])
        .run_ok()?;
    // Output typically includes "Created workspace: <name>" or just the name
    let name = output
        .stdout
        .lines()
        .find_map(|line| {
            // Try to extract workspace name from various output formats
            if line.contains("Created workspace:") {
                line.split(':').next_back().map(|s| s.trim().to_string())
            } else if !line.is_empty() && line.chars().all(|c| c.is_alphanumeric() || c == '-') {
                Some(line.trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| output.stdout.trim().to_string());
    Ok(name)
}

/// Generate a random worker name suffix.
pub fn generate_worker_name() -> anyhow::Result<String> {
    let output = Tool::new("bus")
        .arg("generate-name")
        .run_ok()?;
    Ok(output.stdout.trim().to_string())
}

/// Stake a bead claim.
pub fn claim_bead(agent: &str, project: &str, bead_id: &str, memo: &str) -> anyhow::Result<()> {
    Tool::new("bus")
        .args(&[
            "claims", "stake", "--agent", agent,
            &format!("bead://{project}/{bead_id}"),
            "-m", memo,
        ])
        .run_ok()?;
    Ok(())
}

/// Stake a workspace claim.
pub fn claim_workspace(agent: &str, project: &str, ws: &str, memo: &str) -> anyhow::Result<()> {
    Tool::new("bus")
        .args(&[
            "claims", "stake", "--agent", agent,
            &format!("workspace://{project}/{ws}"),
            "-m", memo,
        ])
        .run_ok()?;
    Ok(())
}

/// Timeout in seconds for a given model or tier name.
pub fn model_timeout(model: &str) -> u64 {
    match model {
        "strong" | "opus" => 900,
        "balanced" | "sonnet" => 600,
        "fast" | "haiku" => 300,
        _ => 600,
    }
}
