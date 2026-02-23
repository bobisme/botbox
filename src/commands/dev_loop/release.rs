//! Release check helpers.
//!
//! Scans commits since last tag for feat:/fix: prefixes to determine
//! if a release is needed. The actual version bumping and tagging is
//! prompt-driven.

use crate::subprocess::Tool;

/// Check if there are unreleased user-visible commits (feat: or fix:).
pub fn has_unreleased_changes() -> bool {
    let output = Tool::new("jj")
        .args(&[
            "log",
            "-r",
            "tags()..main",
            "--no-graph",
            "-T",
            "description.first_line() ++ \"\\n\"",
        ])
        .in_workspace("default")
        .ok()
        .and_then(|t| t.run().ok());

    match output {
        Some(o) if o.success() => o
            .stdout
            .lines()
            .any(|line| line.starts_with("feat:") || line.starts_with("fix:")),
        _ => false,
    }
}

/// Acquire the release mutex.
pub fn acquire_release_mutex(agent: &str, project: &str) -> anyhow::Result<()> {
    Tool::new("bus")
        .args(&[
            "claims",
            "stake",
            "--agent",
            agent,
            &format!("release://{project}"),
            "--ttl",
            "120",
            "-m",
            "checking release",
        ])
        .run_ok()?;
    Ok(())
}

/// Release the release mutex.
pub fn release_release_mutex(agent: &str, project: &str) {
    let _ = Tool::new("bus")
        .args(&[
            "claims",
            "release",
            "--agent",
            agent,
            &format!("release://{project}"),
        ])
        .run();
}
