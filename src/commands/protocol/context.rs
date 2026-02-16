//! ProtocolContext: cross-tool shared state collector.
//!
//! Gathers bus claims, maw workspaces, and bead/review status in a single
//! structure to avoid duplicating subprocess calls across protocol commands.
//! Lazy evaluation: state is fetched on-demand via subprocess calls, not upfront.

use std::process::Command;

use super::adapters::{self, BeadInfo, Claim, ReviewDetail, ReviewDetailResponse, Workspace};

/// Cross-tool state collector for protocol commands.
///
/// Provides cached access to bus claims and maw workspaces (fetched on construction),
/// plus lazy on-demand methods for bead/review status.
#[derive(Debug, Clone)]
pub struct ProtocolContext {
    project: String,
    agent: String,
    claims: Vec<Claim>,
    workspaces: Vec<Workspace>,
}

impl ProtocolContext {
    /// Collect shared state from bus and maw.
    ///
    /// Calls:
    /// - `bus claims list --format json --agent <agent>`
    /// - `maw ws list --format json`
    ///
    /// Returns error if either subprocess fails or output is unparseable.
    pub fn collect(project: &str, agent: &str) -> Result<Self, ContextError> {
        // Fetch bus claims
        let claims_output = Self::run_subprocess(&["bus", "claims", "list", "--agent", agent, "--format", "json"])?;
        let claims_resp = adapters::parse_claims(&claims_output)
            .map_err(|e| ContextError::ParseFailed(format!("claims: {e}")))?;

        // Fetch maw workspaces
        let workspaces_output = Self::run_subprocess(&["maw", "ws", "list", "--format", "json"])?;
        let workspaces_resp = adapters::parse_workspaces(&workspaces_output)
            .map_err(|e| ContextError::ParseFailed(format!("workspaces: {e}")))?;

        Ok(ProtocolContext {
            project: project.to_string(),
            agent: agent.to_string(),
            claims: claims_resp.claims,
            workspaces: workspaces_resp.workspaces,
        })
    }

    /// Get all held bead claims as (bead_id, pattern) tuples.
    pub fn held_bead_claims(&self) -> Vec<(&str, &str)> {
        let mut result = Vec::new();
        for claim in &self.claims {
            if claim.agent == self.agent {
                for pattern in &claim.patterns {
                    if let Some(bead_id) = pattern.strip_prefix("bead://").and_then(|rest| rest.split('/').nth(1)) {
                        result.push((bead_id, pattern.as_str()));
                    }
                }
            }
        }
        result
    }

    /// Get all held workspace claims as (workspace_name, pattern) tuples.
    pub fn held_workspace_claims(&self) -> Vec<(&str, &str)> {
        let mut result = Vec::new();
        for claim in &self.claims {
            if claim.agent == self.agent {
                for pattern in &claim.patterns {
                    if let Some(ws_name) = pattern.strip_prefix("workspace://").and_then(|rest| rest.split('/').nth(1)) {
                        result.push((ws_name, pattern.as_str()));
                    }
                }
            }
        }
        result
    }

    /// Find a workspace by name.
    pub fn find_workspace(&self, name: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|ws| ws.name == name)
    }

    /// Correlate a bead claim with its workspace claim.
    ///
    /// Returns the workspace name if found in held claims, using memo as a hint.
    pub fn workspace_for_bead(&self, bead_id: &str) -> Option<&str> {
        for claim in &self.claims {
            if claim.agent == self.agent {
                // Check if this claim holds the bead
                if let Some(memo) = &claim.memo {
                    if memo == bead_id {
                        // This claim is for our bead. Check if it holds a workspace.
                        for pattern in &claim.patterns {
                            if let Some(ws_name) = pattern.strip_prefix("workspace://").and_then(|rest| rest.split('/').nth(1)) {
                                return Some(ws_name);
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Fetch bead status by calling `maw exec default -- br show <id> --format json`.
    pub fn bead_status(&self, bead_id: &str) -> Result<BeadInfo, ContextError> {
        let output = Self::run_subprocess(&["maw", "exec", "default", "--", "br", "show", bead_id, "--format", "json"])?;
        let bead = adapters::parse_bead_show(&output)
            .map_err(|e| ContextError::ParseFailed(format!("bead {bead_id}: {e}")))?;
        Ok(bead)
    }

    /// List reviews in a workspace by calling `maw exec <ws> -- crit reviews list --format json`.
    ///
    /// Returns empty list if no reviews exist or crit is not configured.
    pub fn reviews_in_workspace(&self, workspace: &str) -> Result<Vec<adapters::ReviewSummary>, ContextError> {
        let output = Self::run_subprocess(&["maw", "exec", workspace, "--", "crit", "reviews", "list", "--format", "json"]);
        match output {
            Ok(json) => {
                let resp = adapters::parse_reviews_list(&json)
                    .map_err(|e| ContextError::ParseFailed(format!("reviews list in {workspace}: {e}")))?;
                Ok(resp.reviews)
            }
            Err(_) => {
                // crit may not be configured or workspace may not have reviews
                Ok(Vec::new())
            }
        }
    }

    /// Fetch review status by calling `maw exec <ws> -- crit review <id> --format json`.
    pub fn review_status(&self, review_id: &str, workspace: &str) -> Result<ReviewDetail, ContextError> {
        let output = Self::run_subprocess(&["maw", "exec", workspace, "--", "crit", "review", review_id, "--format", "json"])?;
        let review_resp: ReviewDetailResponse = serde_json::from_str(&output)
            .map_err(|e| ContextError::ParseFailed(format!("review {review_id}: {e}")))?;
        Ok(review_resp.review)
    }

    /// Check for claim conflicts by querying all claims.
    ///
    /// Returns the conflicting claim if another agent holds the bead.
    pub fn check_bead_claim_conflict(&self, bead_id: &str) -> Result<Option<String>, ContextError> {
        let output = Self::run_subprocess(&["bus", "claims", "list", "--format", "json"])?;
        let claims_resp = adapters::parse_claims(&output)
            .map_err(|e| ContextError::ParseFailed(format!("all claims: {e}")))?;

        for claim in &claims_resp.claims {
            if claim.agent != self.agent {
                for pattern in &claim.patterns {
                    if let Some(id) = pattern.strip_prefix("bead://").and_then(|rest| rest.split('/').nth(1)) {
                        if id == bead_id {
                            return Ok(Some(claim.agent.clone()));
                        }
                    }
                }
            }
        }
        Ok(None)
    }

    /// Run a subprocess and capture stdout.
    fn run_subprocess(args: &[&str]) -> Result<String, ContextError> {
        let mut cmd = Command::new(args[0]);
        for arg in &args[1..] {
            cmd.arg(arg);
        }

        let output = cmd
            .output()
            .map_err(|e| ContextError::SubprocessFailed(format!("{}: {e}", args[0])))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ContextError::SubprocessFailed(format!(
                "{} exited with status {}: {}",
                args[0],
                output.status.code().unwrap_or(-1),
                stderr.trim()
            )));
        }

        Ok(String::from_utf8(output.stdout)
            .map_err(|e| ContextError::SubprocessFailed(format!("invalid UTF-8 from {}: {e}", args[0])))?)
    }

    pub fn project(&self) -> &str {
        &self.project
    }

    pub fn agent(&self) -> &str {
        &self.agent
    }

    pub fn claims(&self) -> &[Claim] {
        &self.claims
    }

    pub fn workspaces(&self) -> &[Workspace] {
        &self.workspaces
    }
}

/// Errors during context collection and state queries.
#[derive(Debug, Clone)]
pub enum ContextError {
    /// Subprocess execution failed (command not found, permission denied, etc.)
    SubprocessFailed(String),
    /// Output parsing failed (invalid JSON, missing fields, etc.)
    ParseFailed(String),
}

impl std::fmt::Display for ContextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ContextError::SubprocessFailed(msg) => write!(f, "subprocess failed: {msg}"),
            ContextError::ParseFailed(msg) => write!(f, "parse failed: {msg}"),
        }
    }
}

impl std::error::Error for ContextError {}

#[cfg(test)]
mod tests {
    use super::*;

    // Mock responses for testing without subprocess calls
    const CLAIMS_JSON: &str = r#"{"claims": [
        {"agent": "crimson-storm", "patterns": ["bead://botbox/bd-3cqv", "workspace://botbox/frost-forest"], "active": true, "memo": "bd-3cqv"},
        {"agent": "green-vertex", "patterns": ["bead://botbox/bd-3t1d"], "active": true, "memo": "bd-3t1d"}
    ]}"#;

    const WORKSPACES_JSON: &str = r#"{"workspaces": [
        {"name": "default", "is_default": true, "is_current": false, "change_id": "abc123"},
        {"name": "frost-forest", "is_default": false, "is_current": true, "change_id": "def456"}
    ], "advice": []}"#;

    #[test]
    fn test_held_bead_claims() {
        let claims_resp = adapters::parse_claims(CLAIMS_JSON).unwrap();
        let workspaces_resp = adapters::parse_workspaces(WORKSPACES_JSON).unwrap();

        let ctx = ProtocolContext {
            project: "botbox".to_string(),
            agent: "crimson-storm".to_string(),
            claims: claims_resp.claims,
            workspaces: workspaces_resp.workspaces,
        };

        let bead_claims = ctx.held_bead_claims();
        assert_eq!(bead_claims.len(), 1);
        assert_eq!(bead_claims[0].0, "bd-3cqv");
    }

    #[test]
    fn test_held_workspace_claims() {
        let claims_resp = adapters::parse_claims(CLAIMS_JSON).unwrap();
        let workspaces_resp = adapters::parse_workspaces(WORKSPACES_JSON).unwrap();

        let ctx = ProtocolContext {
            project: "botbox".to_string(),
            agent: "crimson-storm".to_string(),
            claims: claims_resp.claims,
            workspaces: workspaces_resp.workspaces,
        };

        let ws_claims = ctx.held_workspace_claims();
        assert_eq!(ws_claims.len(), 1);
        assert_eq!(ws_claims[0].0, "frost-forest");
    }

    #[test]
    fn test_find_workspace() {
        let claims_resp = adapters::parse_claims(CLAIMS_JSON).unwrap();
        let workspaces_resp = adapters::parse_workspaces(WORKSPACES_JSON).unwrap();

        let ctx = ProtocolContext {
            project: "botbox".to_string(),
            agent: "crimson-storm".to_string(),
            claims: claims_resp.claims,
            workspaces: workspaces_resp.workspaces,
        };

        let ws = ctx.find_workspace("frost-forest");
        assert!(ws.is_some());
        assert_eq!(ws.unwrap().name, "frost-forest");
        assert!(!ws.unwrap().is_default);
    }

    #[test]
    fn test_workspace_for_bead() {
        let claims_resp = adapters::parse_claims(CLAIMS_JSON).unwrap();
        let workspaces_resp = adapters::parse_workspaces(WORKSPACES_JSON).unwrap();

        let ctx = ProtocolContext {
            project: "botbox".to_string(),
            agent: "crimson-storm".to_string(),
            claims: claims_resp.claims,
            workspaces: workspaces_resp.workspaces,
        };

        let ws = ctx.workspace_for_bead("bd-3cqv");
        assert_eq!(ws, Some("frost-forest"));
    }

    #[test]
    fn test_held_bead_claims_other_agent() {
        let claims_resp = adapters::parse_claims(CLAIMS_JSON).unwrap();
        let workspaces_resp = adapters::parse_workspaces(WORKSPACES_JSON).unwrap();

        // Using green-vertex context
        let ctx = ProtocolContext {
            project: "botbox".to_string(),
            agent: "green-vertex".to_string(),
            claims: claims_resp.claims,
            workspaces: workspaces_resp.workspaces,
        };

        let bead_claims = ctx.held_bead_claims();
        assert_eq!(bead_claims.len(), 1);
        assert_eq!(bead_claims[0].0, "bd-3t1d");
    }

    #[test]
    fn test_empty_claims() {
        let empty = r#"{"claims": []}"#;
        let claims_resp = adapters::parse_claims(empty).unwrap();
        let workspaces_resp = adapters::parse_workspaces(WORKSPACES_JSON).unwrap();

        let ctx = ProtocolContext {
            project: "botbox".to_string(),
            agent: "crimson-storm".to_string(),
            claims: claims_resp.claims,
            workspaces: workspaces_resp.workspaces,
        };

        assert!(ctx.held_bead_claims().is_empty());
        assert!(ctx.held_workspace_claims().is_empty());
    }
}
