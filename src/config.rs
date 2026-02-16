use std::path::Path;

use anyhow::Context;
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
    #[serde(default = "default_model_opus")]
    pub model: String,
    #[serde(default = "default_max_loops")]
    pub max_loops: u32,
    #[serde(default = "default_pause")]
    pub pause: u32,
    #[serde(default = "default_timeout_900")]
    pub timeout: u64,
    #[serde(default)]
    pub missions: Option<MissionsConfig>,
    #[serde(default)]
    pub multi_lead: Option<MultiLeadConfig>,
}

impl Default for DevAgentConfig {
    fn default() -> Self {
        Self {
            model: default_model_opus(),
            max_loops: default_max_loops(),
            pause: default_pause(),
            timeout: default_timeout_900(),
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
    #[serde(default = "default_model_haiku")]
    pub model: String,
    #[serde(default = "default_timeout_600")]
    pub timeout: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewerAgentConfig {
    #[serde(default = "default_model_opus")]
    pub model: String,
    #[serde(default = "default_max_loops")]
    pub max_loops: u32,
    #[serde(default = "default_pause")]
    pub pause: u32,
    #[serde(default = "default_timeout_600")]
    pub timeout: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponderAgentConfig {
    #[serde(default = "default_model_sonnet")]
    pub model: String,
    #[serde(default = "default_timeout_300")]
    pub timeout: u64,
    #[serde(default = "default_timeout_300")]
    pub wait_timeout: u64,
    #[serde(default = "default_max_conversations")]
    pub max_conversations: u32,
}

// Default value functions for serde
fn default_model_opus() -> String { "opus".into() }
fn default_model_haiku() -> String { "haiku".into() }
fn default_model_sonnet() -> String { "sonnet".into() }
fn default_max_loops() -> u32 { 20 }
fn default_pause() -> u32 { 2 }
fn default_timeout_300() -> u64 { 300 }
fn default_timeout_600() -> u64 { 600 }
fn default_timeout_900() -> u64 { 900 }
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
        assert_eq!(dev.max_loops, 20); // default
        assert_eq!(dev.pause, 2); // default
        assert_eq!(dev.timeout, 900); // default
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
