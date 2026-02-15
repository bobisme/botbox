use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::Subcommand;
use serde_json::json;

use crate::config::Config;
use crate::error::ExitError;
use crate::hooks::HookRegistry;
use crate::subprocess::run_command;

#[derive(Debug, Subcommand)]
pub enum HooksCommand {
    /// Install/update botbus and Claude Code hooks
    Install {
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
    },
    /// Audit hook registrations and report issues
    Audit {
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
        /// Output format
        #[arg(long, value_enum, default_value_t = super::doctor::OutputFormat::Pretty)]
        format: super::doctor::OutputFormat,
    },
    /// Run a hook directly (for Claude Code hooks)
    Run {
        /// Hook name (init-agent, check-jj, check-bus-inbox, claim-agent)
        hook_name: String,
        /// Project root directory
        #[arg(long)]
        project_root: Option<PathBuf>,
    },
}

impl HooksCommand {
    pub fn execute(&self) -> anyhow::Result<()> {
        match self {
            HooksCommand::Install { project_root } => install_hooks(project_root.as_deref()),
            HooksCommand::Audit { project_root, format } => {
                audit_hooks(project_root.as_deref(), *format)
            }
            HooksCommand::Run {
                hook_name,
                project_root,
            } => run_hook(hook_name, project_root.as_deref()),
        }
    }
}

fn install_hooks(project_root: Option<&Path>) -> Result<()> {
    let root = resolve_project_root(project_root)?;
    let config = load_config(&root)?;

    // Get eligible hooks
    let eligible = HookRegistry::eligible(&config.tools);
    if eligible.is_empty() {
        println!("No hooks eligible (no companion tools enabled)");
        return Ok(());
    }

    // Generate settings.json for Claude Code hooks
    let settings_path = root.join(".claude").join("settings.json");
    generate_settings_json(&settings_path, &root, &eligible)?;
    println!("Generated {}", settings_path.display());

    // Register botbus hooks (router + reviewers)
    register_botbus_hooks(&root, &config)?;

    println!("Hooks installed successfully");
    Ok(())
}

fn audit_hooks(project_root: Option<&Path>, format: super::doctor::OutputFormat) -> Result<()> {
    let root = resolve_project_root(project_root)?;
    let config = load_config(&root)?;

    let mut issues = Vec::new();

    // Check settings.json
    let settings_path = root.join(".claude").join("settings.json");
    if !settings_path.exists() {
        issues.push("Missing .claude/settings.json".to_string());
    } else {
        // Parse and verify hooks
        let content = fs::read_to_string(&settings_path)
            .with_context(|| format!("reading {}", settings_path.display()))?;
        let settings: serde_json::Value = serde_json::from_str(&content)
            .with_context(|| format!("parsing {}", settings_path.display()))?;

        let eligible = HookRegistry::eligible(&config.tools);
        for hook_entry in &eligible {
            let found = hook_entry.events.iter().any(|event| {
                settings["hooks"][event.as_str()]
                    .as_array()
                    .map(|arr| {
                        arr.iter().any(|entry| {
                            entry["hooks"]
                                .as_array()
                                .map(|hooks| {
                                    hooks.iter().any(|h| {
                                        // Check both string and array command formats
                                        // String format: "botbox hooks run init-agent --project-root ..."
                                        // Array format: ["botbox", "hooks", "run", "init-agent", "--project-root", ...]
                                        let cmd_value = &h["command"];

                                        if let Some(cmd_str) = cmd_value.as_str() {
                                            // String format check
                                            cmd_str.contains(&format!("run {}", hook_entry.name))
                                        } else if let Some(cmd_arr) = cmd_value.as_array() {
                                            // Array format check - look for ["botbox", "hooks", "run", "<hook_name>", ...]
                                            cmd_arr.len() >= 4
                                                && cmd_arr[0].as_str() == Some("botbox")
                                                && cmd_arr[1].as_str() == Some("hooks")
                                                && cmd_arr[2].as_str() == Some("run")
                                                && cmd_arr[3].as_str() == Some(hook_entry.name)
                                        } else {
                                            false
                                        }
                                    })
                                })
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            });

            if !found {
                issues.push(format!(
                    "Hook '{}' not registered in settings.json",
                    hook_entry.name
                ));
            }
        }
    }

    // Check botbus hooks (if botbus enabled)
    if config.tools.botbus {
        check_botbus_hooks(&root, &config, &mut issues)?;
    }

    // Output results
    match format {
        super::doctor::OutputFormat::Json => {
            let result = json!({
                "issues": issues,
                "status": if issues.is_empty() { "ok" } else { "issues_found" }
            });
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        super::doctor::OutputFormat::Pretty | super::doctor::OutputFormat::Text => {
            if issues.is_empty() {
                println!("✓ All hooks configured correctly");
            } else {
                eprintln!("Hook audit found {} issue(s):", issues.len());
                for issue in &issues {
                    eprintln!("  - {issue}");
                }
                return Err(ExitError::AuditFailed.into());
            }
        }
    }

    Ok(())
}

fn run_hook(hook_name: &str, project_root: Option<&Path>) -> Result<()> {
    // For hook run, resolve_project_root checks .botbox.json — but hooks
    // may run before init. Use a simpler resolution that just canonicalizes.
    let root = match project_root {
        Some(p) => p
            .canonicalize()
            .with_context(|| format!("resolving project root: {}", p.display()))?,
        None => std::env::current_dir().expect("get cwd"),
    };

    // Read stdin with a size limit (64KB) for defense-in-depth
    let stdin_input = {
        use std::io::Read;
        let mut buf = String::new();
        let mut handle = std::io::stdin().take(64 * 1024);
        handle.read_to_string(&mut buf).ok();
        if buf.is_empty() { None } else { Some(buf) }
    };

    match hook_name {
        "init-agent" => crate::hooks::run_init_agent(&root),
        "check-jj" => crate::hooks::run_check_jj(&root),
        "check-bus-inbox" => crate::hooks::run_check_bus_inbox(&root, stdin_input.as_deref()),
        "claim-agent" => crate::hooks::run_claim_agent(&root, stdin_input.as_deref()),
        _ => Err(ExitError::Config(format!("unknown hook: {hook_name}")).into()),
    }
}

// Helper functions

fn resolve_project_root(project_root: Option<&Path>) -> Result<PathBuf> {
    let path = project_root
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::env::current_dir().expect("get cwd"));
    let canonical = path
        .canonicalize()
        .with_context(|| format!("resolving project root: {}", path.display()))?;
    // Check .botbox.json at root, then ws/default/ (maw v2 bare repo)
    if canonical.join(".botbox.json").exists() {
        return Ok(canonical);
    }
    let ws_default = canonical.join("ws/default");
    if ws_default.join(".botbox.json").exists() {
        return Ok(ws_default);
    }
    anyhow::bail!(
        "no .botbox.json found at {} or ws/default/ — is this a botbox project?",
        canonical.display()
    );
}

fn load_config(root: &Path) -> Result<Config> {
    let config_path = root.join(".botbox.json");
    if config_path.exists() {
        return Config::load(&config_path);
    }
    let ws_default_path = root.join("ws/default/.botbox.json");
    if ws_default_path.exists() {
        return Config::load(&ws_default_path);
    }
    Err(ExitError::Config("no .botbox.json found".into()).into())
}

fn generate_settings_json(
    settings_path: &Path,
    project_root: &Path,
    eligible_hooks: &[crate::hooks::HookEntry],
) -> Result<()> {
    // Build hooks config
    let mut hooks_config: HashMap<String, Vec<serde_json::Value>> = HashMap::new();

    for hook_entry in eligible_hooks {
        for event in hook_entry.events.iter() {
            let event_str = event.as_str();
            let hook_command = format!(
                "botbox hooks run {} --project-root {}",
                hook_entry.name,
                project_root.display()
            );

            let entry = json!({
                "matcher": "",
                "hooks": [
                    {
                        "type": "command",
                        "command": hook_command
                    }
                ]
            });

            hooks_config
                .entry(event_str.to_string())
                .or_default()
                .push(entry);
        }
    }

    // Load existing settings or create new
    let mut settings = if settings_path.exists() {
        let content = fs::read_to_string(settings_path)
            .with_context(|| format!("reading {}", settings_path.display()))?;
        serde_json::from_str::<serde_json::Value>(&content).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };

    // Merge hooks config per-event, preserving non-botbox hooks
    let existing_hooks = settings
        .get("hooks")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut merged_hooks = existing_hooks.as_object().cloned().unwrap_or_default();

    for (event, new_entries) in &hooks_config {
        // Get existing entries for this event, filtering out botbox-managed ones
        let existing_entries: Vec<serde_json::Value> = merged_hooks
            .get(event)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|entry| {
                        // Keep entries that are NOT botbox-managed
                        !entry["hooks"]
                            .as_array()
                            .map(|hooks| {
                                hooks.iter().any(|h| {
                                    h["command"]
                                        .as_str()
                                        .map(|cmd| cmd.contains("botbox hooks run"))
                                        .unwrap_or(false)
                                })
                            })
                            .unwrap_or(false)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();

        // Combine: non-botbox entries + new botbox entries
        let mut combined = existing_entries;
        combined.extend(new_entries.iter().cloned());
        merged_hooks.insert(event.clone(), serde_json::Value::Array(combined));
    }

    settings["hooks"] = serde_json::Value::Object(merged_hooks);

    // Ensure parent directory exists
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }

    // Write settings.json
    fs::write(settings_path, serde_json::to_string_pretty(&settings)?)
        .with_context(|| format!("writing {}", settings_path.display()))?;

    Ok(())
}

/// Validates a name against `[a-z0-9][a-z0-9-]*` to prevent shell injection.
fn validate_name(name: &str, label: &str) -> Result<()> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || name.starts_with('-')
    {
        anyhow::bail!(
            "invalid {label} {name:?}: must match [a-z0-9][a-z0-9-]*"
        );
    }
    Ok(())
}

fn register_botbus_hooks(root: &Path, config: &Config) -> Result<()> {
    if !config.tools.botbus {
        return Ok(());
    }

    let channel = config.channel();
    let project_name = &config.project.name;
    let agent = config.default_agent();

    // Validate names before using them in commands
    validate_name(project_name, "project name")?;
    validate_name(&channel, "channel name")?;
    for reviewer in &config.review.reviewers {
        validate_name(reviewer, "reviewer name")?;
    }

    let env_inherit = "BOTBUS_CHANNEL,BOTBUS_MESSAGE_ID,BOTBUS_HOOK_ID,SSH_AUTH_SOCK";
    let root_str = root.display().to_string();

    // Register router hook (claim-based)
    let router_claim = format!("agent://{project_name}-router");
    let spawn_name = format!("{project_name}-router");
    let description = format!("botbox:{project_name}:responder");

    match crate::subprocess::ensure_bus_hook(
        &description,
        &[
            "--agent", &agent,
            "--channel", &channel,
            "--claim", &router_claim,
            "--claim-owner", &agent,
            "--cwd", &root_str,
            "--ttl", "600",
            "--",
            "botty", "spawn",
            "--env-inherit", env_inherit,
            "--name", &spawn_name,
            "--cwd", &root_str,
            "--",
            "botbox", "run", "responder",
        ],
    ) {
        Ok((action, _)) => println!("Router hook {action} for #{channel}"),
        Err(e) => eprintln!("Warning: failed to register router hook: {e}"),
    }

    // Register reviewer hooks (mention-based)
    for reviewer in &config.review.reviewers {
        let reviewer_agent = format!("{project_name}-{reviewer}");
        let claim_uri = format!("agent://{reviewer_agent}");
        let desc = format!("botbox:{project_name}:reviewer-{reviewer}");

        match crate::subprocess::ensure_bus_hook(
            &desc,
            &[
                "--agent", &agent,
                "--channel", &channel,
                "--mention", &reviewer_agent,
                "--claim", &claim_uri,
                "--claim-owner", &reviewer_agent,
                "--ttl", "600",
                "--priority", "1",
                "--cwd", &root_str,
                "--",
                "botty", "spawn",
                "--env-inherit", env_inherit,
                "--name", &reviewer_agent,
                "--cwd", &root_str,
                "--",
                "botbox", "run", "reviewer-loop",
                "--agent", &reviewer_agent,
            ],
        ) {
            Ok((action, _)) => println!("Reviewer hook for @{reviewer_agent} {action}"),
            Err(e) => eprintln!("Warning: failed to register reviewer hook for @{reviewer_agent}: {e}"),
        }
    }

    Ok(())
}

fn check_botbus_hooks(root: &Path, config: &Config, issues: &mut Vec<String>) -> Result<()> {
    let output = run_command("bus", &["hooks", "list", "--format", "json"], Some(root));

    let hooks_data = match output {
        Ok(json) => serde_json::from_str::<serde_json::Value>(&json).ok(),
        Err(_) => None,
    };

    if hooks_data.is_none() {
        issues.push("Failed to fetch botbus hooks".to_string());
        return Ok(());
    }

    let hooks_data = hooks_data.unwrap();
    let empty_vec = vec![];
    let hooks = hooks_data["hooks"].as_array().unwrap_or(&empty_vec);

    // Check router hook
    let router_claim = format!("agent://{}-router", config.project.name);
    let has_router = hooks.iter().any(|h| {
        h["condition"]["claim"]
            .as_str()
            .map(|c| c == router_claim)
            .unwrap_or(false)
    });

    if !has_router {
        issues.push(format!("Missing botbus router hook (claim: {router_claim})"));
    }

    // Check reviewer hooks
    for reviewer in &config.review.reviewers {
        let mention_name = format!("{}-{reviewer}", config.project.name);
        let has_reviewer = hooks.iter().any(|h| {
            h["condition"]["mention"]
                .as_str()
                .map(|m| m == mention_name)
                .unwrap_or(false)
        });

        if !has_reviewer {
            issues.push(format!(
                "Missing botbus reviewer hook for @{mention_name}"
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_name_accepts_valid() {
        assert!(validate_name("botbox", "test").is_ok());
        assert!(validate_name("my-project", "test").is_ok());
        assert!(validate_name("a", "test").is_ok());
        assert!(validate_name("project123", "test").is_ok());
    }

    #[test]
    fn validate_name_rejects_invalid() {
        assert!(validate_name("", "test").is_err());
        assert!(validate_name("-starts-dash", "test").is_err());
        assert!(validate_name("Has Uppercase", "test").is_err());
        assert!(validate_name("has space", "test").is_err());
        assert!(validate_name("$(inject)", "test").is_err());
        assert!(validate_name("; rm -rf /", "test").is_err());
        assert!(validate_name("name\nwith\nnewlines", "test").is_err());
    }

    #[test]
    fn settings_json_merge_preserves_non_botbox_hooks() {
        let existing = json!({
            "hooks": {
                "SessionStart": [
                    {
                        "matcher": "",
                        "hooks": [{"type": "command", "command": "my-custom-hook"}]
                    },
                    {
                        "matcher": "",
                        "hooks": [{"type": "command", "command": "botbox hooks run init-agent --project-root /tmp"}]
                    }
                ]
            },
            "other_setting": true
        });

        // Simulate the merge logic
        let hooks_config: HashMap<String, Vec<serde_json::Value>> = {
            let mut m = HashMap::new();
            m.insert(
                "SessionStart".to_string(),
                vec![json!({
                    "matcher": "",
                    "hooks": [{"type": "command", "command": "botbox hooks run init-agent --project-root /new"}]
                })],
            );
            m
        };

        let existing_hooks = existing.get("hooks").cloned().unwrap_or_else(|| json!({}));
        let mut merged_hooks = existing_hooks.as_object().cloned().unwrap_or_default();

        for (event, new_entries) in &hooks_config {
            let existing_entries: Vec<serde_json::Value> = merged_hooks
                .get(event)
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter(|entry| {
                            !entry["hooks"]
                                .as_array()
                                .map(|hooks| {
                                    hooks.iter().any(|h| {
                                        h["command"]
                                            .as_str()
                                            .map(|cmd| cmd.contains("botbox hooks run"))
                                            .unwrap_or(false)
                                    })
                                })
                                .unwrap_or(false)
                        })
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();

            let mut combined = existing_entries;
            combined.extend(new_entries.iter().cloned());
            merged_hooks.insert(event.clone(), serde_json::Value::Array(combined));
        }

        let result = serde_json::Value::Object(merged_hooks);
        let session_start = result["SessionStart"].as_array().unwrap();

        // Should have 2 entries: the custom one + the new botbox one
        assert_eq!(session_start.len(), 2);
        // First should be the custom hook (preserved)
        assert_eq!(
            session_start[0]["hooks"][0]["command"].as_str().unwrap(),
            "my-custom-hook"
        );
        // Second should be the new botbox hook
        assert!(session_start[1]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("botbox hooks run"));
    }
}
