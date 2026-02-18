use std::path::Path;

use anyhow::Context;
use rand::seq::IndexedRandom;
use serde::{Deserialize, Serialize};

use crate::error::ExitError;

/// Top-level .botbox.json config.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: String,
    pub project: ProjectConfig,
    #[serde(default)]
    pub tools: ToolsConfig,
    #[serde(default)]
    pub review: ReviewConfig,
    #[serde(default)]
    pub push_main: bool,
    #[serde(default)]
    pub agents: AgentsConfig,
    #[serde(default)]
    pub models: ModelsConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub name: String,
    #[serde(default, rename = "type")]
    pub project_type: Vec<String>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub default_agent: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub install_command: Option<String>,
    #[serde(default)]
    pub check_command: Option<String>,
    #[serde(default)]
    pub critical_approvers: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolsConfig {
    #[serde(default)]
    pub beads: bool,
    #[serde(default)]
    pub maw: bool,
    #[serde(default)]
    pub crit: bool,
    #[serde(default)]
    pub botbus: bool,
    #[serde(default)]
    pub botty: bool,
}

impl ToolsConfig {
    /// Returns a list of enabled tool names
    pub fn enabled_tools(&self) -> Vec<String> {
        let mut tools = Vec::new();
        if self.beads {
            tools.push("beads".to_string());
        }
        if self.maw {
            tools.push("maw".to_string());
        }
        if self.crit {
            tools.push("crit".to_string());
        }
        if self.botbus {
            tools.push("botbus".to_string());
        }
        if self.botty {
            tools.push("botty".to_string());
        }
        tools
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(Default)]
pub struct ReviewConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub reviewers: Vec<String>,
}


/// Model tier configuration for cross-provider load balancing.
///
/// Each tier maps to a list of `provider/model:thinking` strings.
/// When an agent config specifies a tier name (e.g. "fast"), `resolve_model()`
/// randomly picks one model from that tier's pool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelsConfig {
    #[serde(default = "default_tier_fast")]
    pub fast: Vec<String>,
    #[serde(default = "default_tier_balanced")]
    pub balanced: Vec<String>,
    #[serde(default = "default_tier_strong")]
    pub strong: Vec<String>,
}

impl Default for ModelsConfig {
    fn default() -> Self {
        Self {
            fast: default_tier_fast(),
            balanced: default_tier_balanced(),
            strong: default_tier_strong(),
        }
    }
}

fn default_tier_fast() -> Vec<String> {
    vec![
        "anthropic/claude-haiku-4-5:low".into(),
        "google-gemini-cli/gemini-3-flash-preview:low".into(),
        "openai-codex/gpt-5.3-codex-spark:low".into(),
    ]
}

fn default_tier_balanced() -> Vec<String> {
    vec![
        "anthropic/claude-sonnet-4-6:medium".into(),
        "google-gemini-cli/gemini-3-pro-preview:medium".into(),
        "openai-codex/gpt-5.3-codex:medium".into(),
    ]
}

fn default_tier_strong() -> Vec<String> {
    vec![
        "anthropic/claude-opus-4-6:high".into(),
        "openai-codex/gpt-5.3-codex:xhigh".into(),
    ]
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentsConfig {
    #[serde(default)]
    pub dev: Option<DevAgentConfig>,
    #[serde(default)]
    pub worker: Option<WorkerAgentConfig>,
    #[serde(default)]
    pub reviewer: Option<ReviewerAgentConfig>,
    #[serde(default)]
    pub responder: Option<ResponderAgentConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevAgentConfig {
    #[serde(default = "default_model_dev")]
    pub model: String,
    #[serde(default = "default_max_loops")]
    pub max_loops: u32,
    #[serde(default = "default_pause")]
    pub pause: u32,
    #[serde(default = "default_timeout_1800")]
    pub timeout: u64,
    #[serde(default)]
    pub missions: Option<MissionsConfig>,
    #[serde(default)]
    pub multi_lead: Option<MultiLeadConfig>,
}

impl Default for DevAgentConfig {
    fn default() -> Self {
        Self {
            model: default_model_dev(),
            max_loops: default_max_loops(),
            pause: default_pause(),
            timeout: default_timeout_1800(),
            missions: None,
            multi_lead: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionsConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_max_workers")]
    pub max_workers: u32,
    #[serde(default = "default_max_children")]
    pub max_children: u32,
    #[serde(default = "default_checkpoint_interval")]
    pub checkpoint_interval_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiLeadConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_max_leads")]
    pub max_leads: u32,
    #[serde(default = "default_merge_timeout")]
    pub merge_timeout_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerAgentConfig {
    #[serde(default = "default_model_worker")]
    pub model: String,
    #[serde(default = "default_timeout_900")]
    pub timeout: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerAgentConfig {
    #[serde(default = "default_model_reviewer")]
    pub model: String,
    #[serde(default = "default_max_loops")]
    pub max_loops: u32,
    #[serde(default = "default_pause")]
    pub pause: u32,
    #[serde(default = "default_timeout_900")]
    pub timeout: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponderAgentConfig {
    #[serde(default = "default_model_responder")]
    pub model: String,
    #[serde(default = "default_timeout_300")]
    pub timeout: u64,
    #[serde(default = "default_timeout_300")]
    pub wait_timeout: u64,
    #[serde(default = "default_max_conversations")]
    pub max_conversations: u32,
}

// Default value functions for serde
fn default_model_dev() -> String { "opus".into() }
fn default_model_worker() -> String { "balanced".into() }
fn default_model_reviewer() -> String { "strong".into() }
fn default_model_responder() -> String { "balanced".into() }
fn default_max_loops() -> u32 { 100 }
fn default_pause() -> u32 { 2 }
fn default_timeout_300() -> u64 { 300 }
fn default_timeout_900() -> u64 { 900 }
fn default_timeout_1800() -> u64 { 1800 }
fn default_true() -> bool { true }
fn default_max_workers() -> u32 { 4 }
fn default_max_children() -> u32 { 12 }
fn default_checkpoint_interval() -> u64 { 30 }
fn default_max_leads() -> u32 { 3 }
fn default_merge_timeout() -> u64 { 120 }
fn default_max_conversations() -> u32 { 10 }

impl Config {
    /// Load config from a .botbox.json file.
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let contents = std::fs::read_to_string(path)
            .with_context(|| format!("reading {}", path.display()))?;
        Self::parse(&contents)
    }

    /// Parse config from a JSON string.
    pub fn parse(json: &str) -> anyhow::Result<Self> {
        serde_json::from_str(json).map_err(|e| {
            ExitError::Config(format!("invalid .botbox.json: {e}")).into()
        })
    }

    /// Returns the effective agent name (project.defaultAgent or "{name}-dev").
    pub fn default_agent(&self) -> String {
        self.project
            .default_agent
            .clone()
            .unwrap_or_else(|| format!("{}-dev", self.project.name))
    }

    /// Returns the effective channel name (project.channel or project.name).
    pub fn channel(&self) -> String {
        self.project
            .channel
            .clone()
            .unwrap_or_else(|| self.project.name.clone())
    }

    /// Resolve a model string: if it matches a tier name (fast/balanced/strong),
    /// randomly pick from that tier's pool. Otherwise pass through as-is.
    pub fn resolve_model(&self, model: &str) -> String {
        // Legacy short names → specific Anthropic models (deterministic)
        match model {
            "opus" => return "anthropic/claude-opus-4-6:high".to_string(),
            "sonnet" => return "anthropic/claude-sonnet-4-6:medium".to_string(),
            "haiku" => return "anthropic/claude-haiku-4-5:low".to_string(),
            _ => {}
        }

        // Tier names → random pool selection
        let pool = match model {
            "fast" => &self.models.fast,
            "balanced" => &self.models.balanced,
            "strong" => &self.models.strong,
            _ => return model.to_string(),
        };

        if pool.is_empty() {
            return model.to_string();
        }

        let mut rng = rand::rng();
        pool.choose(&mut rng)
            .cloned()
            .unwrap_or_else(|| model.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_full_config() {
        let json = r#"{
            "version": "1.0.16",
            "project": {
                "name": "myapp",
                "type": ["cli"],
                "channel": "myapp",
                "installCommand": "just install",
                "checkCommand": "cargo clippy && cargo test",
                "defaultAgent": "myapp-dev"
            },
            "tools": { "beads": true, "maw": true, "crit": true, "botbus": true, "botty": true },
            "review": { "enabled": true, "reviewers": ["security"] },
            "pushMain": false,
            "agents": {
                "dev": { "model": "opus", "maxLoops": 20, "pause": 2, "timeout": 900 },
                "worker": { "model": "haiku", "timeout": 600 },
                "reviewer": { "model": "opus", "maxLoops": 20, "pause": 2, "timeout": 600 }
            }
        }"#;

        let config = Config::parse(json).unwrap();
        assert_eq!(config.project.name, "myapp");
        assert_eq!(config.default_agent(), "myapp-dev");
        assert_eq!(config.channel(), "myapp");
        assert!(config.tools.beads);
        assert!(config.tools.maw);
        assert!(config.review.enabled);
        assert_eq!(config.review.reviewers, vec!["security"]);
        assert!(!config.push_main);
        assert_eq!(
            config.project.check_command,
            Some("cargo clippy && cargo test".to_string())
        );

        let dev = config.agents.dev.unwrap();
        assert_eq!(dev.model, "opus");
        assert_eq!(dev.max_loops, 20);
        assert_eq!(dev.timeout, 900);

        let worker = config.agents.worker.unwrap();
        assert_eq!(worker.model, "haiku");
        assert_eq!(worker.timeout, 600);
    }

    #[test]
    fn parse_minimal_config() {
        let json = r#"{
            "version": "1.0.0",
            "project": { "name": "test" }
        }"#;

        let config = Config::parse(json).unwrap();
        assert_eq!(config.project.name, "test");
        assert_eq!(config.default_agent(), "test-dev");
        assert_eq!(config.channel(), "test");
        assert!(!config.tools.beads);
        assert!(!config.review.enabled);
        assert!(!config.push_main);
        assert!(config.agents.dev.is_none());
    }

    #[test]
    fn parse_missing_optional_fields() {
        let json = r#"{
            "version": "1.0.0",
            "project": { "name": "bare" },
            "agents": {
                "dev": { "model": "sonnet" }
            }
        }"#;

        let config = Config::parse(json).unwrap();
        let dev = config.agents.dev.unwrap();
        assert_eq!(dev.model, "sonnet");
        assert_eq!(dev.max_loops, 100); // default
        assert_eq!(dev.pause, 2); // default
        assert_eq!(dev.timeout, 1800); // default
    }

    #[test]
    fn resolve_model_tier_names() {
        let config = Config::parse(r#"{
            "version": "1.0.0",
            "project": { "name": "test" }
        }"#).unwrap();

        // Tier names should resolve to something from the pool
        let fast = config.resolve_model("fast");
        assert!(fast.contains('/'), "fast tier should resolve to provider/model, got: {fast}");

        let balanced = config.resolve_model("balanced");
        assert!(balanced.contains('/'), "balanced tier should resolve to provider/model, got: {balanced}");

        let strong = config.resolve_model("strong");
        assert!(strong.contains('/'), "strong tier should resolve to provider/model, got: {strong}");
    }

    #[test]
    fn resolve_model_passthrough() {
        let config = Config::parse(r#"{
            "version": "1.0.0",
            "project": { "name": "test" }
        }"#).unwrap();

        // Explicit provider/model strings pass through unchanged
        assert_eq!(config.resolve_model("anthropic/claude-sonnet-4-6:medium"), "anthropic/claude-sonnet-4-6:medium");
        assert_eq!(config.resolve_model("some-unknown-model"), "some-unknown-model");

        // Legacy short names resolve to specific Anthropic models (deterministic)
        assert_eq!(config.resolve_model("opus"), "anthropic/claude-opus-4-6:high");
        assert_eq!(config.resolve_model("sonnet"), "anthropic/claude-sonnet-4-6:medium");
        assert_eq!(config.resolve_model("haiku"), "anthropic/claude-haiku-4-5:low");
    }

    #[test]
    fn resolve_model_custom_tiers() {
        let config = Config::parse(r#"{
            "version": "1.0.0",
            "project": { "name": "test" },
            "models": {
                "fast": ["custom/model-a"],
                "balanced": ["custom/model-b"],
                "strong": ["custom/model-c"]
            }
        }"#).unwrap();

        // Single-element pools always resolve to that element
        assert_eq!(config.resolve_model("fast"), "custom/model-a");
        assert_eq!(config.resolve_model("balanced"), "custom/model-b");
        assert_eq!(config.resolve_model("strong"), "custom/model-c");
    }

    #[test]
    fn default_model_tiers() {
        let config = Config::parse(r#"{
            "version": "1.0.0",
            "project": { "name": "test" }
        }"#).unwrap();

        // Default tiers should have entries
        assert!(!config.models.fast.is_empty());
        assert!(!config.models.balanced.is_empty());
        assert!(!config.models.strong.is_empty());
    }

    #[test]
    fn parse_malformed_json() {
        let result = Config::parse("not json");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("invalid .botbox.json"));
    }

    #[test]
    fn parse_missing_required_fields() {
        let json = r#"{ "version": "1.0.0" }"#;
        let result = Config::parse(json);
        assert!(result.is_err());
    }
}
