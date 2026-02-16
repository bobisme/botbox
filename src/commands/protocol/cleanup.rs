//! Protocol cleanup command: check for held resources and suggest cleanup.
//!
//! Reads agent's active claims (from bus) and stale workspaces (from maw)
//! to produce cleanup guidance. Skips release commands for active bead claims.
//!
//! Exit policy: always exits 0 with status in stdout (clean or has-resources).
//! Operational failures (bus/maw unavailable) propagate as anyhow errors → exit 1.

use super::context::ProtocolContext;
use super::exit_policy;
use super::render::{ProtocolGuidance, ProtocolStatus};
use crate::commands::doctor::OutputFormat;

/// Execute cleanup protocol: check for held resources and output cleanup guidance.
///
/// Returns Ok(()) with guidance on stdout (exit 0) for all status outcomes.
/// ProtocolContext::collect errors propagate as anyhow::Error → exit 1.
pub fn execute(
    agent: &str,
    project: &str,
    format: OutputFormat,
) -> anyhow::Result<()> {
    // Collect state from bus and maw
    let ctx = ProtocolContext::collect(project, agent)?;

    // Build guidance
    let mut guidance = ProtocolGuidance::new("cleanup");
    guidance.bead = None;
    guidance.workspace = None;
    guidance.review = None;

    // Analyze active claims
    let bead_claims = ctx.held_bead_claims();
    let workspace_claims = ctx.held_workspace_claims();

    // If no resources held, we're clean
    if bead_claims.is_empty() && workspace_claims.is_empty() {
        guidance.status = ProtocolStatus::Ready;
        guidance.advise("No cleanup needed.".to_string());
        return render_cleanup(&guidance, format);
    }

    // We have resources held
    guidance.status = ProtocolStatus::HasResources;

    // Build cleanup steps
    let mut steps = Vec::new();

    // Step 1: Post agent idle message
    steps.push(format!("bus send --agent {agent} {project} \"Agent idle\" -L agent-idle"));

    // Step 2: Clear statuses
    steps.push(format!("bus statuses clear --agent {agent}"));

    // Step 3: Release claims (but warn if bead claims are active)
    if !bead_claims.is_empty() {
        // Add diagnostic warning
        let bead_list = bead_claims
            .iter()
            .map(|(id, _)| id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        guidance.diagnostic(format!(
            "WARNING: Active bead claim(s) held: {}. Releasing these marks them as unowned in in_progress state.",
            bead_list
        ));
    }
    steps.push(format!("bus claims release --agent {agent} --all"));

    // Step 4: Flush bead changes
    steps.push("maw exec default -- br sync --flush-only".to_string());

    guidance.steps(steps);

    // Build summary for advice
    let summary = format!(
        "Agent {} has {} bead claim(s) and {} workspace claim(s). \
         Run these commands to clean up and mark as idle.",
        agent,
        bead_claims.len(),
        workspace_claims.len()
    );
    guidance.advise(summary);

    render_cleanup(&guidance, format)
}

/// Render cleanup guidance in the requested format.
///
/// For JSON format, delegates to the standard render path (exit_policy::render_guidance).
/// For text/pretty formats, uses cleanup-specific rendering optimized for
/// the cleanup use case (tab-delimited status, claim counts, etc.).
///
/// All formats exit 0 — status is communicated via stdout content.
fn render_cleanup(guidance: &ProtocolGuidance, format: OutputFormat) -> anyhow::Result<()> {
    match format {
        OutputFormat::Text => {
            // Text format: machine-readable, token-efficient
            let status_text = match guidance.status {
                ProtocolStatus::Ready => "clean",
                ProtocolStatus::HasResources => "has-resources",
                _ => "unknown",
            };
            println!("status\t{}", status_text);

            // Count claims if has-resources
            if matches!(guidance.status, ProtocolStatus::HasResources) {
                let claim_count = guidance.diagnostics.iter()
                    .find(|d| d.contains("Active bead claim"))
                    .map(|_| guidance.diagnostics.len())
                    .unwrap_or(0);
                println!("claims\t{} active", claim_count);
                println!();
                println!("Run these commands to clean up:");
                for step in &guidance.steps {
                    println!("  {}", step);
                }
            } else {
                println!("claims\t0 active");
                println!();
                println!("No cleanup needed.");
            }
            Ok(())
        }
        OutputFormat::Pretty => {
            // Pretty format: human-readable with formatting
            let status_text = match guidance.status {
                ProtocolStatus::Ready => "✓ clean",
                ProtocolStatus::HasResources => "⚠ has-resources",
                _ => "? unknown",
            };
            println!("Status: {}", status_text);

            if matches!(guidance.status, ProtocolStatus::HasResources) {
                println!();
                println!("Run these commands to clean up:");
                for step in &guidance.steps {
                    println!("  {}", step);
                }

                if !guidance.diagnostics.is_empty() {
                    println!();
                    println!("Warnings:");
                    for diagnostic in &guidance.diagnostics {
                        println!("  ⚠ {}", diagnostic);
                    }
                }
            } else {
                println!("No cleanup needed.");
            }

            if let Some(advice) = &guidance.advice {
                println!();
                println!("Notes: {}", advice);
            }
            Ok(())
        }
        OutputFormat::Json => {
            // JSON format: use standard render path for consistency
            exit_policy::render_guidance(guidance, format)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cleanup_status_clean() {
        // When no resources held, status should be Ready
        let mut guidance = ProtocolGuidance::new("cleanup");
        guidance.status = ProtocolStatus::Ready;
        guidance.advise("No cleanup needed.".to_string());

        assert_eq!(format!("{:?}", guidance.status), "Ready");
        assert!(guidance.steps.is_empty());
    }

    #[test]
    fn test_cleanup_status_has_resources() {
        // When resources held, status should be HasResources
        let mut guidance = ProtocolGuidance::new("cleanup");
        guidance.status = ProtocolStatus::HasResources;
        guidance.steps(vec![
            "bus send --agent test-agent test-project \"Agent idle\" -L agent-idle".to_string(),
            "bus statuses clear --agent test-agent".to_string(),
            "bus claims release --agent test-agent --all".to_string(),
            "maw exec default -- br sync --flush-only".to_string(),
        ]);

        assert_eq!(format!("{:?}", guidance.status), "HasResources");
        assert_eq!(guidance.steps.len(), 4);
        assert!(guidance
            .steps
            .iter()
            .any(|s| s.contains("bus send")));
        assert!(guidance
            .steps
            .iter()
            .any(|s| s.contains("bus statuses clear")));
        assert!(guidance
            .steps
            .iter()
            .any(|s| s.contains("bus claims release")));
        assert!(guidance
            .steps
            .iter()
            .any(|s| s.contains("br sync")));
    }

    #[test]
    fn test_cleanup_warning_for_active_beads() {
        // When active bead claims exist, should add warning diagnostic
        let mut guidance = ProtocolGuidance::new("cleanup");
        guidance.diagnostic(
            "WARNING: Active bead claim(s) held: bd-3cqv. \
             Releasing these marks them as unowned in in_progress state."
                .to_string(),
        );

        assert!(guidance.diagnostics.iter().any(|d| d.contains("WARNING")));
        assert!(guidance.diagnostics.iter().any(|d| d.contains("bd-3cqv")));
    }
}
