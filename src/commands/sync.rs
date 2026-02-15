use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::Args;
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::error::ExitError;
use crate::subprocess::{run_command, Tool};
use crate::template::{update_managed_section, TemplateContext};

#[derive(Debug, Args)]
pub struct SyncArgs {
    /// Project root directory
    #[arg(long)]
    pub project_root: Option<PathBuf>,
    /// Check mode: exit non-zero if anything is stale, without making changes
    #[arg(long)]
    pub check: bool,
    /// Disable auto-commit (default: enabled)
    #[arg(long)]
    pub no_commit: bool,
}

/// Embedded workflow docs
pub(crate) const WORKFLOW_DOCS: &[(&str, &str)] = &[
    ("triage.md", include_str!("../templates/docs/triage.md")),
    ("start.md", include_str!("../templates/docs/start.md")),
    ("update.md", include_str!("../templates/docs/update.md")),
    ("finish.md", include_str!("../templates/docs/finish.md")),
    (
        "worker-loop.md",
        include_str!("../templates/docs/worker-loop.md"),
    ),
    ("planning.md", include_str!("../templates/docs/planning.md")),
    ("scout.md", include_str!("../templates/docs/scout.md")),
    ("proposal.md", include_str!("../templates/docs/proposal.md")),
    (
        "review-request.md",
        include_str!("../templates/docs/review-request.md"),
    ),
    (
        "review-response.md",
        include_str!("../templates/docs/review-response.md"),
    ),
    (
        "review-loop.md",
        include_str!("../templates/docs/review-loop.md"),
    ),
    (
        "merge-check.md",
        include_str!("../templates/docs/merge-check.md"),
    ),
    (
        "preflight.md",
        include_str!("../templates/docs/preflight.md"),
    ),
    (
        "cross-channel.md",
        include_str!("../templates/docs/cross-channel.md"),
    ),
    (
        "report-issue.md",
        include_str!("../templates/docs/report-issue.md"),
    ),
    ("groom.md", include_str!("../templates/docs/groom.md")),
    ("mission.md", include_str!("../templates/docs/mission.md")),
    (
        "coordination.md",
        include_str!("../templates/docs/coordination.md"),
    ),
];

/// Embedded design docs
pub(crate) const DESIGN_DOCS: &[(&str, &str)] = &[(
    "cli-conventions.md",
    include_str!("../templates/design/cli-conventions.md"),
)];

/// Embedded reviewer prompts
pub(crate) const REVIEWER_PROMPTS: &[(&str, &str)] = &[
    ("reviewer.md", include_str!("../templates/reviewer.md.jinja")),
    (
        "reviewer-security.md",
        include_str!("../templates/reviewer-security.md.jinja"),
    ),
];

impl SyncArgs {
    pub fn execute(&self) -> Result<()> {
        let project_root = self
            .project_root
            .clone()
            .unwrap_or_else(|| std::env::current_dir().expect("Failed to get current dir"));

        // Detect maw v2 bare repo
        let bare_config_path = project_root.join("ws/default/.botbox.json");
        if bare_config_path.exists() {
            return self.handle_bare_repo(&project_root);
        }

        let agents_dir = project_root.join(".agents/botbox");
        if !agents_dir.exists() {
            return Err(ExitError::Other(
                "No .agents/botbox/ found. Run `botbox init` first.".to_string(),
            )
            .into());
        }

        // Load config
        let config_path = project_root.join(".botbox.json");
        let config = if config_path.exists() {
            let content = fs::read_to_string(&config_path)
                .with_context(|| format!("Failed to read {}", config_path.display()))?;
            serde_json::from_str::<Config>(&content)
                .with_context(|| format!("Failed to parse {}", config_path.display()))?
        } else {
            return Err(ExitError::Config("No .botbox.json found".to_string()).into());
        };

        // Check staleness for each component
        let docs_stale = self.check_docs_staleness(&agents_dir)?;
        let managed_stale = self.check_managed_section_staleness(&project_root, &config)?;
        let prompts_stale = self.check_prompts_staleness(&agents_dir)?;
        let hooks_stale = self.check_hooks_staleness(&agents_dir)?;
        let design_docs_stale = self.check_design_docs_staleness(&agents_dir)?;

        let any_stale =
            docs_stale || managed_stale || prompts_stale || hooks_stale || design_docs_stale;

        if self.check {
            if any_stale {
                let mut parts = Vec::new();
                if docs_stale {
                    parts.push("workflow docs");
                }
                if managed_stale {
                    parts.push("AGENTS.md managed section");
                }
                if prompts_stale {
                    parts.push("reviewer prompts");
                }
                if hooks_stale {
                    parts.push("Claude Code hooks config");
                }
                if design_docs_stale {
                    parts.push("design docs");
                }
                eprintln!("Stale components: {}", parts.join(", "));
                return Err(ExitError::new(1, "Project is out of sync".to_string()).into());
            } else {
                println!("All components up to date");
                return Ok(());
            }
        }

        // Perform updates
        let mut changed_files = Vec::new();

        if docs_stale {
            self.sync_workflow_docs(&agents_dir)?;
            changed_files.push(".agents/botbox/*.md");
            println!("Updated workflow docs");
        }

        if managed_stale {
            self.sync_managed_section(&project_root, &config)?;
            changed_files.push("AGENTS.md");
            println!("Updated AGENTS.md managed section");
        }

        if prompts_stale {
            self.sync_prompts(&agents_dir)?;
            changed_files.push(".agents/botbox/prompts/*.md");
            println!("Updated reviewer prompts");
        }

        if hooks_stale {
            self.sync_hooks(&project_root, &agents_dir)?;
            changed_files.push(".claude/settings.json");
            println!("Updated Claude Code hooks config");
        }

        if design_docs_stale {
            self.sync_design_docs(&agents_dir)?;
            changed_files.push(".agents/botbox/design/*.md");
            println!("Updated design docs");
        }

        // Clean up legacy JS artifacts (scripts, shell hooks)
        self.cleanup_legacy_artifacts(&agents_dir, &mut changed_files);

        // Migrate bus hooks from bun .mjs to botbox run
        migrate_bus_hooks(&config);

        // Auto-commit if changes were made
        if !changed_files.is_empty() && !self.no_commit {
            self.auto_commit(&project_root, &changed_files)?;
        }

        println!("Sync complete");
        Ok(())
    }

    fn handle_bare_repo(&self, project_root: &Path) -> Result<()> {
        // Canonicalize project_root to prevent path traversal
        let project_root = project_root.canonicalize()
            .context("canonicalizing project root")?;

        // Validate this is actually a botbox project
        if !project_root.join(".botbox.json").exists() && !project_root.join("ws/default/.botbox.json").exists() {
            anyhow::bail!("not a botbox project: .botbox.json not found in {}", project_root.display());
        }

        let mut args = vec!["exec", "default", "--", "botbox", "sync"];
        if self.check {
            args.push("--check");
        }
        if self.no_commit {
            args.push("--no-commit");
        }

        run_command("maw", &args, Some(&project_root))?;

        // Create stubs at bare root
        let stub_agents = project_root.join("AGENTS.md");
        let stub_claude = project_root.join("CLAUDE.md");
        let stub_content = "**Do not edit the root AGENTS.md or CLAUDE.md for memories or instructions. Use the AGENTS.md in ws/default/.**\n@ws/default/AGENTS.md\n";

        if !stub_agents.exists() {
            fs::write(&stub_agents, stub_content)?;
            println!("Created bare-root AGENTS.md stub");
        }

        if !stub_claude.exists() {
            #[cfg(unix)]
            std::os::unix::fs::symlink("AGENTS.md", &stub_claude)?;
            #[cfg(windows)]
            std::os::windows::fs::symlink_file("AGENTS.md", &stub_claude)?;
            println!("Symlinked bare-root CLAUDE.md → AGENTS.md");
        }

        // Symlink .claude directory — use atomic approach to avoid TOCTOU
        let root_claude_dir = project_root.join(".claude");
        let ws_claude_dir = project_root.join("ws/default/.claude");

        if ws_claude_dir.exists() {
            // Check if already a correct symlink
            let needs_symlink = match fs::read_link(&root_claude_dir) {
                Ok(target) => target != Path::new("ws/default/.claude"),
                Err(_) => true,
            };

            if needs_symlink {
                // Use atomic rename pattern: create temp symlink, then rename over target
                let tmp_link = project_root.join(".claude.tmp");
                let _ = fs::remove_file(&tmp_link); // clean up any stale temp
                #[cfg(unix)]
                std::os::unix::fs::symlink("ws/default/.claude", &tmp_link)?;
                #[cfg(windows)]
                std::os::windows::fs::symlink_dir("ws/default/.claude", &tmp_link)?;

                // Atomic rename (on same filesystem)
                if let Err(e) = fs::rename(&tmp_link, &root_claude_dir) {
                    let _ = fs::remove_file(&tmp_link);
                    return Err(e).context("creating .claude symlink");
                }
                println!("Symlinked .claude → ws/default/.claude");
            }
        }

        Ok(())
    }

    /// Remove legacy JS-era artifacts that are no longer needed.
    /// The Rust rewrite builds loops into the binary, so .mjs scripts and
    /// shell hook wrappers are dead weight.
    fn cleanup_legacy_artifacts(&self, agents_dir: &Path, changed_files: &mut Vec<&str>) {
        // Remove .agents/botbox/scripts/ (JS loop scripts)
        let scripts_dir = agents_dir.join("scripts");
        if scripts_dir.is_dir() {
            if self.check {
                eprintln!("Legacy scripts/ directory exists (will be removed on sync)");
            } else {
                match fs::remove_dir_all(&scripts_dir) {
                    Ok(_) => {
                        println!("Removed legacy scripts/ directory");
                        changed_files.push(".agents/botbox/scripts/");
                    }
                    Err(e) => eprintln!("Warning: failed to remove legacy scripts/: {e}"),
                }
            }
        }

        // Remove .agents/botbox/hooks/ (shell hook scripts — now built into botbox binary)
        let hooks_dir = agents_dir.join("hooks");
        if hooks_dir.is_dir() {
            if self.check {
                eprintln!("Legacy hooks/ directory exists (will be removed on sync)");
            } else {
                match fs::remove_dir_all(&hooks_dir) {
                    Ok(_) => {
                        println!("Removed legacy hooks/ directory");
                        changed_files.push(".agents/botbox/hooks/");
                    }
                    Err(e) => eprintln!("Warning: failed to remove legacy hooks/: {e}"),
                }
            }
        }

        // Remove stale version markers from JS era
        for marker in &[".scripts-version", ".hooks-version"] {
            let path = agents_dir.join(marker);
            if path.exists() && !self.check {
                let _ = fs::remove_file(&path);
            }
        }
    }

    fn check_docs_staleness(&self, agents_dir: &Path) -> Result<bool> {
        let version_file = agents_dir.join(".version");
        let current = compute_docs_version();

        if !version_file.exists() {
            return Ok(true);
        }

        let installed = fs::read_to_string(&version_file)?.trim().to_string();
        Ok(installed != current)
    }

    fn check_managed_section_staleness(&self, project_root: &Path, config: &Config) -> Result<bool> {
        let agents_md = project_root.join("AGENTS.md");
        if !agents_md.exists() {
            return Ok(false); // No AGENTS.md to update
        }

        let content = fs::read_to_string(&agents_md)?;
        let ctx = TemplateContext::from_config(config);
        let updated = update_managed_section(&content, &ctx)?;

        Ok(content != updated)
    }

    fn check_prompts_staleness(&self, agents_dir: &Path) -> Result<bool> {
        let version_file = agents_dir.join("prompts/.prompts-version");
        let current = compute_prompts_version();

        if !version_file.exists() {
            return Ok(true);
        }

        let installed = fs::read_to_string(&version_file)?.trim().to_string();
        Ok(installed != current)
    }

    fn check_hooks_staleness(&self, _agents_dir: &Path) -> Result<bool> {
        // For now, hooks are always considered fresh since we don't have shell scripts
        // In the future, this will check .claude/settings.json hash
        Ok(false)
    }

    fn check_design_docs_staleness(&self, agents_dir: &Path) -> Result<bool> {
        let version_file = agents_dir.join("design/.design-docs-version");
        let current = compute_design_docs_version();

        if !version_file.exists() {
            return Ok(true);
        }

        let installed = fs::read_to_string(&version_file)?.trim().to_string();
        Ok(installed != current)
    }

    fn sync_workflow_docs(&self, agents_dir: &Path) -> Result<()> {
        for (name, content) in WORKFLOW_DOCS {
            let path = agents_dir.join(name);
            fs::write(&path, content)
                .with_context(|| format!("Failed to write {}", path.display()))?;
        }

        let version = compute_docs_version();
        fs::write(agents_dir.join(".version"), version)?;

        Ok(())
    }

    fn sync_managed_section(&self, project_root: &Path, config: &Config) -> Result<()> {
        let agents_md = project_root.join("AGENTS.md");
        if !agents_md.exists() {
            return Ok(()); // Skip if no AGENTS.md
        }

        let content = fs::read_to_string(&agents_md)?;
        let ctx = TemplateContext::from_config(config);
        let updated = update_managed_section(&content, &ctx)?;

        fs::write(&agents_md, updated)?;
        Ok(())
    }

    fn sync_prompts(&self, agents_dir: &Path) -> Result<()> {
        let prompts_dir = agents_dir.join("prompts");
        fs::create_dir_all(&prompts_dir)?;

        for (name, content) in REVIEWER_PROMPTS {
            let path = prompts_dir.join(name);
            fs::write(&path, content)
                .with_context(|| format!("Failed to write {}", path.display()))?;
        }

        let version = compute_prompts_version();
        fs::write(prompts_dir.join(".prompts-version"), version)?;

        Ok(())
    }

    fn sync_hooks(&self, project_root: &Path, _agents_dir: &Path) -> Result<()> {
        // Generate .claude/settings.json with hook commands
        // Merge with existing settings to preserve non-botbox hooks
        let claude_dir = project_root.join(".claude");
        fs::create_dir_all(&claude_dir)?;

        let settings_path = claude_dir.join("settings.json");
        let project_root_str = project_root.display().to_string();

        // Use command arrays (not shell strings) to prevent command injection
        let botbox_hooks = serde_json::json!({
            "hooks": {
                "SessionStart": [{
                    "matcher": "",
                    "hooks": [
                        {
                            "type": "command",
                            "command": ["botbox", "hooks", "run", "init-agent", "--project-root", &project_root_str]
                        },
                        {
                            "type": "command",
                            "command": ["botbox", "hooks", "run", "check-jj", "--project-root", &project_root_str]
                        }
                    ]
                }],
                "PostToolUse": [{
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": ["botbox", "hooks", "run", "check-bus-inbox", "--project-root", &project_root_str]
                    }]
                }]
            }
        });

        let pretty = serde_json::to_string_pretty(&botbox_hooks)?;
        fs::write(&settings_path, pretty)?;

        Ok(())
    }

    fn sync_design_docs(&self, agents_dir: &Path) -> Result<()> {
        let design_dir = agents_dir.join("design");
        fs::create_dir_all(&design_dir)?;

        for (name, content) in DESIGN_DOCS {
            let path = design_dir.join(name);
            fs::write(&path, content)
                .with_context(|| format!("Failed to write {}", path.display()))?;
        }

        let version = compute_design_docs_version();
        fs::write(design_dir.join(".design-docs-version"), version)?;

        Ok(())
    }

    fn auto_commit(&self, project_root: &Path, changed_files: &[&str]) -> Result<()> {
        // Check if this is a jj repo
        let jj_dir = project_root.join(".jj");
        if !jj_dir.exists() {
            return Ok(()); // Not a jj repo, skip commit
        }

        // Validate changed_files are expected botbox-managed paths
        let allowed_prefixes = [".agents/botbox/", "AGENTS.md", ".claude/settings.json"];
        let sanitized: Vec<&str> = changed_files
            .iter()
            .filter(|f| allowed_prefixes.iter().any(|p| f.starts_with(p)))
            .copied()
            .collect();

        if sanitized.is_empty() {
            return Ok(());
        }

        // Sanitize file names in commit message (strip control chars)
        let files_str: String = sanitized.join(", ")
            .chars()
            .filter(|c| !c.is_control())
            .collect();
        let message = format!("chore: botbox sync (updated {})", files_str);

        run_command(
            "jj",
            &["describe", "-m", &message],
            Some(project_root),
        )?;

        Ok(())
    }
}

/// Migrate bus hooks from legacy `bun .../*.mjs` commands to `botbox run ...`.
///
/// Lists all hooks, finds any whose command contains `bun` and a `.mjs` script,
/// removes them and re-registers with the correct `botbox run` command.
fn migrate_bus_hooks(config: &Config) {
    let output = match Tool::new("bus")
        .args(&["hooks", "list", "--format", "json"])
        .run()
    {
        Ok(o) if o.success() => o,
        _ => return, // bus not available, skip silently
    };

    let parsed: serde_json::Value = match serde_json::from_str(&output.stdout) {
        Ok(v) => v,
        Err(_) => return,
    };

    let hooks = parsed
        .get("hooks")
        .and_then(|h| h.as_array())
        .or_else(|| parsed.as_array());

    let hooks = match hooks {
        Some(h) => h,
        None => return,
    };

    let name = &config.project.name;
    let agent = config.default_agent();

    for hook in hooks {
        let id = match hook.get("id").and_then(|i| i.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };

        let channel = hook
            .get("channel")
            .and_then(|c| c.as_str())
            .unwrap_or("");

        // Only migrate hooks for this project's channel
        if channel != name {
            continue;
        }

        let cmd = hook.get("command").and_then(|c| c.as_array());
        let cmd = match cmd {
            Some(c) => c,
            None => continue,
        };

        let cmd_strs: Vec<&str> = cmd.iter().filter_map(|v| v.as_str()).collect();

        // Check if this is a legacy hook that needs migration:
        // 1. bun-based (.mjs scripts) — original JS hooks
        // 2. botbox run responder/reviewer-loop with old naming (e.g., chief-dev/router)
        let has_bun = cmd_strs.iter().any(|s| *s == "bun");
        let mjs_script = cmd_strs.iter().find(|s| s.ends_with(".mjs"));
        let has_botbox_run = cmd_strs.windows(2).any(|w| w[0] == "botbox" && w[1] == "run");

        // Detect old spawn name pattern: --name {agent}/router (contains /)
        let old_spawn_name = cmd_strs.windows(2)
            .find(|w| w[0] == "--name")
            .map(|w| w[1])
            .unwrap_or("");
        let has_old_naming = old_spawn_name.contains('/') && old_spawn_name.ends_with("/router");

        // Detect old env-inherit containing BOTBUS_AGENT
        let has_old_env = cmd_strs.windows(2)
            .find(|w| w[0] == "--env-inherit")
            .map(|w| w[1].contains("BOTBUS_AGENT"))
            .unwrap_or(false);

        let needs_migration = if has_bun && mjs_script.is_some() {
            true // Legacy JS hook
        } else if has_botbox_run && (has_old_naming || has_old_env) {
            true // Already migrated to Rust but with old naming/env
        } else {
            false
        };

        if !needs_migration {
            continue;
        }

        let script = mjs_script.copied().unwrap_or("");

        // Determine what kind of hook this is
        let is_router = script.contains("respond.mjs") || script.contains("router.mjs")
            || cmd_strs.contains(&"responder");
        let is_reviewer = script.contains("reviewer-loop.mjs")
            || cmd_strs.contains(&"reviewer-loop");

        if !is_router && !is_reviewer {
            eprintln!("  Skipping unknown legacy hook {id}: {script}");
            continue;
        }

        // Always use canonical env-inherit (don't preserve old BOTBUS_AGENT)
        let env_inherit = "BOTBUS_CHANNEL,BOTBUS_MESSAGE_ID,BOTBUS_HOOK_ID,SSH_AUTH_SOCK";
        let spawn_cwd = cmd_strs
            .windows(2)
            .find(|w| w[0] == "--cwd")
            .map(|w| w[1])
            .unwrap_or(".");

        // Remove old hook
        let remove = Tool::new("bus")
            .args(&["hooks", "remove", &id])
            .run();

        if remove.is_err() || !remove.as_ref().unwrap().success() {
            eprintln!("  Warning: failed to remove legacy hook {id}");
            continue;
        }

        if is_router {
            // Extract condition details from old hook
            let claim_uri = hook
                .get("condition")
                .and_then(|c| c.get("claim"))
                .and_then(|c| c.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("agent://{name}-router"));

            let spawn_name = format!("{name}-router");

            let result = Tool::new("bus")
                .args(&[
                    "hooks", "add",
                    "--agent", &agent,
                    "--channel", name,
                    "--claim", &claim_uri,
                    "--claim-owner", &agent,
                    "--cwd", spawn_cwd,
                    "--ttl", "60",
                    "--",
                    "botty", "spawn",
                    "--env-inherit", env_inherit,
                    "--name", &spawn_name,
                    "--cwd", spawn_cwd,
                    "--",
                    "botbox", "run", "responder",
                ])
                .run();

            match result {
                Ok(o) if o.success() => {
                    println!("  Migrated router hook {id} → botbox run responder");
                }
                _ => eprintln!("  Warning: failed to re-register router hook"),
            }
        } else if is_reviewer {
            // Extract reviewer agent name from command args or condition
            let reviewer_agent = hook
                .get("condition")
                .and_then(|c| c.get("agent"))
                .and_then(|a| a.as_str())
                .unwrap_or("")
                .to_string();

            if reviewer_agent.is_empty() {
                eprintln!("  Warning: could not determine reviewer agent for hook {id}");
                continue;
            }

            let claim_uri = format!("agent://{reviewer_agent}");

            let result = Tool::new("bus")
                .args(&[
                    "hooks", "add",
                    "--agent", &agent,
                    "--channel", name,
                    "--mention", &reviewer_agent,
                    "--claim", &claim_uri,
                    "--claim-owner", &reviewer_agent,
                    "--ttl", "600",
                    "--priority", "1",
                    "--cwd", spawn_cwd,
                    "--",
                    "botty", "spawn",
                    "--env-inherit", env_inherit,
                    "--name", &reviewer_agent,
                    "--cwd", spawn_cwd,
                    "--",
                    "botbox", "run", "reviewer-loop",
                    "--agent", &reviewer_agent,
                ])
                .run();

            match result {
                Ok(o) if o.success() => {
                    println!("  Migrated reviewer hook {id} → botbox run reviewer-loop --agent {reviewer_agent}");
                }
                _ => eprintln!("  Warning: failed to re-register reviewer hook for {reviewer_agent}"),
            }
        }
    }
}

/// Compute SHA-256 hash of all workflow docs
fn compute_docs_version() -> String {
    let mut hasher = Sha256::new();
    for (name, content) in WORKFLOW_DOCS {
        hasher.update(name.as_bytes());
        hasher.update(content.as_bytes());
    }
    format!("{:x}", hasher.finalize())[..32].to_string()
}

/// Compute SHA-256 hash of all reviewer prompts
fn compute_prompts_version() -> String {
    let mut hasher = Sha256::new();
    for (name, content) in REVIEWER_PROMPTS {
        hasher.update(name.as_bytes());
        hasher.update(content.as_bytes());
    }
    format!("{:x}", hasher.finalize())[..32].to_string()
}

/// Compute SHA-256 hash of all design docs
fn compute_design_docs_version() -> String {
    let mut hasher = Sha256::new();
    for (name, content) in DESIGN_DOCS {
        hasher.update(name.as_bytes());
        hasher.update(content.as_bytes());
    }
    format!("{:x}", hasher.finalize())[..32].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_hashes() {
        let docs_ver = compute_docs_version();
        assert_eq!(docs_ver.len(), 32);
        assert!(docs_ver.chars().all(|c| c.is_ascii_hexdigit()));

        let prompts_ver = compute_prompts_version();
        assert_eq!(prompts_ver.len(), 32);
        assert!(prompts_ver.chars().all(|c| c.is_ascii_hexdigit()));

        let design_ver = compute_design_docs_version();
        assert_eq!(design_ver.len(), 32);
        assert!(design_ver.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_workflow_docs_embedded() {
        assert!(!WORKFLOW_DOCS.is_empty());
        for (name, content) in WORKFLOW_DOCS {
            assert!(!name.is_empty());
            assert!(!content.is_empty());
        }
    }

    #[test]
    fn test_design_docs_embedded() {
        assert!(!DESIGN_DOCS.is_empty());
        for (name, content) in DESIGN_DOCS {
            assert!(!name.is_empty());
            assert!(!content.is_empty());
        }
    }

    #[test]
    fn test_reviewer_prompts_embedded() {
        assert_eq!(REVIEWER_PROMPTS.len(), 2);
        assert!(REVIEWER_PROMPTS.iter().any(|(n, _)| *n == "reviewer.md"));
        assert!(REVIEWER_PROMPTS
            .iter()
            .any(|(n, _)| *n == "reviewer-security.md"));
    }
}
