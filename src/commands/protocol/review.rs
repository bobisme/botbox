//! Protocol review command: check state and output commands to request review.
//!
//! Resolves bead claim, workspace, existing review status, and reviewer list
//! to produce guidance for creating or following up on a code review.

use super::context::ProtocolContext;
use super::render::{BeadRef, ProtocolGuidance, ProtocolStatus, ReviewRef};
use super::review_gate::{self, ReviewGateStatus};
use super::shell;
use crate::commands::doctor::OutputFormat;
use crate::config::Config;

/// Execute review protocol: check state and output review guidance.
pub fn execute(
    bead_id: &str,
    reviewers_override: Option<&str>,
    review_id_flag: Option<&str>,
    agent: &str,
    project: &str,
    config: &Config,
    format: OutputFormat,
) -> anyhow::Result<()> {
    // Early input validation before any subprocess calls
    if let Err(e) = shell::validate_bead_id(bead_id) {
        anyhow::bail!("invalid bead ID: {e}");
    }

    let ctx = ProtocolContext::collect(project, agent)?;

    let mut guidance = ProtocolGuidance::new("review");
    guidance.set_freshness(
        300,
        Some(format!("botbox protocol review {bead_id}")),
    );

    // Fetch bead info
    let bead_info = match ctx.bead_status(bead_id) {
        Ok(bead) => bead,
        Err(e) => {
            guidance.blocked(format!("bead {bead_id} not found: {e}"));
            print_guidance(&guidance, format)?;
            return Ok(());
        }
    };

    guidance.bead = Some(BeadRef {
        id: bead_id.to_string(),
        title: bead_info.title.clone(),
    });

    // Check agent holds bead claim
    let bead_claims = ctx.held_bead_claims();
    let holds_claim = bead_claims.iter().any(|(id, _)| *id == bead_id);
    if !holds_claim {
        guidance.blocked(format!(
            "agent {agent} does not hold claim for bead {bead_id}. \
             Stake a claim first with: {}",
            shell::claims_stake_cmd(
                "AGENT",
                &format!("bead://{project}/{bead_id}"),
                bead_id,
            )
        ));
        print_guidance(&guidance, format)?;
        return Ok(());
    }

    // Resolve workspace from claims
    let workspace = match ctx.workspace_for_bead(bead_id) {
        Some(ws) => ws.to_string(),
        None => {
            guidance.blocked(format!(
                "no workspace claim found for bead {bead_id}. \
                 Create workspace and stake claim first."
            ));
            print_guidance(&guidance, format)?;
            return Ok(());
        }
    };

    // Validate workspace name before it flows into subprocess calls
    if let Err(e) = shell::validate_workspace_name(&workspace) {
        guidance.blocked(format!(
            "invalid workspace name from claims: {e}"
        ));
        print_guidance(&guidance, format)?;
        return Ok(());
    }
    guidance.workspace = Some(workspace.clone());

    // Resolve and validate reviewer names
    let reviewer_names = resolve_reviewers(reviewers_override, config, project)?;

    // If --review-id was provided, check that existing review
    if let Some(rid) = review_id_flag {
        return handle_existing_review(
            &ctx, &mut guidance, rid, &workspace, &reviewer_names, bead_id, project, format,
        );
    }

    // Check for existing review in the workspace
    match ctx.reviews_in_workspace(&workspace) {
        Ok(reviews) if !reviews.is_empty() => {
            // Use the first open review found
            let existing = &reviews[0];
            return handle_existing_review(
                &ctx,
                &mut guidance,
                &existing.review_id,
                &workspace,
                &reviewer_names,
                bead_id,
                project,
                format,
            );
        }
        Ok(_) => {
            // No existing review — output creation commands
        }
        Err(e) => {
            // Listing failed — proceed to create a new review
            guidance.diagnostic(
                format!("Could not list existing reviews ({e}); proceeding with creation."),
            );
        }
    }

    // No review exists: output crit reviews create + bus announce commands
    guidance.status = ProtocolStatus::NeedsReview;

    let reviewers_str = reviewer_names.join(",");
    let title = format!("{bead_id}: {}", bead_info.title);

    guidance.step(shell::crit_create_cmd(
        &workspace,
        "AGENT",
        &title,
        &reviewers_str,
    ));

    // Announce on bus with @mentions for each reviewer
    let mentions: Vec<String> = reviewer_names.iter().map(|r| format!("@{r}")).collect();
    let announce_msg = format!(
        "Review requested: {bead_id} {}",
        mentions.join(" ")
    );
    guidance.step(shell::bus_send_cmd(
        "AGENT",
        project,
        &announce_msg,
        "review-request",
    ));

    guidance.advise(format!(
        "Create review and announce. Reviewers: {}",
        reviewer_names.join(", ")
    ));

    print_guidance(&guidance, format)?;
    Ok(())
}

/// Handle an existing review: check its status and output appropriate commands.
#[allow(clippy::too_many_arguments)]
fn handle_existing_review(
    ctx: &ProtocolContext,
    guidance: &mut ProtocolGuidance,
    review_id: &str,
    workspace: &str,
    reviewer_names: &[String],
    bead_id: &str,
    project: &str,
    format: OutputFormat,
) -> anyhow::Result<()> {
    let review_detail = match ctx.review_status(review_id, workspace) {
        Ok(r) => r,
        Err(e) => {
            guidance.blocked(format!("could not fetch review {review_id}: {e}"));
            print_guidance(guidance, format)?;
            return Ok(());
        }
    };

    guidance.review = Some(ReviewRef {
        review_id: review_id.to_string(),
        status: review_detail.status.clone(),
    });

    // Evaluate review gate
    let decision = review_gate::evaluate_review_gate(&review_detail, reviewer_names);

    match decision.status {
        ReviewGateStatus::Approved => {
            // LGTM — advise to proceed to finish
            guidance.status = ProtocolStatus::Ready;
            guidance.advise(format!(
                "Review {} approved by {}. Proceed to finish: botbox protocol finish {}",
                review_id,
                decision.approved_by.join(", "),
                bead_id,
            ));
        }
        ReviewGateStatus::Blocked => {
            // Blocked — output crit review (read feedback) + re-request commands
            guidance.status = ProtocolStatus::Blocked;

            // Step 1: Read review feedback
            guidance.step(shell::crit_show_cmd(workspace, review_id));

            // Step 2: After addressing feedback, re-request review
            let reviewers_str = reviewer_names.join(",");
            guidance.step(shell::crit_request_cmd(
                workspace,
                review_id,
                &reviewers_str,
                "AGENT",
            ));

            // Step 3: Announce re-request on bus
            let mentions: Vec<String> = decision.blocked_by.iter().map(|r| format!("@{r}")).collect();
            let announce_msg = format!(
                "Review updated: {review_id} — addressed feedback, re-requesting {}",
                mentions.join(" ")
            );
            guidance.step(shell::bus_send_cmd(
                "AGENT",
                project,
                &announce_msg,
                "review-request",
            ));

            guidance.diagnostic(format!(
                "Blocked by: {}. Open threads: {}",
                decision.blocked_by.join(", "),
                review_detail.open_thread_count,
            ));
            guidance.advise(
                "Read review feedback, address issues, then re-request review.".to_string(),
            );
        }
        ReviewGateStatus::NeedsReview => {
            // Still waiting for reviews
            guidance.status = ProtocolStatus::NeedsReview;

            if !decision.missing_approvals.is_empty() {
                // Re-request from missing reviewers
                let missing_str = decision.missing_approvals.join(",");
                guidance.step(shell::crit_request_cmd(
                    workspace,
                    review_id,
                    &missing_str,
                    "AGENT",
                ));

                let mentions: Vec<String> =
                    decision.missing_approvals.iter().map(|r| format!("@{r}")).collect();
                let announce_msg = format!(
                    "Review requested: {review_id} {}",
                    mentions.join(" ")
                );
                guidance.step(shell::bus_send_cmd(
                    "AGENT",
                    project,
                    &announce_msg,
                    "review-request",
                ));
            }

            guidance.advise(format!(
                "Awaiting review from: {}. {} of {} required reviewers have voted.",
                decision.missing_approvals.join(", "),
                decision.approved_by.len(),
                decision.total_required,
            ));
        }
    }

    print_guidance(guidance, format)?;
    Ok(())
}

/// Resolve reviewer names from --reviewers flag or config.
///
/// Reviewers in config are stored as role names (e.g., "security").
/// These are mapped to `<project>-<role>` (e.g., "botbox-security").
/// The --reviewers flag overrides with literal reviewer names.
/// All reviewer names are validated against identifier rules.
fn resolve_reviewers(
    reviewers_override: Option<&str>,
    config: &Config,
    project: &str,
) -> anyhow::Result<Vec<String>> {
    let names: Vec<String> = if let Some(override_str) = reviewers_override {
        override_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        config
            .review
            .reviewers
            .iter()
            .map(|role| format!("{project}-{role}"))
            .collect()
    };

    // Validate all reviewer names
    for name in &names {
        shell::validate_identifier("reviewer name", name)
            .map_err(|e| anyhow::anyhow!("invalid reviewer: {e}"))?;
    }

    Ok(names)
}

/// Render guidance to stdout.
fn print_guidance(guidance: &ProtocolGuidance, format: OutputFormat) -> anyhow::Result<()> {
    let output =
        super::render::render(guidance, format).map_err(|e| anyhow::anyhow!("render error: {e}"))?;
    println!("{}", output);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config(reviewers: Vec<&str>) -> Config {
        Config {
            version: "1.0.0".into(),
            project: crate::config::ProjectConfig {
                name: "botbox".into(),
                project_type: vec![],
                languages: vec![],
                default_agent: Some("botbox-dev".into()),
                channel: Some("botbox".into()),
                install_command: None,
                critical_approvers: None,
            },
            tools: Default::default(),
            review: crate::config::ReviewConfig {
                enabled: true,
                reviewers: reviewers.into_iter().map(|s| s.to_string()).collect(),
            },
            push_main: false,
            agents: Default::default(),
        }
    }

    #[test]
    fn resolve_reviewers_from_config() {
        let config = make_config(vec!["security", "perf"]);
        let names = resolve_reviewers(None, &config, "botbox").unwrap();
        assert_eq!(names, vec!["botbox-security", "botbox-perf"]);
    }

    #[test]
    fn resolve_reviewers_override() {
        let config = make_config(vec!["security"]);
        let names = resolve_reviewers(Some("custom-reviewer,another"), &config, "botbox").unwrap();
        assert_eq!(names, vec!["custom-reviewer", "another"]);
    }

    #[test]
    fn resolve_reviewers_override_trims_whitespace() {
        let config = make_config(vec![]);
        let names = resolve_reviewers(Some(" a , b , c "), &config, "proj").unwrap();
        assert_eq!(names, vec!["a", "b", "c"]);
    }

    #[test]
    fn resolve_reviewers_empty_config() {
        let config = make_config(vec![]);
        let names = resolve_reviewers(None, &config, "botbox").unwrap();
        assert!(names.is_empty());
    }

    #[test]
    fn resolve_reviewers_rejects_invalid_names() {
        let config = make_config(vec![]);
        let result = resolve_reviewers(Some("valid,bad name with spaces"), &config, "proj");
        assert!(result.is_err());
    }
}
