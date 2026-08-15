//! JSON adapters for companion tool output.
//!
//! Tolerant parsing for rite claims, maw workspaces, bn show, and seal review.
//! Each adapter handles optional/new fields gracefully and produces clear
//! parse errors. `ProtocolContext` consumes these instead of ad-hoc parsing.

// These structs intentionally model the full JSON shape of each companion
// tool's output for forward-compatibility and documentation, even though only
// a subset of fields is read today; likewise some parsers are retained (with
// tests) for not-yet-wired call sites.
#![allow(dead_code)]

use serde::Deserialize;

// --- Bus Claims ---

/// Parsed output from `rite claims list --format json`.
#[derive(Debug, Clone, Deserialize)]
pub struct ClaimsResponse {
    #[serde(default)]
    pub claims: Vec<Claim>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Claim {
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub patterns: Vec<String>,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub memo: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

impl Claim {
    /// Extract bone IDs from `bone://project/bd-xxx` patterns.
    #[must_use]
    pub fn bone_ids(&self) -> Vec<&str> {
        self.patterns
            .iter()
            .filter_map(|p| {
                p.strip_prefix("bone://")
                    .and_then(|rest| rest.split('/').nth(1))
            })
            .collect()
    }

    /// Extract workspace names from `workspace://project/ws-name` patterns.
    #[must_use]
    pub fn workspace_names(&self) -> Vec<&str> {
        self.patterns
            .iter()
            .filter_map(|p| {
                p.strip_prefix("workspace://")
                    .and_then(|rest| rest.split('/').nth(1))
            })
            .collect()
    }
}

// --- Maw Workspaces ---

/// Parsed output from `maw ws list --format json`.
#[derive(Debug, Clone, Deserialize)]
pub struct WorkspacesResponse {
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub advice: Vec<WorkspaceAdvice>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Workspace {
    pub name: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub is_current: bool,
    #[serde(default)]
    pub change_id: Option<String>,
    #[serde(default)]
    pub commit_id: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkspaceAdvice {
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
}

// --- Bones (bn show) ---

/// Parsed output from `bn show <id> --format json`.
///
/// bn show returns a single JSON object.
#[derive(Debug, Clone, Deserialize)]
pub struct BoneInfo {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(rename = "kind", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub urgency: Option<String>,
}

/// Parse `bn show --format json` output. Returns the bone info.
///
/// # Errors
///
/// Returns `Err` if the JSON cannot be deserialized into a `BoneInfo`.
pub fn parse_bone_show(json: &str) -> Result<BoneInfo, AdapterError> {
    // bn show returns a single object
    serde_json::from_str(json).map_err(|e| AdapterError::ParseFailed {
        tool: "bn show",
        detail: e.to_string(),
    })
}

// --- Seal Reviews ---

/// Parsed output from `seal reviews list --format json`.
#[derive(Debug, Clone, Deserialize)]
pub struct ReviewsListResponse {
    #[serde(default)]
    pub reviews: Vec<ReviewSummary>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewSummary {
    pub review_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub change_id: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
}

/// Parsed output from `seal review <id> --format json`.
#[derive(Debug, Clone, Deserialize)]
pub struct ReviewDetailResponse {
    pub review: ReviewDetail,
    #[serde(default)]
    pub threads: Vec<ReviewThread>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewDetail {
    pub review_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub status_changed_at: Option<String>,
    #[serde(default)]
    pub status_changed_by: Option<String>,
    #[serde(default)]
    pub change_id: Option<String>,
    #[serde(default)]
    pub votes: Vec<ReviewVote>,
    #[serde(default)]
    pub open_thread_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewVote {
    pub reviewer: String,
    pub vote: String,
    #[serde(default)]
    pub voted_at: Option<String>,
}

impl ReviewVote {
    #[must_use]
    pub fn is_lgtm(&self) -> bool {
        self.vote == "lgtm"
    }

    #[must_use]
    pub fn is_block(&self) -> bool {
        self.vote == "block"
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewThread {
    pub thread_id: String,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub comments: Vec<ReviewComment>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReviewComment {
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

// --- Adapter Errors ---

#[derive(Debug, Clone)]
pub enum AdapterError {
    ParseFailed { tool: &'static str, detail: String },
    NotFound { tool: &'static str, detail: String },
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ParseFailed { tool, detail } => {
                write!(f, "failed to parse {tool} output: {detail}")
            }
            Self::NotFound { tool, detail } => {
                write!(f, "{tool}: {detail}")
            }
        }
    }
}

impl std::error::Error for AdapterError {}

// --- Convenience parsers ---

/// Parse `rite claims list --format json`.
///
/// # Errors
///
/// Returns `Err` if the JSON cannot be deserialized into a `ClaimsResponse`.
pub fn parse_claims(json: &str) -> Result<ClaimsResponse, AdapterError> {
    serde_json::from_str(json).map_err(|e| AdapterError::ParseFailed {
        tool: "rite claims list",
        detail: e.to_string(),
    })
}

/// Parse `maw ws list --format json`.
///
/// # Errors
///
/// Returns `Err` if the JSON cannot be deserialized into a `WorkspacesResponse`.
pub fn parse_workspaces(json: &str) -> Result<WorkspacesResponse, AdapterError> {
    serde_json::from_str(json).map_err(|e| AdapterError::ParseFailed {
        tool: "maw ws list",
        detail: e.to_string(),
    })
}

/// Parse `seal reviews list --format json`.
///
/// # Errors
///
/// Returns `Err` if the JSON cannot be deserialized into a `ReviewsListResponse`.
pub fn parse_reviews_list(json: &str) -> Result<ReviewsListResponse, AdapterError> {
    serde_json::from_str(json).map_err(|e| AdapterError::ParseFailed {
        tool: "seal reviews list",
        detail: e.to_string(),
    })
}

/// Parse `seal review <id> --format json`.
///
/// # Errors
///
/// Returns `Err` if the JSON cannot be deserialized into a `ReviewDetailResponse`.
pub fn parse_review_detail(json: &str) -> Result<ReviewDetailResponse, AdapterError> {
    serde_json::from_str(json).map_err(|e| AdapterError::ParseFailed {
        tool: "seal review",
        detail: e.to_string(),
    })
}

/// Parsed output from `seal diff <id> --format json`.
///
/// Only the field the merge gate's commit-freshness check needs — `seal
/// diff` also returns `base_commit`, `changed_files`, `diff`, and thread
/// info, ignored here.
#[derive(Debug, Clone, Deserialize)]
pub struct ReviewDiffSummary {
    #[serde(default)]
    pub target_commit: Option<String>,
    /// Whether the approval still covers the target commit (seal >= 0.28).
    ///
    /// `None` from an older seal, which reports no coverage at all — the
    /// caller then falls back to comparing commits itself.
    #[serde(default)]
    pub approval_stale: Option<bool>,
    /// The commit the approval applied to (seal >= 0.28).
    #[serde(default)]
    pub approved_commit: Option<String>,
    /// Commits in `approved_commit..target_commit` (seal >= 0.28).
    #[serde(default)]
    pub uncovered_commits: Option<usize>,
}

/// Parse `seal diff <id> --format json`.
///
/// # Errors
///
/// Returns `Err` if the JSON cannot be deserialized into a `ReviewDiffSummary`.
pub fn parse_review_diff(json: &str) -> Result<ReviewDiffSummary, AdapterError> {
    serde_json::from_str(json).map_err(|e| AdapterError::ParseFailed {
        tool: "seal diff",
        detail: e.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured verbatim from `seal 0.28.0`: `seal diff <id> --format json`
    /// on a review whose approval was overtaken by a later commit.
    #[test]
    fn parses_seal_028_approval_coverage() {
        let json = r#"{
            "base_commit": "a3dc2ed99f9df2f7d939a2159918befbcf5ba492",
            "target_commit": "75489a943a25c7383be91739bd97110074491d19",
            "base_is_persisted": true,
            "approval_stale": true,
            "approved_commit": "c1e4d22e7e223173747afee739a2e1b96bb27b72",
            "uncovered_commits": 1
        }"#;
        let d = parse_review_diff(json).unwrap();
        assert_eq!(
            d.target_commit.as_deref(),
            Some("75489a943a25c7383be91739bd97110074491d19")
        );
        assert_eq!(d.approval_stale, Some(true));
        assert_eq!(
            d.approved_commit.as_deref(),
            Some("c1e4d22e7e223173747afee739a2e1b96bb27b72")
        );
        assert_eq!(d.uncovered_commits, Some(1));
    }

    /// An older seal reports no coverage at all. The fields must stay absent
    /// rather than defaulting to "fresh", so the gate falls back instead of
    /// assuming an approval covers code it never saw.
    #[test]
    fn older_seal_reports_no_coverage() {
        let d = parse_review_diff(r#"{"target_commit": "abc123"}"#).unwrap();
        assert_eq!(d.target_commit.as_deref(), Some("abc123"));
        assert_eq!(d.approval_stale, None);
        assert_eq!(d.approved_commit, None);
        assert_eq!(d.uncovered_commits, None);
    }

    // --- Claims parsing ---

    #[test]
    fn parse_claims_basic() {
        let json = r#"{"claims": [
            {"agent": "myapp-dev", "patterns": ["bone://myapp/bd-abc"], "active": true, "memo": "bd-abc"},
            {"agent": "myapp-dev", "patterns": ["workspace://myapp/frost-castle"], "active": true}
        ]}"#;
        let resp = parse_claims(json).unwrap();
        assert_eq!(resp.claims.len(), 2);
        assert_eq!(resp.claims[0].agent, "myapp-dev");
        assert_eq!(resp.claims[0].bone_ids(), vec!["bd-abc"]);
        assert_eq!(resp.claims[1].workspace_names(), vec!["frost-castle"]);
    }

    #[test]
    fn parse_claims_empty() {
        let json = r#"{"claims": []}"#;
        let resp = parse_claims(json).unwrap();
        assert!(resp.claims.is_empty());
    }

    #[test]
    fn parse_claims_missing_optional_fields() {
        let json = r#"{"claims": [{"agent": "dev", "patterns": ["bone://p/bd-x"]}]}"#;
        let resp = parse_claims(json).unwrap();
        assert!(!resp.claims[0].active); // defaults to false
        assert!(resp.claims[0].memo.is_none());
        assert!(resp.claims[0].expires_at.is_none());
    }

    #[test]
    fn parse_claims_extra_fields_tolerated() {
        let json = r#"{"claims": [{"agent": "dev", "patterns": [], "some_new_field": 42}]}"#;
        let resp = parse_claims(json).unwrap();
        assert_eq!(resp.claims.len(), 1);
    }

    #[test]
    fn parse_claims_invalid_json() {
        let result = parse_claims("not json");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("rite claims list"));
    }

    // --- Workspace parsing ---

    #[test]
    fn parse_workspaces_basic() {
        let json = r#"{"workspaces": [
            {"name": "default", "is_default": true, "is_current": false, "change_id": "abc123"},
            {"name": "frost-castle", "is_default": false, "is_current": true, "change_id": "def456"}
        ], "advice": []}"#;
        let resp = parse_workspaces(json).unwrap();
        assert_eq!(resp.workspaces.len(), 2);
        assert!(resp.workspaces[0].is_default);
        assert_eq!(resp.workspaces[1].name, "frost-castle");
    }

    #[test]
    fn parse_workspaces_with_advice() {
        let json = r#"{"workspaces": [], "advice": [
            {"level": "warn", "message": "stale workspace detected", "details": "frost-castle"}
        ]}"#;
        let resp = parse_workspaces(json).unwrap();
        assert_eq!(resp.advice.len(), 1);
        assert!(resp.advice[0].message.contains("stale"));
    }

    #[test]
    fn parse_workspaces_missing_advice() {
        let json = r#"{"workspaces": [{"name": "default", "is_default": true}]}"#;
        let resp = parse_workspaces(json).unwrap();
        assert!(resp.advice.is_empty());
    }

    // --- Bone parsing ---

    #[test]
    fn parse_bone_show_basic() {
        let json = r#"{"id": "bd-abc", "title": "Fix login", "state": "doing", "assignees": ["myapp-dev"], "labels": ["bug"]}"#;
        let bone = parse_bone_show(json).unwrap();
        assert_eq!(bone.id, "bd-abc");
        assert_eq!(bone.title, "Fix login");
        assert_eq!(bone.state, "doing");
        assert_eq!(bone.assignees, vec!["myapp-dev"]);
        assert_eq!(bone.labels, vec!["bug"]);
    }

    #[test]
    fn parse_bone_show_minimal() {
        let json = r#"{"id": "bd-abc"}"#;
        let bone = parse_bone_show(json).unwrap();
        assert_eq!(bone.id, "bd-abc");
        assert_eq!(bone.title, "");
        assert_eq!(bone.state, "");
        assert!(bone.assignees.is_empty());
        assert!(bone.labels.is_empty());
    }

    #[test]
    fn parse_bone_show_invalid_json() {
        let result = parse_bone_show("not json");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("bn show"));
    }

    #[test]
    fn parse_bone_show_extra_fields() {
        let json = r#"{"id": "bd-x", "title": "t", "state": "open", "some_future_field": true}"#;
        let bone = parse_bone_show(json).unwrap();
        assert_eq!(bone.id, "bd-x");
    }

    // --- Review parsing ---

    #[test]
    fn parse_reviews_list_basic() {
        let json = r#"{"reviews": [
            {"review_id": "cr-abc", "title": "feat: login", "status": "open", "change_id": "xyz"}
        ]}"#;
        let resp = parse_reviews_list(json).unwrap();
        assert_eq!(resp.reviews.len(), 1);
        assert_eq!(resp.reviews[0].review_id, "cr-abc");
    }

    #[test]
    fn parse_reviews_list_empty() {
        let json = r#"{"reviews": []}"#;
        let resp = parse_reviews_list(json).unwrap();
        assert!(resp.reviews.is_empty());
    }

    #[test]
    fn parse_review_detail_with_votes() {
        let json = r#"{
            "review": {
                "review_id": "cr-abc",
                "status": "reviewed",
                "votes": [
                    {"reviewer": "myapp-security", "vote": "lgtm", "voted_at": "2026-02-16T10:00:00Z"},
                    {"reviewer": "myapp-perf", "vote": "block", "voted_at": "2026-02-16T11:00:00Z"}
                ],
                "open_thread_count": 2
            },
            "threads": [
                {"thread_id": "th-1", "file": "src/main.rs", "line": 42, "resolved": false, "comments": [
                    {"author": "myapp-security", "body": "Missing validation", "created_at": "2026-02-16T10:00:00Z"}
                ]}
            ]
        }"#;
        let resp = parse_review_detail(json).unwrap();
        assert_eq!(resp.review.review_id, "cr-abc");
        assert_eq!(resp.review.votes.len(), 2);
        assert!(resp.review.votes[0].is_lgtm());
        assert!(resp.review.votes[1].is_block());
        assert_eq!(resp.review.open_thread_count, 2);
        assert_eq!(resp.threads.len(), 1);
        assert_eq!(resp.threads[0].comments.len(), 1);
    }

    #[test]
    fn parse_review_detail_minimal() {
        let json = r#"{"review": {"review_id": "cr-x", "status": "open"}, "threads": []}"#;
        let resp = parse_review_detail(json).unwrap();
        assert_eq!(resp.review.review_id, "cr-x");
        assert!(resp.review.votes.is_empty());
        assert_eq!(resp.review.open_thread_count, 0);
    }

    #[test]
    fn parse_review_detail_extra_fields() {
        let json = r#"{"review": {
            "review_id": "cr-x",
            "status": "approved",
            "status_changed_at": "2026-07-04T02:17:16.226852048+00:00",
            "status_changed_by": "myapp-security",
            "new_field": "val"
        }, "threads": []}"#;
        let resp = parse_review_detail(json).unwrap();
        assert_eq!(resp.review.review_id, "cr-x");
        assert_eq!(resp.review.status, "approved");
        assert_eq!(
            resp.review.status_changed_at.as_deref(),
            Some("2026-07-04T02:17:16.226852048+00:00")
        );
        assert_eq!(
            resp.review.status_changed_by.as_deref(),
            Some("myapp-security")
        );
    }

    // --- Review diff parsing ---

    #[test]
    fn parse_review_diff_basic() {
        let json = r#"{
            "review_id": "cr-x",
            "base_commit": "aaa",
            "initial_commit": "bbb",
            "target_commit": "ccc",
            "changed_files": ["a.rs"],
            "diff": "...",
            "thread_count": 0,
            "threads_by_file": []
        }"#;
        let diff = parse_review_diff(json).unwrap();
        assert_eq!(diff.target_commit.as_deref(), Some("ccc"));
    }

    #[test]
    fn parse_review_diff_missing_target_commit() {
        let json = r#"{"review_id": "cr-x"}"#;
        let diff = parse_review_diff(json).unwrap();
        assert_eq!(diff.target_commit, None);
    }

    #[test]
    fn parse_review_diff_invalid_json() {
        let result = parse_review_diff("not json");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("seal diff"));
    }

    // --- Claim helper tests ---

    #[test]
    fn claim_bone_id_extraction() {
        let claim = Claim {
            agent: "dev".into(),
            patterns: vec![
                "bone://myapp/bd-abc".into(),
                "workspace://myapp/ws".into(),
                "agent://myapp-dev".into(),
            ],
            active: true,
            memo: None,
            expires_at: None,
        };
        assert_eq!(claim.bone_ids(), vec!["bd-abc"]);
        assert_eq!(claim.workspace_names(), vec!["ws"]);
    }

    #[test]
    fn claim_no_matching_patterns() {
        let claim = Claim {
            agent: "dev".into(),
            patterns: vec!["agent://myapp-dev".into()],
            active: true,
            memo: None,
            expires_at: None,
        };
        assert!(claim.bone_ids().is_empty());
        assert!(claim.workspace_names().is_empty());
    }
}
