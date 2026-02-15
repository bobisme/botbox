use std::path::Path;

use anyhow::{Context, Result};

use crate::config::Config;
use crate::subprocess::run_command;

/// Run the init-agent hook: display agent identity from .botbox.json
pub fn run_init_agent(project_root: &Path) -> Result<()> {
    let config_path = project_root.join(".botbox.json");

    if config_path.exists() {
        let config = Config::load(&config_path)?;
        let agent = config.default_agent();
        let channel = config.channel();

        println!("Agent ID for use with botbus/crit/br: {agent}");
        println!("Project channel: {channel}");
    } else {
        // Fallback to bus whoami
        let output = run_command("bus", &["whoami", "--suggest-project-suffix=dev"], None)
            .context("running bus whoami")?;

        if let Some(agent_id) = output.trim().lines().next() {
            println!("Agent ID for use with botbus/crit/br: {agent_id}");
        }
    }

    Ok(())
}

/// Run the check-jj hook: remind agent to use jj commands
pub fn run_check_jj(project_root: &Path) -> Result<()> {
    let jj_dir = project_root.join(".jj");

    if jj_dir.exists() || is_jj_repo(project_root) {
        println!("IMPORTANT: This project uses Jujutsu (jj) for version control with GitHub for sharing. Use jj commands instead of git (e.g., `jj status`, `jj describe`, `jj log`). To push to GitHub, use bookmarks and `jj bookmark set <name> -r @` then `jj git push`.");

        if is_maw_repo(project_root) {
            println!("This project uses maw for workspace management. Use `maw ws create <name>` to create isolated workspaces, `maw ws merge <name> --destroy` to merge back to main.");
        }
    }

    Ok(())
}

/// Validates an agent name against `[a-z0-9][a-z0-9-/]*`.
fn validate_agent_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'/')
        && !name.starts_with('-')
        && !name.starts_with('/')
}

/// Run the check-bus-inbox hook: check for unread bus messages
pub fn run_check_bus_inbox(project_root: &Path, _hook_input: Option<&str>) -> Result<()> {
    let config_path = project_root.join(".botbox.json");

    // Read channel from config
    let channel = if config_path.exists() {
        Config::load(&config_path)?.channel()
    } else {
        project_root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    };

    // Get agent identity, validated
    let agent = std::env::var("BOTBUS_AGENT")
        .ok()
        .filter(|a| validate_agent_name(a))
        .or_else(|| {
            if config_path.exists() {
                Config::load(&config_path).ok().map(|c| c.default_agent())
            } else {
                None
            }
        });

    // Build bus inbox command for count check
    let mut count_args = vec!["inbox", "--count-only", "--mentions", "--channels", &channel];
    let agent_flag = agent.as_ref().map(|a| format!("--agent={a}"));
    if let Some(ref flag) = agent_flag {
        count_args.insert(1, flag);
    }

    // Check unread count
    let count_output = run_command("bus", &count_args, None).ok();
    let count: u32 = count_output
        .as_ref()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);

    if count == 0 {
        return Ok(());
    }

    // Fetch messages as JSON
    let mut fetch_args = vec![
        "inbox",
        "--mentions",
        "--channels",
        &channel,
        "--limit-per-channel",
        "5",
        "--format",
        "json",
    ];
    if let Some(ref flag) = agent_flag {
        fetch_args.insert(1, flag);
    }

    let inbox_json = run_command("bus", &fetch_args, None).unwrap_or_default();

    // Parse and build message previews
    let messages = parse_inbox_previews(&inbox_json, agent.as_deref());

    // Build mark-read command
    let mark_read_cmd = if let Some(ref a) = agent {
        format!("bus inbox --agent {a} --mentions --channels {channel} --mark-read")
    } else {
        format!("bus inbox --mentions --channels {channel} --mark-read")
    };

    // Output JSON for PostToolUse hook injection
    let context = format!(
        "STOP: You have {count} unread bus message(s) in #{channel}. Check if any need a response:\n{messages}\n\nTo read and respond: `{mark_read_cmd}`"
    );

    let hook_output = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": context
        }
    });

    println!("{}", serde_json::to_string(&hook_output)?);

    Ok(())
}

/// Run the claim-agent hook: stake/refresh/release agent claim
pub fn run_claim_agent(project_root: &Path, hook_input: Option<&str>) -> Result<()> {
    let agent = match std::env::var("BOTBUS_AGENT") {
        Ok(a) if validate_agent_name(&a) => a,
        _ => return Ok(()), // Silent exit if BOTBUS_AGENT not set or invalid
    };

    let claim_uri = format!("agent://{agent}");
    let claim_ttl = "600";
    let refresh_threshold = 120;

    // Parse hook event from stdin JSON
    let event = hook_input
        .and_then(|input| {
            serde_json::from_str::<serde_json::Value>(input).ok()
        })
        .and_then(|v| v["hook_event_name"].as_str().map(String::from))
        .unwrap_or_default();

    // SessionEnd: release claim and clear status
    if event == "SessionEnd" {
        let _ = run_command(
            "bus",
            &["claims", "release", "--agent", &agent, &claim_uri, "-q"],
            Some(project_root),
        );
        let _ = run_command(
            "bus",
            &["statuses", "clear", "--agent", &agent, "-q"],
            Some(project_root),
        );
        return Ok(());
    }

    // PostToolUse: refresh only if claim is expiring soon
    if event == "PostToolUse" {
        let list_output = run_command(
            "bus",
            &[
                "claims",
                "list",
                "--mine",
                "--agent",
                &agent,
                "--format",
                "json",
            ],
            Some(project_root),
        )
        .ok();

        if let Some(output) = list_output
            && let Ok(data) = serde_json::from_str::<serde_json::Value>(&output)
                && let Some(claims) = data["claims"].as_array() {
                    for claim in claims {
                        if let Some(patterns) = claim["patterns"].as_array()
                            && patterns
                                .iter()
                                .any(|p| p.as_str() == Some(&claim_uri))
                                && let Some(expires_in) = claim["expires_in_secs"].as_i64()
                                    && expires_in < refresh_threshold {
                                        let _ = run_command(
                                            "bus",
                                            &[
                                                "claims",
                                                "refresh",
                                                "--agent",
                                                &agent,
                                                &claim_uri,
                                                "--ttl",
                                                claim_ttl,
                                                "-q",
                                            ],
                                            Some(project_root),
                                        );
                                    }
                    }
                }
        return Ok(());
    }

    // SessionStart / PreCompact / other: stake claim and set status
    let stake_result = run_command(
        "bus",
        &[
            "claims",
            "stake",
            "--agent",
            &agent,
            &claim_uri,
            "--ttl",
            claim_ttl,
            "-q",
        ],
        Some(project_root),
    );

    if stake_result.is_ok() {
        let _ = run_command(
            "bus",
            &["statuses", "set", "--agent", &agent, "Claude Code", "-q"],
            Some(project_root),
        );
    }

    Ok(())
}

// Helper functions

fn is_jj_repo(path: &Path) -> bool {
    run_command("jj", &["status"], Some(path)).is_ok()
}

fn is_maw_repo(path: &Path) -> bool {
    path.join(".maw.toml").exists() || run_command("maw", &["ws", "list"], Some(path)).is_ok()
}

fn parse_inbox_previews(inbox_json: &str, agent: Option<&str>) -> String {
    let data: serde_json::Value = match serde_json::from_str(inbox_json) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };

    let mut previews = Vec::new();

    // Extract messages from JSON (mentions[] or messages[])
    let messages: Vec<&serde_json::Map<String, serde_json::Value>> = if let Some(arr) =
        data["mentions"].as_array()
    {
        arr.iter()
            .filter_map(|m| m["message"].as_object())
            .collect()
    } else if let Some(arr) = data["messages"].as_array() {
        arr.iter().filter_map(|m| m.as_object()).collect()
    } else {
        Vec::new()
    };

    for msg in messages {
            let sender = msg
                .get("agent")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let body = msg.get("body").and_then(|v| v.as_str()).unwrap_or("");

            // Tag messages that @mention this agent
            let tag = if let Some(a) = agent {
                if body.contains(&format!("@{a}")) {
                    "[MENTIONS YOU] "
                } else {
                    ""
                }
            } else {
                ""
            };

            // Build preview and truncate
            let mut preview = format!("{tag}{sender}: {body}");
            if preview.len() > 100 {
                preview.truncate(97);
                preview.push_str("...");
            }

            previews.push(format!("  - {preview}"));
    }

    previews.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_inbox_previews_empty() {
        let json = r#"{"mentions":[]}"#;
        let result = parse_inbox_previews(json, None);
        assert_eq!(result, "");
    }

    #[test]
    fn parse_inbox_previews_with_messages() {
        let json = r#"{
            "mentions": [
                {
                    "message": {
                        "agent": "alice",
                        "body": "Hey @bob, check this out"
                    }
                }
            ]
        }"#;
        let result = parse_inbox_previews(json, Some("bob"));
        assert!(result.contains("[MENTIONS YOU]"));
        assert!(result.contains("alice"));
    }

    #[test]
    fn parse_inbox_previews_truncation() {
        let long_body = "a".repeat(200);
        let json = format!(
            r#"{{"mentions": [{{"message": {{"agent": "sender", "body": "{}"}}}}]}}"#,
            long_body
        );
        let result = parse_inbox_previews(&json, None);
        assert!(result.len() < 150); // Should be truncated
        assert!(result.ends_with("..."));
    }

    #[test]
    fn validate_agent_name_accepts_valid() {
        assert!(validate_agent_name("botbox-dev"));
        assert!(validate_agent_name("botbox-dev/worker-1"));
        assert!(validate_agent_name("a"));
        assert!(validate_agent_name("agent123"));
    }

    #[test]
    fn validate_agent_name_rejects_invalid() {
        assert!(!validate_agent_name(""));
        assert!(!validate_agent_name("-starts-dash"));
        assert!(!validate_agent_name("/starts-slash"));
        assert!(!validate_agent_name("Has Uppercase"));
        assert!(!validate_agent_name("has space"));
        assert!(!validate_agent_name("$(inject)"));
        assert!(!validate_agent_name("--help"));
    }
}
