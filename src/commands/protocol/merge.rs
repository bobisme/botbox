//! Protocol merge command: lead-facing command to check preconditions and
//! output merge steps for a worker's completed workspace.
//!
//! Validates: workspace exists, has changes, associated bead is closed,
//! review is approved (if enabled). Outputs merge steps with conflict
//! recovery guidance.

use super::context::ProtocolContext;
use super::render::{self, ProtocolGuidance, ProtocolStatus};
use super::review_gate::{self, ReviewGateStatus};
use super::shell;
use crate::commands::doctor::OutputFormat;
use crate::config::Config;

/// Execute the merge protocol command.
pub fn execute(
    workspace: &str,
    force: bool,
    execute: bool,
    agent: &str,
    project: &str,
    config: &Config,
    format: OutputFormat,
) -> anyhow::Result<()> {
    // Reject merging default workspace
    if workspace == "default" {
        let mut guidance = ProtocolGuidance::new("merge");
        guidance.blocked(
            "cannot merge the default workspace. \
             Default is the merge TARGET — other workspaces merge INTO it."
                .to_string(),
        );
        print_guidance(&guidance, format)?;
        return Ok(());
    }

    // Collect state from bus and maw
    let ctx = match ProtocolContext::collect(project, agent) {
        Ok(ctx) => ctx,
        Err(e) => {
            let mut guidance = ProtocolGuidance::new("merge");
            guidance.blocked(format!("failed to collect state: {}", e));
            print_guidance(&guidance, format)?;
            return Ok(());
        }
    };

    let mut guidance = ProtocolGuidance::new("merge");
    guidance.workspace = Some(workspace.to_string());
    guidance.set_freshness(120, Some(format!("botbox protocol merge {}", workspace)));

    // Check workspace exists
    let ws_exists = ctx.workspaces().iter().any(|ws| ws.name == workspace);
    if !ws_exists {
        guidance.blocked(format!(
            "workspace '{}' not found. Check with: maw ws list",
            workspace
        ));
        print_guidance(&guidance, format)?;
        return Ok(());
    }

    // Try to find the associated bead from workspace claims
    let bead_id = find_bead_for_workspace(&ctx, workspace);

    if let Some(ref bead_id) = bead_id {
        guidance.bead = Some(render::BeadRef {
            id: bead_id.clone(),
            title: String::new(), // filled below if bead found
        });

        // Check bead status
        match ctx.bead_status(bead_id) {
            Ok(bead_info) => {
                guidance.bead = Some(render::BeadRef {
                    id: bead_id.clone(),
                    title: bead_info.title.clone(),
                });

                if bead_info.status != "closed" && !force {
                    guidance.status = ProtocolStatus::Blocked;
                    guidance.diagnostic(format!(
                        "Bead {} is '{}', expected 'closed'. Worker may still be working.",
                        bead_id, bead_info.status
                    ));
                    guidance.advise(format!(
                        "Wait for worker to close bead {}, or use --force to merge anyway.",
                        bead_id
                    ));

                    let mut steps = Vec::new();
                    steps.push(format!(
                        "maw exec default -- br show {}",
                        bead_id
                    ));
                    guidance.steps(steps);

                    print_guidance(&guidance, format)?;
                    return Ok(());
                }
            }
            Err(_) => {
                guidance.diagnostic(format!(
                    "Could not fetch bead {} — it may have been deleted. Proceeding with merge.",
                    bead_id
                ));
            }
        }
    } else {
        guidance.diagnostic(
            "No associated bead found for this workspace. Proceeding without bead check."
                .to_string(),
        );
    }

    // Check review gate (if enabled)
    let required_reviewers: Vec<String> = config
        .review
        .reviewers
        .iter()
        .map(|role| format!("{}-{}", project, role))
        .collect();
    let review_enabled = config.review.enabled && !required_reviewers.is_empty();

    if review_enabled && !force {
        match find_review_for_workspace(&ctx, workspace) {
            Some((review_id, review_detail)) => {
                let decision =
                    review_gate::evaluate_review_gate(&review_detail, &required_reviewers);
                guidance.review = Some(render::ReviewRef {
                    review_id: review_id.clone(),
                    status: decision.status_str().to_string(),
                });

                match decision.status {
                    ReviewGateStatus::Approved => {
                        // Good — review approved, proceed to merge
                    }
                    ReviewGateStatus::Blocked => {
                        guidance.status = ProtocolStatus::Blocked;
                        guidance.diagnostic(format!(
                            "Review {} is blocked by: {}. Resolve feedback before merging.",
                            review_id,
                            decision.blocked_by.join(", ")
                        ));
                        guidance.advise(
                            "Address reviewer feedback, then re-request review.".to_string(),
                        );

                        let mut steps = Vec::new();
                        steps.push(shell::crit_show_cmd(workspace, &review_id));
                        guidance.steps(steps);

                        print_guidance(&guidance, format)?;
                        return Ok(());
                    }
                    ReviewGateStatus::NeedsReview => {
                        guidance.status = ProtocolStatus::NeedsReview;
                        guidance.diagnostic(format!(
                            "Review {} still awaiting votes from: {}",
                            review_id,
                            decision.missing_approvals.join(", ")
                        ));
                        guidance.advise(
                            "Wait for reviewers or re-request review before merging.".to_string(),
                        );

                        let mut steps = Vec::new();
                        steps.push(shell::crit_show_cmd(workspace, &review_id));
                        guidance.steps(steps);

                        print_guidance(&guidance, format)?;
                        return Ok(());
                    }
                }
            }
            None => {
                if !force {
                    guidance.status = ProtocolStatus::NeedsReview;
                    guidance.diagnostic(
                        "Review is enabled but no review exists for this workspace.".to_string(),
                    );
                    guidance.advise(
                        "Create a review before merging, or use --force to skip review gate."
                            .to_string(),
                    );

                    let mut steps = Vec::new();
                    let title = bead_id
                        .as_ref()
                        .map(|id| format!("Work from {}", id))
                        .unwrap_or_else(|| format!("Work from {}", workspace));
                    steps.push(shell::crit_create_cmd(
                        workspace,
                        "agent",
                        &title,
                        &required_reviewers.join(","),
                    ));
                    guidance.steps(steps);

                    print_guidance(&guidance, format)?;
                    return Ok(());
                }
            }
        }
    }

    // All preconditions met — build merge steps
    guidance.status = ProtocolStatus::Ready;
    let review_id = if review_enabled {
        find_review_for_workspace(&ctx, workspace).map(|(id, _)| id)
    } else {
        None
    };

    build_merge_steps(
        &mut guidance,
        workspace,
        project,
        bead_id.as_deref(),
        review_id.as_deref(),
        config.push_main,
    );

    // Execute if --execute flag is set
    if execute {
        return execute_and_render(&guidance, workspace, format);
    }

    if force {
        guidance.advise(format!(
            "Force-merging workspace {} (review/bead checks bypassed). \
             Run these commands to merge.",
            workspace
        ));
    } else {
        guidance.advise(format!(
            "All preconditions met. Run these commands to merge workspace {}.",
            workspace
        ));
    }

    print_guidance(&guidance, format)?;
    Ok(())
}

/// Build the merge steps: merge, mark-merged, sync, push.
/// Also includes conflict recovery guidance as comments.
fn build_merge_steps(
    guidance: &mut ProtocolGuidance,
    workspace: &str,
    project: &str,
    bead_id: Option<&str>,
    review_id: Option<&str>,
    push_main: bool,
) {
    let mut steps = Vec::new();

    // 1. Merge workspace
    steps.push(shell::ws_merge_cmd(workspace));

    // 2. Mark review as merged (if review exists)
    if let Some(rid) = review_id {
        steps.push(format!(
            "maw exec default -- crit reviews mark-merged {}",
            rid
        ));
    }

    // 3. Sync beads
    steps.push(shell::br_sync_cmd());

    // 4. Push (if enabled)
    if push_main {
        steps.push("maw push".to_string());
    }

    // 5. Announce merge
    let merge_msg = if let Some(bid) = bead_id {
        format!("Merged workspace {} ({})", workspace, bid)
    } else {
        format!("Merged workspace {}", workspace)
    };
    steps.push(shell::bus_send_cmd(
        "agent", project, &merge_msg, "task-done",
    ));

    guidance.steps(steps);

    // Add conflict recovery guidance as diagnostics
    guidance.diagnostic(format!(
        "If merge reports conflicts (WARNING: Merge has conflicts), the workspace is preserved. Recovery steps:\n\
         \n\
         1. View conflicted files:\n\
         \n\
         maw exec {} -- jj status\n\
         maw exec {} -- jj resolve --list\n\
         \n\
         2. For auto-resolvable files (.beads/, .claude/, .agents/):\n\
         \n\
         maw exec {} -- jj restore --from main .beads/\n\
         \n\
         3. For code conflicts — edit files to remove <<<<<<< markers:\n\
         \n\
         maw exec {} -- jj resolve              # launches merge tool\n\
         maw exec {} -- jj resolve --tool :ours  # take workspace version\n\
         maw exec {} -- jj resolve --tool :theirs # take main version\n\
         \n\
         4. After resolving:\n\
         \n\
         maw exec {} -- jj describe -m 'resolve: merge conflicts in {}'\n\
         maw ws merge {} --destroy              # retry merge\n\
         \n\
         5. To UNDO the merge entirely (recover pre-merge state):\n\
         \n\
         maw exec {} -- jj op undo              # revert the merge operation\n\
         \n\
         6. To recover a destroyed workspace:\n\
         \n\
         maw ws restore {}                      # recovers workspace from jj op log",
        workspace, workspace, workspace, workspace, workspace,
        workspace, workspace, workspace, workspace, workspace, workspace,
    ));
}

/// Try to find the bead associated with a workspace.
///
/// Checks claims first (workspace claim memo = bead ID), then falls back
/// to checking all held bead claims (for workers with one bead).
fn find_bead_for_workspace(ctx: &ProtocolContext, workspace: &str) -> Option<String> {
    // Method 1: check workspace claims for memo (when bus includes memo in JSON)
    for claim in ctx.claims() {
        if let Some(memo) = &claim.memo {
            for pattern in &claim.patterns {
                if let Some(ws_name) = pattern
                    .strip_prefix("workspace://")
                    .and_then(|rest| rest.split('/').nth(1))
                {
                    if ws_name == workspace {
                        return Some(memo.clone());
                    }
                }
            }
        }
    }

    // Method 2: if there's exactly one bead claim, use that
    let bead_claims = ctx.held_bead_claims();
    if bead_claims.len() == 1 {
        return Some(bead_claims[0].0.to_string());
    }

    None
}

/// Try to find a review for a workspace.
fn find_review_for_workspace(
    ctx: &ProtocolContext,
    workspace: &str,
) -> Option<(String, super::adapters::ReviewDetail)> {
    let output = std::process::Command::new("maw")
        .args([
            "exec", workspace, "--", "crit", "reviews", "list", "--format", "json",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8(output.stdout).ok()?;
    let reviews_resp = super::adapters::parse_reviews_list(&stdout).ok()?;

    for review_summary in &reviews_resp.reviews {
        if review_summary.status != "merged" {
            if let Ok(detail) = ctx.review_status(&review_summary.review_id, workspace) {
                return Some((review_summary.review_id.clone(), detail));
            }
        }
    }

    None
}

/// Execute merge steps and render the execution report.
///
/// Special handling: if the merge step outputs a WARNING about conflicts,
/// we detect it and report the conflict state rather than continuing.
fn execute_and_render(
    guidance: &ProtocolGuidance,
    workspace: &str,
    format: OutputFormat,
) -> anyhow::Result<()> {
    use super::executor;

    let report = executor::execute_steps(&guidance.steps)
        .map_err(|e| anyhow::anyhow!("execution failed: {}", e))?;

    // Check if the merge step produced conflict warnings
    let merge_had_conflicts = report.results.iter().any(|r| {
        r.stdout.contains("WARNING: Merge has conflicts")
            || r.stdout.contains("conflict(s) remaining")
    });

    if merge_had_conflicts {
        // Re-render with conflict status
        let mut conflict_guidance = ProtocolGuidance::new("merge");
        conflict_guidance.workspace = Some(workspace.to_string());
        conflict_guidance.status = ProtocolStatus::Blocked;
        conflict_guidance.diagnostic(format!(
            "Merge completed with CONFLICTS. Workspace {} is preserved (not destroyed).",
            workspace
        ));

        // Include the conflict recovery guidance from the original guidance
        for diag in &guidance.diagnostics {
            if diag.contains("If merge reports conflicts") {
                conflict_guidance.diagnostic(diag.clone());
                break;
            }
        }

        let output = render::render(&conflict_guidance, format)
            .map_err(|e| anyhow::anyhow!("render error: {}", e))?;
        println!("{}", output);
        std::process::exit(1);
    }

    let output = executor::render_report(&report, format);
    println!("{}", output);

    if !report.remaining.is_empty() || report.results.iter().any(|r| !r.success) {
        std::process::exit(1);
    }

    Ok(())
}

/// Render and print guidance.
fn print_guidance(guidance: &ProtocolGuidance, format: OutputFormat) -> anyhow::Result<()> {
    let output =
        render::render(guidance, format).map_err(|e| anyhow::anyhow!("render error: {}", e))?;
    println!("{}", output);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_merge_steps_basic() {
        let mut guidance = ProtocolGuidance::new("merge");
        guidance.workspace = Some("frost-castle".to_string());

        build_merge_steps(
            &mut guidance,
            "frost-castle",
            "myproject",
            Some("bd-abc"),
            Some("cr-123"),
            true,
        );

        // Should have merge, mark-merged, sync, push, announce
        assert!(guidance.steps.len() >= 4);
        assert!(guidance.steps.iter().any(|s| s.contains("maw ws merge frost-castle --destroy")));
        assert!(guidance.steps.iter().any(|s| s.contains("crit reviews mark-merged cr-123")));
        assert!(guidance.steps.iter().any(|s| s.contains("br sync")));
        assert!(guidance.steps.iter().any(|s| s.contains("maw push")));
        assert!(guidance.steps.iter().any(|s| s.contains("task-done")));

        // Should include conflict recovery guidance
        assert!(guidance.diagnostics.iter().any(|d| d.contains("jj resolve")));
        assert!(guidance.diagnostics.iter().any(|d| d.contains("jj op undo")));
        assert!(guidance.diagnostics.iter().any(|d| d.contains("maw ws restore")));
    }

    #[test]
    fn test_build_merge_steps_no_push() {
        let mut guidance = ProtocolGuidance::new("merge");

        build_merge_steps(
            &mut guidance,
            "frost-castle",
            "myproject",
            None,
            None,
            false, // push_main = false
        );

        // Should NOT have push
        assert!(!guidance.steps.iter().any(|s| s.contains("maw push")));
        // Should NOT have mark-merged (no review_id)
        assert!(!guidance.steps.iter().any(|s| s.contains("mark-merged")));
        // Should still have merge, sync, announce
        assert!(guidance.steps.iter().any(|s| s.contains("maw ws merge")));
        assert!(guidance.steps.iter().any(|s| s.contains("br sync")));
    }

    #[test]
    fn test_build_merge_steps_announce_includes_bead() {
        let mut guidance = ProtocolGuidance::new("merge");

        build_merge_steps(
            &mut guidance,
            "frost-castle",
            "myproject",
            Some("bd-abc"),
            None,
            false,
        );

        let announce = guidance.steps.iter().find(|s| s.contains("bus send")).unwrap();
        assert!(announce.contains("bd-abc"));
    }
}
