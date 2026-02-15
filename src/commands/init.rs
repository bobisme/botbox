use std::fs;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::Args;

use crate::config::{
    AgentsConfig, Config, DevAgentConfig, MissionsConfig, ProjectConfig, ReviewConfig,
    ReviewerAgentConfig, ToolsConfig, WorkerAgentConfig,
};
use crate::error::ExitError;
use crate::subprocess::{run_command, Tool};
use crate::template::render_agents_md;

const PROJECT_TYPES: &[&str] = &["api", "cli", "frontend", "library", "monorepo", "tui"];
const AVAILABLE_TOOLS: &[&str] = &["beads", "maw", "crit", "botbus", "botty"];
const REVIEWER_ROLES: &[&str] = &["security"];
const LANGUAGES: &[&str] = &["rust", "python", "node", "go", "typescript", "java"];
const CONFIG_VERSION: &str = "1.0.16";

/// Validate that a name (project, reviewer role) matches [a-z0-9][a-z0-9-]* and is ≤64 chars.
/// Prevents command injection and path traversal via user-supplied names.
fn validate_name(name: &str, label: &str) -> Result<()> {
    if name.is_empty() || name.len() > 64 {
        anyhow::bail!("{label} must be 1-64 characters, got {}", name.len());
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        anyhow::bail!("{label} must match [a-z0-9-], got {name:?}");
    }
    if name.starts_with('-') || name.ends_with('-') {
        anyhow::bail!("{label} must not start or end with '-', got {name:?}");
    }
    Ok(())
}

#[derive(Debug, Args)]
pub struct InitArgs {
    /// Project name
    #[arg(long)]
    pub name: Option<String>,
    /// Project types (comma-separated: api, cli, frontend, library, monorepo, tui)
    #[arg(long, value_delimiter = ',')]
    pub r#type: Vec<String>,
    /// Tools to enable (comma-separated: beads, maw, crit, botbus, botty)
    #[arg(long, value_delimiter = ',')]
    pub tools: Vec<String>,
    /// Reviewer roles (comma-separated: security)
    #[arg(long, value_delimiter = ',')]
    pub reviewers: Vec<String>,
    /// Languages for .gitignore generation (comma-separated: rust, python, node, go, typescript, java)
    #[arg(long, value_delimiter = ',')]
    pub language: Vec<String>,
    /// Install command (e.g., "just install")
    #[arg(long)]
    pub install_command: Option<String>,
    /// Non-interactive mode
    #[arg(long)]
    pub no_interactive: bool,
    /// Skip beads initialization
    #[arg(long)]
    pub no_init_beads: bool,
    /// Skip seeding initial work beads
    #[arg(long)]
    pub no_seed_work: bool,
    /// Force overwrite existing config
    #[arg(long)]
    pub force: bool,
    /// Skip auto-commit
    #[arg(long)]
    pub no_commit: bool,
    /// Project root directory
    #[arg(long)]
    pub project_root: Option<PathBuf>,
}

/// Collected user choices for init
struct InitChoices {
    name: String,
    types: Vec<String>,
    tools: Vec<String>,
    reviewers: Vec<String>,
    languages: Vec<String>,
    install_command: Option<String>,
    init_beads: bool,
    seed_work: bool,
}

impl InitArgs {
    pub fn execute(&self) -> Result<()> {
        let project_dir = self
            .project_root
            .clone()
            .unwrap_or_else(|| std::env::current_dir().expect("Failed to get current dir"));

        // Canonicalize project root and verify it contains .botbox.json or is a new init target
        let project_dir = project_dir
            .canonicalize()
            .unwrap_or(project_dir);

        // Detect maw v2 bare repo
        let ws_default = project_dir.join("ws/default");
        let ws_default_config = ws_default.join(".botbox.json");
        if ws_default_config.exists()
            || (ws_default.exists()
                && !project_dir.join(".agents/botbox").exists())
        {
            return self.handle_bare_repo(&project_dir);
        }

        let agents_dir = project_dir.join(".agents/botbox");
        let agents_md_path = project_dir.join("AGENTS.md");
        let is_reinit = agents_dir.exists();

        // Detect existing config from AGENTS.md on re-init
        let detected = if is_reinit && agents_md_path.exists() {
            let content = fs::read_to_string(&agents_md_path)?;
            detect_from_agents_md(&content)
        } else {
            DetectedConfig::default()
        };

        let interactive = !self.no_interactive && std::io::stdin().is_terminal();
        let choices = self.gather_choices(interactive, &detected)?;

        // Create .agents/botbox/
        fs::create_dir_all(&agents_dir)?;
        println!("Created .agents/botbox/");

        // Run sync to copy workflow docs, prompts, design docs, hooks
        // We create config first so sync can read it
        let config = build_config(&choices);

        // Write .botbox.json
        let config_path = project_dir.join(".botbox.json");
        if !config_path.exists() || self.force {
            let json = serde_json::to_string_pretty(&config)?;
            fs::write(&config_path, format!("{json}\n"))?;
            println!("Generated .botbox.json");
        }

        // Copy workflow docs (reuse sync logic)
        sync_workflow_docs(&agents_dir)?;
        println!("Copied workflow docs");

        // Copy prompt templates
        sync_prompts(&agents_dir)?;
        println!("Copied prompt templates");

        // Copy design docs
        sync_design_docs(&agents_dir)?;
        println!("Copied design docs");

        // Generate .claude/settings.json with hooks
        sync_hooks(&project_dir)?;
        println!("Generated .claude/settings.json with hooks config");

        // Generate AGENTS.md
        if agents_md_path.exists() && !self.force {
            eprintln!(
                "AGENTS.md already exists. Use --force to overwrite, or run `botbox sync` to update."
            );
        } else {
            let content = render_agents_md(&config)?;
            fs::write(&agents_md_path, content)?;
            println!("Generated AGENTS.md");
        }

        // Symlink CLAUDE.md → AGENTS.md
        let claude_md_path = project_dir.join("CLAUDE.md");
        if !claude_md_path.exists() {
            #[cfg(unix)]
            std::os::unix::fs::symlink("AGENTS.md", &claude_md_path)?;
            #[cfg(windows)]
            std::os::windows::fs::symlink_file("AGENTS.md", &claude_md_path)?;
            println!("Symlinked CLAUDE.md → AGENTS.md");
        }

        // Initialize beads
        if choices.init_beads && choices.tools.contains(&"beads".to_string()) {
            match run_command("br", &["init"], Some(&project_dir)) {
                Ok(_) => println!("Initialized beads"),
                Err(_) => eprintln!("Warning: br init failed (is beads installed?)"),
            }
        }

        // Initialize maw
        if choices.tools.contains(&"maw".to_string()) {
            match run_command("maw", &["init"], Some(&project_dir)) {
                Ok(_) => println!("Initialized maw (jj)"),
                Err(_) => eprintln!("Warning: maw init failed (is maw installed?)"),
            }
        }

        // Initialize crit
        if choices.tools.contains(&"crit".to_string()) {
            match run_command("crit", &["init"], Some(&project_dir)) {
                Ok(_) => println!("Initialized crit"),
                Err(_) => eprintln!("Warning: crit init failed (is crit installed?)"),
            }

            // Create .critignore
            let critignore_path = project_dir.join(".critignore");
            if !critignore_path.exists() {
                fs::write(
                    &critignore_path,
                    "# Ignore botbox-managed files (prompts, scripts, hooks, journals)\n\
                     .agents/botbox/\n\
                     \n\
                     # Ignore tool config and data files\n\
                     .beads/\n\
                     .crit/\n\
                     .maw.toml\n\
                     .botbox.json\n\
                     .claude/\n\
                     opencode.json\n",
                )?;
                println!("Created .critignore");
            }
        }

        // Register project on #projects channel (skip on re-init)
        if choices.tools.contains(&"botbus".to_string()) && !is_reinit {
            let abs_path = project_dir
                .canonicalize()
                .unwrap_or_else(|_| project_dir.clone());
            let tools_list = choices.tools.join(", ");
            let agent = format!("{}-dev", choices.name);
            let msg = format!(
                "project: {}  repo: {}  lead: {}  tools: {}",
                choices.name,
                abs_path.display(),
                agent,
                tools_list
            );
            match Tool::new("bus")
                .args(&[
                    "send",
                    "--agent",
                    &agent,
                    "projects",
                    &msg,
                    "-L",
                    "project-registry",
                ])
                .run()
            {
                Ok(output) if output.success() => {
                    println!("Registered project on #projects channel")
                }
                _ => eprintln!("Warning: Failed to register on #projects (is bus installed?)"),
            }
        }

        // Seed initial work beads
        if choices.seed_work && choices.tools.contains(&"beads".to_string()) {
            let count = seed_initial_beads(&project_dir, &choices.name, &choices.types);
            if count > 0 {
                let suffix = if count > 1 { "s" } else { "" };
                println!("Created {count} seed bead{suffix}");
            }
        }

        // Register botbus hooks
        if choices.tools.contains(&"botbus".to_string()) {
            register_spawn_hooks(&project_dir, &choices.name, &choices.reviewers);
        }

        // Generate .gitignore
        if !choices.languages.is_empty() {
            let gitignore_path = project_dir.join(".gitignore");
            if !gitignore_path.exists() {
                match fetch_gitignore(&choices.languages) {
                    Ok(content) => {
                        fs::write(&gitignore_path, content)?;
                        println!("Generated .gitignore for: {}", choices.languages.join(", "));
                    }
                    Err(e) => eprintln!("Warning: Failed to generate .gitignore: {e}"),
                }
            } else {
                println!(".gitignore already exists, skipping generation");
            }
        }

        // Auto-commit
        if !is_reinit && !self.no_commit {
            auto_commit(&project_dir, &config)?;
        }

        println!("Done.");
        Ok(())
    }

    fn handle_bare_repo(&self, project_dir: &Path) -> Result<()> {
        let project_dir = project_dir
            .canonicalize()
            .context("canonicalizing project root")?;

        if !project_dir.join(".botbox.json").exists()
            && !project_dir.join("ws/default/.botbox.json").exists()
        {
            // First init at bare root — fine, delegate to ws/default
        }

        let mut args: Vec<String> = vec![
            "exec", "default", "--", "botbox", "init",
        ]
        .into_iter()
        .map(Into::into)
        .collect();

        if let Some(ref name) = self.name {
            args.push("--name".into());
            args.push(name.clone());
        }
        if !self.r#type.is_empty() {
            args.push("--type".into());
            args.push(self.r#type.join(","));
        }
        if !self.tools.is_empty() {
            args.push("--tools".into());
            args.push(self.tools.join(","));
        }
        if !self.reviewers.is_empty() {
            args.push("--reviewers".into());
            args.push(self.reviewers.join(","));
        }
        if !self.language.is_empty() {
            args.push("--language".into());
            args.push(self.language.join(","));
        }
        if let Some(ref cmd) = self.install_command {
            args.push("--install-command".into());
            args.push(cmd.clone());
        }
        if self.force {
            args.push("--force".into());
        }
        if self.no_interactive {
            args.push("--no-interactive".into());
        }
        if self.no_commit {
            args.push("--no-commit".into());
        }
        if self.no_init_beads {
            args.push("--no-init-beads".into());
        }
        if self.no_seed_work {
            args.push("--no-seed-work".into());
        }

        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_command("maw", &arg_refs, Some(&project_dir))?;

        // Create bare root stubs
        let stub_content = "**Do not edit the root AGENTS.md or CLAUDE.md for memories or instructions. Use the AGENTS.md in ws/default/.**\n@ws/default/AGENTS.md\n";
        let stub_agents = project_dir.join("AGENTS.md");
        if !stub_agents.exists() {
            fs::write(&stub_agents, stub_content)?;
            println!("Created bare-root AGENTS.md stub");
        }

        let stub_claude = project_dir.join("CLAUDE.md");
        if !stub_claude.exists() {
            #[cfg(unix)]
            std::os::unix::fs::symlink("AGENTS.md", &stub_claude)?;
            #[cfg(windows)]
            std::os::windows::fs::symlink_file("AGENTS.md", &stub_claude)?;
            println!("Symlinked bare-root CLAUDE.md → AGENTS.md");
        }

        // Symlink .claude → ws/default/.claude
        let root_claude_dir = project_dir.join(".claude");
        let ws_claude_dir = project_dir.join("ws/default/.claude");
        if ws_claude_dir.exists() {
            let needs_symlink = match fs::read_link(&root_claude_dir) {
                Ok(target) => target != Path::new("ws/default/.claude"),
                Err(_) => true,
            };
            if needs_symlink {
                let tmp_link = project_dir.join(".claude.tmp");
                let _ = fs::remove_file(&tmp_link);
                #[cfg(unix)]
                std::os::unix::fs::symlink("ws/default/.claude", &tmp_link)?;
                #[cfg(windows)]
                std::os::windows::fs::symlink_dir("ws/default/.claude", &tmp_link)?;
                if let Err(e) = fs::rename(&tmp_link, &root_claude_dir) {
                    let _ = fs::remove_file(&tmp_link);
                    return Err(e).context("creating .claude symlink");
                }
                println!("Symlinked .claude → ws/default/.claude");
            }
        }

        Ok(())
    }

    fn gather_choices(
        &self,
        interactive: bool,
        detected: &DetectedConfig,
    ) -> Result<InitChoices> {
        // Project name
        let name = if let Some(ref n) = self.name {
            validate_name(n, "project name")?;
            n.clone()
        } else if interactive {
            let n = prompt_input("Project name", detected.name.as_deref())?;
            validate_name(&n, "project name")?;
            n
        } else {
            let n = detected
                .name
                .clone()
                .ok_or_else(|| ExitError::Other("--name is required in non-interactive mode".into()))?;
            validate_name(&n, "project name")?;
            n
        };

        // Project types
        let types = if !self.r#type.is_empty() {
            validate_values(&self.r#type, PROJECT_TYPES, "project type")?;
            self.r#type.clone()
        } else if interactive {
            let defaults: Vec<bool> = PROJECT_TYPES
                .iter()
                .map(|t| detected.types.contains(&t.to_string()))
                .collect();
            prompt_multi_select("Project type (select one or more)", PROJECT_TYPES, &defaults)?
        } else {
            if detected.types.is_empty() {
                return Err(
                    ExitError::Other("--type is required in non-interactive mode".into()).into(),
                );
            }
            detected.types.clone()
        };

        // Tools
        let tools = if !self.tools.is_empty() {
            validate_values(&self.tools, AVAILABLE_TOOLS, "tool")?;
            self.tools.clone()
        } else if interactive {
            let defaults: Vec<bool> = AVAILABLE_TOOLS
                .iter()
                .map(|t| {
                    if detected.tools.is_empty() {
                        true // all enabled by default
                    } else {
                        detected.tools.contains(&t.to_string())
                    }
                })
                .collect();
            prompt_multi_select("Tools to enable", AVAILABLE_TOOLS, &defaults)?
        } else if detected.tools.is_empty() {
            AVAILABLE_TOOLS.iter().map(|s| s.to_string()).collect()
        } else {
            detected.tools.clone()
        };

        // Reviewers
        let reviewers = if !self.reviewers.is_empty() {
            validate_values(&self.reviewers, REVIEWER_ROLES, "reviewer role")?;
            for r in &self.reviewers {
                validate_name(r, "reviewer role")?;
            }
            self.reviewers.clone()
        } else if interactive {
            let defaults: Vec<bool> = REVIEWER_ROLES
                .iter()
                .map(|r| detected.reviewers.contains(&r.to_string()))
                .collect();
            prompt_multi_select("Reviewer roles", REVIEWER_ROLES, &defaults)?
        } else {
            detected.reviewers.clone()
        };

        // Languages
        let languages = if !self.language.is_empty() {
            validate_values(&self.language, LANGUAGES, "language")?;
            self.language.clone()
        } else if interactive {
            prompt_multi_select(
                "Languages/frameworks (for .gitignore generation)",
                LANGUAGES,
                &vec![false; LANGUAGES.len()],
            )?
        } else {
            Vec::new()
        };

        // Init beads
        let init_beads = if self.no_init_beads {
            false
        } else if interactive {
            prompt_confirm("Initialize beads?", true)?
        } else {
            false
        };

        // Seed work
        let seed_work = if self.no_seed_work {
            false
        } else if interactive {
            prompt_confirm("Seed initial work beads?", false)?
        } else {
            false
        };

        // Install command
        let install_command = if let Some(ref cmd) = self.install_command {
            Some(cmd.clone())
        } else if interactive {
            if prompt_confirm("Install locally after releases? (for CLI tools)", false)? {
                Some(prompt_input("Install command", Some("just install"))?)
            } else {
                None
            }
        } else {
            None
        };

        Ok(InitChoices {
            name,
            types,
            tools,
            reviewers,
            languages,
            install_command,
            init_beads,
            seed_work,
        })
    }
}

// --- Interactive prompts using dialoguer ---

fn prompt_input(prompt: &str, default: Option<&str>) -> Result<String> {
    let mut builder = dialoguer::Input::<String>::new().with_prompt(prompt);
    if let Some(d) = default {
        builder = builder.default(d.to_string());
    }
    builder
        .interact_text()
        .context("reading user input")
}

fn prompt_multi_select(prompt: &str, items: &[&str], defaults: &[bool]) -> Result<Vec<String>> {
    let selections = dialoguer::MultiSelect::new()
        .with_prompt(prompt)
        .items(items)
        .defaults(defaults)
        .interact()
        .context("reading user selection")?;

    Ok(selections.into_iter().map(|i| items[i].to_string()).collect())
}

fn prompt_confirm(prompt: &str, default: bool) -> Result<bool> {
    dialoguer::Confirm::new()
        .with_prompt(prompt)
        .default(default)
        .interact()
        .context("reading user confirmation")
}

// --- Validation ---

fn validate_values(values: &[String], valid: &[&str], label: &str) -> Result<()> {
    let invalid: Vec<&String> = values.iter().filter(|v| !valid.contains(&v.as_str())).collect();
    if !invalid.is_empty() {
        let inv = invalid.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
        let val = valid.join(", ");
        return Err(ExitError::Other(format!(
            "Unknown {label}: {inv}. Valid: {val}"
        ))
        .into());
    }
    Ok(())
}

// --- Config detection from AGENTS.md header ---

#[derive(Debug, Default)]
struct DetectedConfig {
    name: Option<String>,
    types: Vec<String>,
    tools: Vec<String>,
    reviewers: Vec<String>,
}

fn detect_from_agents_md(content: &str) -> DetectedConfig {
    let mut config = DetectedConfig::default();

    for line in content.lines().take(20) {
        if line.starts_with("# ") && config.name.is_none() {
            config.name = Some(line[2..].trim().to_string());
        } else if let Some(rest) = line.strip_prefix("Project type: ") {
            config.types = rest.split(',').map(|s| s.trim().to_string()).collect();
        } else if let Some(rest) = line.strip_prefix("Tools: ") {
            config.tools = rest
                .split(',')
                .map(|s| s.trim().trim_matches('`').to_string())
                .collect();
        } else if let Some(rest) = line.strip_prefix("Reviewer roles: ") {
            config.reviewers = rest.split(',').map(|s| s.trim().to_string()).collect();
        }
    }

    config
}

// --- Config building ---

fn build_config(choices: &InitChoices) -> Config {
    Config {
        version: CONFIG_VERSION.to_string(),
        project: ProjectConfig {
            name: choices.name.clone(),
            project_type: choices.types.clone(),
            languages: choices.languages.clone(),
            default_agent: Some(format!("{}-dev", choices.name)),
            channel: Some(choices.name.clone()),
            install_command: choices.install_command.clone(),
            critical_approvers: None,
        },
        tools: ToolsConfig {
            beads: choices.tools.contains(&"beads".to_string()),
            maw: choices.tools.contains(&"maw".to_string()),
            crit: choices.tools.contains(&"crit".to_string()),
            botbus: choices.tools.contains(&"botbus".to_string()),
            botty: choices.tools.contains(&"botty".to_string()),
        },
        review: ReviewConfig {
            enabled: !choices.reviewers.is_empty(),
            reviewers: choices.reviewers.clone(),
        },
        push_main: false,
        agents: AgentsConfig {
            dev: Some(DevAgentConfig {
                model: "opus".into(),
                max_loops: 20,
                pause: 2,
                timeout: 900,
                missions: Some(MissionsConfig {
                    enabled: true,
                    max_workers: 4,
                    max_children: 12,
                    checkpoint_interval_sec: 30,
                }),
                multi_lead: None,
            }),
            worker: Some(WorkerAgentConfig {
                model: "haiku".into(),
                timeout: 600,
            }),
            reviewer: Some(ReviewerAgentConfig {
                model: "opus".into(),
                max_loops: 20,
                pause: 2,
                timeout: 600,
            }),
            responder: None,
        },
    }
}

// --- Sync helpers (reuse embedded content from sync.rs) ---

// Re-embed the same workflow docs as sync.rs
use crate::commands::sync::{
    DESIGN_DOCS, REVIEWER_PROMPTS, WORKFLOW_DOCS,
};

fn sync_workflow_docs(agents_dir: &Path) -> Result<()> {
    for (name, content) in WORKFLOW_DOCS {
        let path = agents_dir.join(name);
        fs::write(&path, content)
            .with_context(|| format!("writing {}", path.display()))?;
    }

    // Write version marker
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for (name, content) in WORKFLOW_DOCS {
        hasher.update(name.as_bytes());
        hasher.update(content.as_bytes());
    }
    let version = format!("{:x}", hasher.finalize());
    fs::write(agents_dir.join(".version"), &version[..32])?;

    Ok(())
}

fn sync_prompts(agents_dir: &Path) -> Result<()> {
    let prompts_dir = agents_dir.join("prompts");
    fs::create_dir_all(&prompts_dir)?;

    for (name, content) in REVIEWER_PROMPTS {
        let path = prompts_dir.join(name);
        fs::write(&path, content)
            .with_context(|| format!("writing {}", path.display()))?;
    }

    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for (name, content) in REVIEWER_PROMPTS {
        hasher.update(name.as_bytes());
        hasher.update(content.as_bytes());
    }
    let version = format!("{:x}", hasher.finalize());
    fs::write(prompts_dir.join(".prompts-version"), &version[..32])?;

    Ok(())
}

fn sync_design_docs(agents_dir: &Path) -> Result<()> {
    let design_dir = agents_dir.join("design");
    fs::create_dir_all(&design_dir)?;

    for (name, content) in DESIGN_DOCS {
        let path = design_dir.join(name);
        fs::write(&path, content)
            .with_context(|| format!("writing {}", path.display()))?;
    }

    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for (name, content) in DESIGN_DOCS {
        hasher.update(name.as_bytes());
        hasher.update(content.as_bytes());
    }
    let version = format!("{:x}", hasher.finalize());
    fs::write(design_dir.join(".design-docs-version"), &version[..32])?;

    Ok(())
}

fn sync_hooks(project_dir: &Path) -> Result<()> {
    use std::collections::HashMap;
    use crate::hooks::HookRegistry;
    use crate::config::Config;

    let claude_dir = project_dir.join(".claude");
    fs::create_dir_all(&claude_dir)?;

    let settings_path = claude_dir.join("settings.json");
    // Canonicalize path to resolve symlinks and relative components
    let canonical = project_dir
        .canonicalize()
        .unwrap_or_else(|_| project_dir.to_path_buf());
    let project_root_str = canonical.display().to_string();

    // Load config to determine eligible hooks
    let config = Config::load(&project_dir.join(".botbox.json"))?;
    let eligible_hooks = HookRegistry::eligible(&config.tools);

    // Group hooks by event type
    let mut hooks_by_event: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    for hook_entry in &eligible_hooks {
        for event in hook_entry.events {
            let hook_json = serde_json::json!({
                "type": "command",
                "command": ["botbox", "hooks", "run", hook_entry.name, "--project-root", &project_root_str]
            });
            hooks_by_event
                .entry(event.as_str().to_string())
                .or_default()
                .push(hook_json);
        }
    }

    // Merge with existing settings.json to preserve non-botbox hooks
    let mut settings: serde_json::Value = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // For each event type, replace botbox entries while preserving others
    let hooks = settings
        .as_object_mut()
        .context("settings.json is not an object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    for (event_name, event_hooks) in &hooks_by_event {
        let event_array = hooks
            .as_object_mut()
            .context("hooks is not an object")?
            .entry(event_name)
            .or_insert_with(|| serde_json::json!([]));

        if let Some(arr) = event_array.as_array_mut() {
            // Remove existing botbox entries (identified by command containing "botbox")
            arr.retain(|entry| {
                let is_botbox = entry
                    .get("hooks")
                    .and_then(|h| h.as_array())
                    .is_some_and(|hooks| {
                        hooks.iter().any(|hook| {
                            hook.get("command")
                                .and_then(|c| c.as_array())
                                .is_some_and(|cmd| {
                                    cmd.first()
                                        .and_then(|c| c.as_str())
                                        == Some("botbox")
                                })
                        })
                    });
                !is_botbox
            });

            // Add botbox entry with all hooks for this event
            let entry = serde_json::json!({
                "matcher": "",
                "hooks": event_hooks
            });
            arr.push(entry);
        }
    }

    let pretty = serde_json::to_string_pretty(&settings)?;
    fs::write(&settings_path, pretty)?;

    Ok(())
}

// --- Hook registration ---

fn register_spawn_hooks(project_dir: &Path, name: &str, reviewers: &[String]) {
    let abs_path = project_dir
        .canonicalize()
        .unwrap_or_else(|_| project_dir.to_path_buf());
    let agent = format!("{name}-dev");

    // Detect maw v2 workspace context
    let (hook_cwd, spawn_cwd) = detect_hook_paths(&abs_path);

    // Check if bus supports hooks
    if Tool::new("bus").arg("hooks").arg("list").run().is_err() {
        return;
    }

    // Register router hook
    register_router_hook(&hook_cwd, &spawn_cwd, name, &agent);

    // Register reviewer hooks
    for role in reviewers {
        let reviewer_agent = format!("{name}-{role}");
        register_reviewer_hook(
            &hook_cwd,
            &spawn_cwd,
            name,
            &agent,
            &reviewer_agent,
        );
    }
}

fn detect_hook_paths(abs_path: &Path) -> (String, String) {
    // In maw v2, if we're inside ws/default/, use the bare root
    let abs_str = abs_path.display().to_string();
    if let Some(parent) = abs_path.parent()
        && parent.file_name().is_some_and(|n| n == "ws")
            && let Some(bare_root) = parent.parent()
                && bare_root.join(".jj").exists() {
                    let bare_str = bare_root.display().to_string();
                    return (bare_str.clone(), bare_str);
                }
    (abs_str.clone(), abs_str)
}

fn register_router_hook(
    hook_cwd: &str,
    spawn_cwd: &str,
    name: &str,
    agent: &str,
) {
    // Check if router hook already exists
    let existing = Tool::new("bus")
        .args(&["hooks", "list", "--format", "json"])
        .run();

    if let Ok(output) = existing
        && output.success()
            && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&output.stdout) {
                let hooks = parsed
                    .get("hooks")
                    .and_then(|h| h.as_array())
                    .or_else(|| parsed.as_array());
                if let Some(arr) = hooks {
                    let has_router = arr.iter().any(|h| {
                        let is_active = h.get("active").and_then(|a| a.as_bool()).unwrap_or(false);
                        let is_claim = h
                            .get("condition")
                            .and_then(|c| c.get("type"))
                            .and_then(|t| t.as_str())
                            == Some("claim_available");
                        let has_router_cmd = h
                            .get("command")
                            .and_then(|c| c.as_array())
                            .is_some_and(|cmds| {
                                cmds.iter().any(|c| {
                                    c.as_str().is_some_and(|s| {
                                        s.contains("responder") || s.contains("respond.mjs") || s.contains("router.mjs")
                                    })
                                })
                            });
                        is_active && is_claim && has_router_cmd
                    });
                    if has_router {
                        println!("Router hook already exists, skipping");
                        return;
                    }
                }
            }

    let env_inherit = "BOTBUS_CHANNEL,BOTBUS_MESSAGE_ID,BOTBUS_HOOK_ID,SSH_AUTH_SOCK";
    let claim_uri = format!("agent://{name}-router");
    let spawn_name = format!("{name}-router");

    let result = Tool::new("bus")
        .args(&[
            "hooks",
            "add",
            "--agent",
            agent,
            "--channel",
            name,
            "--claim",
            &claim_uri,
            "--claim-owner",
            agent,
            "--cwd",
            hook_cwd,
            "--ttl",
            "60",
            "--",
            "botty",
            "spawn",
            "--env-inherit",
            env_inherit,
            "--name",
            &spawn_name,
            "--cwd",
            spawn_cwd,
            "--",
            "botbox",
            "run",
            "responder",
        ])
        .run();

    match result {
        Ok(output) if output.success() => {
            println!("Registered router hook (responder) for all channel messages");
        }
        _ => eprintln!("Warning: Failed to register router hook"),
    }
}

fn register_reviewer_hook(
    hook_cwd: &str,
    spawn_cwd: &str,
    name: &str,
    agent: &str,
    reviewer_agent: &str,
) {
    // Check if mention hook already exists
    let existing = Tool::new("bus")
        .args(&["hooks", "list", "--format", "json"])
        .run();

    if let Ok(output) = existing
        && output.success()
            && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&output.stdout) {
                let hooks = parsed
                    .get("hooks")
                    .and_then(|h| h.as_array())
                    .or_else(|| parsed.as_array());
                if let Some(arr) = hooks {
                    let has_mention = arr.iter().any(|h| {
                        let is_active = h.get("active").and_then(|a| a.as_bool()).unwrap_or(false);
                        let agent_match = h
                            .get("condition")
                            .and_then(|c| c.get("agent"))
                            .and_then(|a| a.as_str())
                            == Some(reviewer_agent);
                        is_active && agent_match
                    });
                    if has_mention {
                        println!("Mention hook for @{reviewer_agent} already exists, skipping");
                        return;
                    }
                }
            }

    let env_inherit = "BOTBUS_CHANNEL,BOTBUS_MESSAGE_ID,BOTBUS_AGENT,BOTBUS_HOOK_ID";
    let claim_uri = format!("agent://{reviewer_agent}");

    let result = Tool::new("bus")
        .args(&[
            "hooks",
            "add",
            "--agent",
            agent,
            "--channel",
            name,
            "--mention",
            reviewer_agent,
            "--claim",
            &claim_uri,
            "--claim-owner",
            reviewer_agent,
            "--ttl",
            "600",
            "--priority",
            "1",
            "--cwd",
            hook_cwd,
            "--",
            "botty",
            "spawn",
            "--env-inherit",
            env_inherit,
            "--name",
            reviewer_agent,
            "--cwd",
            spawn_cwd,
            "--",
            "botbox",
            "run",
            "reviewer-loop",
            "--agent",
            reviewer_agent,
        ])
        .run();

    match result {
        Ok(output) if output.success() => {
            println!("Registered mention hook for @{reviewer_agent}");
        }
        _ => eprintln!("Warning: Failed to register mention hook for @{reviewer_agent}"),
    }
}

// --- Seed beads ---

fn seed_initial_beads(project_dir: &Path, name: &str, types: &[String]) -> usize {
    let agent = format!("{name}-dev");
    let mut count = 0;

    let create_bead = |title: &str, description: &str, priority: u32| -> bool {
        Tool::new("br")
            .args(&[
                "create",
                "--actor",
                &agent,
                "--owner",
                &agent,
                &format!("--title={title}"),
                &format!("--description={description}"),
                "--type=task",
                &format!("--priority={priority}"),
            ])
            .run()
            .is_ok_and(|o| o.success())
    };

    // Scout for spec files
    for spec in ["spec.md", "SPEC.md", "specification.md", "design.md"] {
        if project_dir.join(spec).exists()
            && create_bead(
                &format!("Review {spec} and create implementation beads"),
                &format!("Read {spec}, understand requirements, and break down into actionable beads with acceptance criteria."),
                1,
            )
        {
            count += 1;
        }
    }

    // Scout for README
    if project_dir.join("README.md").exists()
        && create_bead(
            "Review README and align project setup",
            "Read README.md for project goals, architecture decisions, and setup requirements. Create beads for any gaps.",
            2,
        )
    {
        count += 1;
    }

    // Scout for source structure
    if !project_dir.join("src").exists()
        && create_bead(
            "Create initial source structure",
            &format!(
                "Set up src/ directory and project scaffolding for project type: {}.",
                types.join(", ")
            ),
            2,
        )
    {
        count += 1;
    }

    // Fallback
    if count == 0
        && create_bead(
            "Scout project and create initial beads",
            "Explore the repository, understand the project goals, and create actionable beads for initial implementation work.",
            1,
        )
    {
        count += 1;
    }

    count
}

// --- .gitignore ---

fn fetch_gitignore(languages: &[String]) -> Result<String> {
    // Validate all language names against the allowlist before constructing the URL
    // to prevent SSRF via crafted language names (e.g., "../admin" or URL fragments)
    for lang in languages {
        if !LANGUAGES.contains(&lang.as_str()) {
            anyhow::bail!("unknown language for .gitignore: {lang:?}. Valid: {LANGUAGES:?}");
        }
    }
    let langs = languages.join(",");
    let url = format!("https://www.toptal.com/developers/gitignore/api/{langs}");
    let body = ureq::get(&url).call()?.into_body().read_to_string()?;
    Ok(body)
}

// --- Auto-commit ---

fn auto_commit(project_dir: &Path, config: &Config) -> Result<()> {
    let jj_dir = project_dir.join(".jj");
    if !jj_dir.exists() {
        return Ok(());
    }

    let message = format!("chore: initialize botbox v{}", config.version);

    match run_command("jj", &["describe", "-m", &message], Some(project_dir)) {
        Ok(_) => println!("Committed: {message}"),
        Err(_) => eprintln!("Warning: Failed to auto-commit (jj error)"),
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_from_agents_md() {
        let content = "# myproject\n\nProject type: cli, api\nTools: `beads`, `maw`, `crit`\nReviewer roles: security\n";
        let detected = detect_from_agents_md(content);
        assert_eq!(detected.name, Some("myproject".to_string()));
        assert_eq!(detected.types, vec!["cli", "api"]);
        assert_eq!(detected.tools, vec!["beads", "maw", "crit"]);
        assert_eq!(detected.reviewers, vec!["security"]);
    }

    #[test]
    fn test_detect_from_empty_agents_md() {
        let detected = detect_from_agents_md("");
        assert!(detected.name.is_none());
        assert!(detected.types.is_empty());
        assert!(detected.tools.is_empty());
        assert!(detected.reviewers.is_empty());
    }

    #[test]
    fn test_validate_values_ok() {
        let values = vec!["beads".to_string(), "maw".to_string()];
        assert!(validate_values(&values, AVAILABLE_TOOLS, "tool").is_ok());
    }

    #[test]
    fn test_validate_values_invalid() {
        let values = vec!["beads".to_string(), "invalid".to_string()];
        let result = validate_values(&values, AVAILABLE_TOOLS, "tool");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("invalid"));
    }

    #[test]
    fn test_build_config() {
        let choices = InitChoices {
            name: "test".to_string(),
            types: vec!["cli".to_string()],
            tools: vec!["beads".to_string(), "maw".to_string()],
            reviewers: vec!["security".to_string()],
            languages: vec!["rust".to_string()],
            install_command: Some("just install".to_string()),
            init_beads: true,
            seed_work: false,
        };

        let config = build_config(&choices);
        assert_eq!(config.project.name, "test");
        assert_eq!(config.project.default_agent, Some("test-dev".to_string()));
        assert_eq!(config.project.channel, Some("test".to_string()));
        assert!(config.tools.beads);
        assert!(config.tools.maw);
        assert!(!config.tools.crit);
        assert!(config.review.enabled);
        assert_eq!(config.review.reviewers, vec!["security"]);
        assert_eq!(
            config.project.install_command,
            Some("just install".to_string())
        );
        assert_eq!(config.project.languages, vec!["rust"]);

        let dev = config.agents.dev.unwrap();
        assert_eq!(dev.model, "opus");
        assert_eq!(dev.max_loops, 20);
        assert!(dev.missions.is_some());
    }

    #[test]
    fn test_config_version_matches() {
        // Ensure CONFIG_VERSION is a valid semver-ish string
        assert!(CONFIG_VERSION.starts_with("1.0."));
    }

    #[test]
    fn test_validate_name_valid() {
        assert!(validate_name("myproject", "test").is_ok());
        assert!(validate_name("my-project", "test").is_ok());
        assert!(validate_name("project123", "test").is_ok());
        assert!(validate_name("a", "test").is_ok());
    }

    #[test]
    fn test_validate_name_invalid() {
        assert!(validate_name("", "test").is_err()); // empty
        assert!(validate_name("-starts-dash", "test").is_err()); // leading dash
        assert!(validate_name("ends-dash-", "test").is_err()); // trailing dash
        assert!(validate_name("Has Uppercase", "test").is_err()); // uppercase
        assert!(validate_name("has space", "test").is_err()); // space
        assert!(validate_name("path/../traversal", "test").is_err()); // path chars
        assert!(validate_name("a;rm -rf /", "test").is_err()); // injection
        assert!(validate_name(&"a".repeat(65), "test").is_err()); // too long
    }

    #[test]
    fn test_fetch_gitignore_validates_languages() {
        // Unknown language should be rejected before URL construction
        let result = fetch_gitignore(&["malicious/../../etc".to_string()]);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("unknown language"));
    }
}
