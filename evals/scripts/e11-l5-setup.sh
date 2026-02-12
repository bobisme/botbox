#!/usr/bin/env bash
set -euo pipefail

# E11-L5 Coordination Eval — Setup
# Creates a Rust CLI project (taskr) with three subcommands that share a core module.
# The shared core module (Task trait, TaskResult enum, Config struct) forces workers
# to coordinate when they change shared types.
#
# The taskr project is a task runner CLI with:
#   taskr run <task-file>        — parse + execute task definitions (todo!)
#   taskr list [--format ...]    — list available tasks from config (todo!)
#   taskr validate <task-file>   — check task file syntax without executing (todo!)
#
# All three subcommands share src/core/ (Task trait, Config, TaskResult).
# Does NOT send the task-request — that goes in the run script.

# --- Preflight ---
REQUIRED_CMDS=(botbox bus br bv maw crit botty jj cargo jq)
for cmd in "${REQUIRED_CMDS[@]}"; do
  command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd" >&2; exit 1; }
done

# --- Paths and identities ---
EVAL_BASE="${EVAL_BASE:-${HOME}/.cache/botbox-evals}"
mkdir -p "$EVAL_BASE"
EVAL_DIR=$(mktemp -d "$EVAL_BASE/e11-l5-XXXXXXXXXX")
PROJECT_DIR="$EVAL_DIR/taskr"
PROJECT_REMOTE="$EVAL_DIR/taskr-remote.git"
mkdir -p "$PROJECT_DIR" "$EVAL_DIR/artifacts"

TASKR_DEV="taskr-dev"

export BOTBUS_DATA_DIR="$EVAL_DIR/.botbus"
bus init

# --- Tool versions ---
{
  echo "timestamp=$(date -Iseconds)"
  for cmd in botbox bus br bv maw crit botty jj cargo; do
    echo "$cmd=$($cmd --version 2>/dev/null || echo unknown)"
  done
  echo "eval=e11-l5"
} > "$EVAL_DIR/artifacts/tool-versions.env"

# ============================================================
# Fake git remote (so maw push / maw release succeed)
# ============================================================
git init --bare "$PROJECT_REMOTE"

# ============================================================
# Create taskr project
# ============================================================
cd "$PROJECT_DIR"
jj git init
jj git remote add origin "$PROJECT_REMOTE"

mkdir -p src/core src/commands data

# --- Cargo.toml ---
cat > Cargo.toml << 'CARGO_EOF'
[package]
name = "taskr"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "taskr"
path = "src/main.rs"

[dependencies]
clap = { version = "4", features = ["derive"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"
thiserror = "2"
CARGO_EOF

# --- src/main.rs (clap dispatch — delegates to command modules) ---
cat > src/main.rs << 'RUST_EOF'
use clap::{Parser, Subcommand};

mod core;
mod commands;

#[derive(Parser)]
#[command(name = "taskr", version, about = "Task runner CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Execute tasks from a task file
    Run {
        /// Path to the task file (TOML format)
        task_file: String,
        /// Only run tasks matching this tag
        #[arg(long)]
        tag: Option<String>,
        /// Dry-run mode: parse and validate but don't execute
        #[arg(long)]
        dry_run: bool,
        /// Output results as JSON
        #[arg(long)]
        json: bool,
    },
    /// List available tasks from a config or task file
    List {
        /// Path to the task file or config directory
        #[arg(default_value = ".")]
        path: String,
        /// Output format: table or json
        #[arg(long, default_value = "table")]
        format: String,
        /// Filter tasks by tag
        #[arg(long)]
        tag: Option<String>,
        /// Show only task names (one per line)
        #[arg(long)]
        names_only: bool,
    },
    /// Validate task file syntax without executing
    Validate {
        /// Path to the task file (TOML format)
        task_file: String,
        /// Output validation results as JSON
        #[arg(long)]
        json: bool,
        /// Also check for unreachable tasks (dependency cycles)
        #[arg(long)]
        check_deps: bool,
    },
}

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Run { task_file, tag, dry_run, json } => {
            commands::run::execute(&task_file, tag.as_deref(), dry_run, json)
        }
        Commands::List { path, format, tag, names_only } => {
            commands::list::execute(&path, &format, tag.as_deref(), names_only)
        }
        Commands::Validate { task_file, json, check_deps } => {
            commands::validate::execute(&task_file, json, check_deps)
        }
    };

    if let Err(e) = result {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}
RUST_EOF

# --- src/commands/mod.rs ---
cat > src/commands/mod.rs << 'RUST_EOF'
pub mod run;
pub mod list;
pub mod validate;
RUST_EOF

# --- src/core/mod.rs (shared types — Task trait, TaskResult enum, Config struct) ---
cat > src/core/mod.rs << 'RUST_EOF'
//! Core types shared by ALL taskr subcommands.
//!
//! This module defines the fundamental types that run, list, and validate all depend on.
//! Changes here affect ALL subcommands — coordinate with sibling workers if you modify
//! any type signatures.
//!
//! ## Types to implement
//!
//! ### Task trait
//! The core abstraction for executable tasks. Every task parsed from a TOML file
//! must implement this trait.
//!
//! ```rust,ignore
//! pub trait Task: std::fmt::Debug {
//!     /// Human-readable name of this task
//!     fn name(&self) -> &str;
//!     /// Tags for filtering (e.g., ["build", "test", "deploy"])
//!     fn tags(&self) -> &[String];
//!     /// Names of tasks this task depends on (must run first)
//!     fn dependencies(&self) -> &[String];
//!     /// Execute the task with the given config, returning a result
//!     fn execute(&self, config: &Config) -> TaskResult;
//!     /// Validate the task definition without executing (check required fields, etc.)
//!     fn validate(&self) -> Vec<ValidationIssue>;
//! }
//! ```
//!
//! ### TaskResult enum
//! Represents the outcome of executing a task.
//!
//! ```rust,ignore
//! pub enum TaskResult {
//!     Success { output: String, duration_ms: u64 },
//!     Failure { error: String, duration_ms: u64 },
//!     Skipped { reason: String },
//! }
//! ```
//!
//! ### ValidationIssue struct
//! Represents a problem found during validation.
//!
//! ```rust,ignore
//! pub struct ValidationIssue {
//!     pub severity: IssueSeverity,
//!     pub message: String,
//!     pub task_name: String,
//! }
//!
//! pub enum IssueSeverity { Error, Warning, Info }
//! ```
//!
//! ### Config struct
//! Runtime configuration loaded from TOML.
//!
//! ```rust,ignore
//! pub struct Config {
//!     pub project_name: String,
//!     pub task_dir: String,
//!     pub verbose: bool,
//!     pub env: HashMap<String, String>,
//! }
//! ```
//!
//! ## Implementation notes
//! - Config is parsed from TOML by the config submodule
//! - ShellTask (a concrete Task impl) executes shell commands
//! - Task files are TOML with [[task]] arrays
//! - Each task has: name, command, tags (optional), depends_on (optional)

pub mod config;

use std::collections::HashMap;

// TODO: Implement the Task trait as described above.
// All three subcommands (run, list, validate) depend on this trait.
// The trait must be object-safe so we can use Box<dyn Task>.
pub trait Task: std::fmt::Debug {
    fn name(&self) -> &str;
    fn tags(&self) -> &[String];
    fn dependencies(&self) -> &[String];
    fn execute(&self, config: &Config) -> TaskResult;
    fn validate(&self) -> Vec<ValidationIssue>;
}

// TODO: Implement TaskResult enum as described above.
// Used by run (to report results) and validate (to simulate dry-run).
pub enum TaskResult {
    Success { output: String, duration_ms: u64 },
    Failure { error: String, duration_ms: u64 },
    Skipped { reason: String },
}

// TODO: Implement ValidationIssue and IssueSeverity as described above.
// Used by validate (primary) and list (to show health status).
#[derive(Debug)]
pub struct ValidationIssue {
    pub severity: IssueSeverity,
    pub message: String,
    pub task_name: String,
}

#[derive(Debug)]
pub enum IssueSeverity {
    Error,
    Warning,
    Info,
}

// TODO: Implement Config struct as described above.
// All subcommands receive a Config reference. Parsed from TOML by config module.
pub struct Config {
    pub project_name: String,
    pub task_dir: String,
    pub verbose: bool,
    pub env: HashMap<String, String>,
}

// TODO: Implement ShellTask — a concrete type implementing the Task trait.
// ShellTask runs a shell command (via std::process::Command).
// Fields: name, command, tags, depends_on, working_dir (optional), env (optional).
//
// Parse from TOML [[task]] entries:
//   [[task]]
//   name = "build"
//   command = "cargo build"
//   tags = ["build"]
//   depends_on = ["clean"]
//   working_dir = "."
//   env = { RUST_LOG = "info" }
//
// The execute() method should:
// 1. Set up std::process::Command with the shell command
// 2. Apply working_dir and env overrides from both ShellTask and Config
// 3. Capture stdout+stderr, measure duration
// 4. Return TaskResult::Success or TaskResult::Failure

#[derive(Debug, serde::Deserialize)]
pub struct ShellTask {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub working_dir: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

todo!("Implement Task trait for ShellTask");

// TODO: Implement parse_task_file(path: &str) -> Result<Vec<ShellTask>, TaskrError>
// Reads a TOML file, deserializes [[task]] array into Vec<ShellTask>.
// Returns TaskrError::FileNotFound if path doesn't exist.
// Returns TaskrError::ParseError if TOML is invalid.

todo!("Implement parse_task_file function");

// TODO: Implement TaskrError enum with thiserror
// Variants: FileNotFound(String), ParseError(String), ExecutionError(String),
//           CycleDetected(Vec<String>), TaskNotFound(String)

todo!("Implement TaskrError");
RUST_EOF

# --- src/core/config.rs (TOML config parser — todo stub) ---
cat > src/core/config.rs << 'RUST_EOF'
//! TOML configuration parser for taskr.
//!
//! Reads a taskr.toml config file and produces a Config struct.
//! Config files have this structure:
//!
//! ```toml
//! [project]
//! name = "my-project"
//! task_dir = "tasks"
//! verbose = false
//!
//! [env]
//! RUST_LOG = "info"
//! DATABASE_URL = "sqlite://test.db"
//! ```
//!
//! ## Functions to implement
//!
//! ### load_config(path: &str) -> Result<Config, TaskrError>
//! 1. Read the file at `path` (return TaskrError::FileNotFound if missing)
//! 2. Parse as TOML (return TaskrError::ParseError if invalid)
//! 3. Extract [project] fields into Config struct
//! 4. Extract [env] table into Config.env HashMap
//! 5. Apply defaults: project_name="unnamed", task_dir=".", verbose=false
//!
//! ### default_config() -> Config
//! Returns a Config with all default values. Used when no config file exists.
//!
//! Both functions are used by all three subcommands.

use super::{Config, TaskrError};

todo!("Implement load_config and default_config");
RUST_EOF

# --- src/commands/run.rs (todo stub) ---
cat > src/commands/run.rs << 'RUST_EOF'
//! taskr run — execute tasks from a task file.
//!
//! Parses the task file, resolves dependency order, and executes tasks sequentially.
//! Respects --tag filter, --dry-run mode, and --json output.
//!
//! ## Requirements
//!
//! 1. Parse task file using core::parse_task_file()
//! 2. Load config from taskr.toml in current dir (or use default_config if missing)
//! 3. Filter by --tag if provided (only run tasks matching the tag)
//! 4. Resolve execution order via topological sort on dependencies
//!    - If a cycle is detected, return TaskrError::CycleDetected
//!    - If a dependency references a nonexistent task, return TaskrError::TaskNotFound
//! 5. Execute tasks in order using task.execute(config)
//!    - If --dry-run: validate only, report what WOULD run, don't execute
//!    - If a task fails: skip dependents, continue with independent tasks
//! 6. Output results:
//!    - Plain: "✓ build (45ms)" or "✗ test: assertion failed (120ms)" or "⊘ deploy: skipped (dependency failed)"
//!    - JSON: [{"name":"build","status":"success","output":"...","duration_ms":45}, ...]
//!    - Summary line: "3 passed, 1 failed, 1 skipped"
//!
//! ## Dependencies
//! - core::parse_task_file, core::Config, core::Task, core::TaskResult
//! - core::config::load_config

use crate::core;

pub fn execute(
    _task_file: &str,
    _tag: Option<&str>,
    _dry_run: bool,
    _json: bool,
) -> Result<(), core::TaskrError> {
    todo!("Implement run: parse tasks, resolve deps via toposort, execute, report results")
}
RUST_EOF

# --- src/commands/list.rs (todo stub) ---
cat > src/commands/list.rs << 'RUST_EOF'
//! taskr list — list available tasks from a task file or config directory.
//!
//! Discovers task files and lists their tasks with metadata.
//!
//! ## Requirements
//!
//! 1. If path is a file: parse it as a task file
//! 2. If path is a directory: find all *.toml files, parse each as task file
//! 3. Filter by --tag if provided
//! 4. Output formats:
//!    - table: aligned columns — Name | Tags | Deps | Status
//!      Status = "ready" (no deps or all deps exist) or "blocked" (missing deps)
//!    - json: [{"name":"build","tags":["build"],"dependencies":[],"status":"ready"}, ...]
//!    - --names-only: just task names, one per line (for scripting)
//! 5. Sort tasks alphabetically by name
//!
//! ## Dependencies
//! - core::parse_task_file, core::ShellTask, core::Task
//! - core::config::load_config (for finding task_dir from config)

use crate::core;

pub fn execute(
    _path: &str,
    _format: &str,
    _tag: Option<&str>,
    _names_only: bool,
) -> Result<(), core::TaskrError> {
    todo!("Implement list: discover task files, parse, filter, format output")
}
RUST_EOF

# --- src/commands/validate.rs (todo stub) ---
cat > src/commands/validate.rs << 'RUST_EOF'
//! taskr validate — validate task file syntax without executing.
//!
//! Checks task definitions for correctness and reports issues.
//!
//! ## Requirements
//!
//! 1. Parse task file using core::parse_task_file()
//! 2. For each task, call task.validate() to get ValidationIssues
//! 3. Check cross-task issues:
//!    - Duplicate task names → Error
//!    - References to nonexistent dependencies → Error
//!    - Dependency cycles (--check-deps) → Error
//!    - Tasks with no command → Warning
//!    - Unused tasks (nothing depends on them, not top-level) → Info
//! 4. Output:
//!    - Plain: severity icon + message per issue, summary line
//!      "✗ ERROR: task 'deploy' depends on nonexistent task 'package'"
//!      "⚠ WARNING: task 'clean' has empty command"
//!      "ℹ INFO: task 'lint' is not depended on by any other task"
//!      "Validation: 1 error, 1 warning, 1 info"
//!    - JSON: {"valid": false, "issues": [{"severity":"error","message":"...","task":"deploy"}], "task_count": 5}
//! 5. Exit with error if any Error-severity issues found
//!
//! ## Dependencies
//! - core::parse_task_file, core::Task, core::ValidationIssue, core::IssueSeverity

use crate::core;

pub fn execute(
    _task_file: &str,
    _json: bool,
    _check_deps: bool,
) -> Result<(), core::TaskrError> {
    todo!("Implement validate: parse, check each task, cross-task checks, report issues")
}
RUST_EOF

# --- Sample task files (TOML format) ---
cat > data/simple.toml << 'DATA_EOF'
[[task]]
name = "clean"
command = "rm -rf target"
tags = ["build"]

[[task]]
name = "build"
command = "cargo build"
tags = ["build"]
depends_on = ["clean"]

[[task]]
name = "test"
command = "cargo test"
tags = ["test"]
depends_on = ["build"]

[[task]]
name = "lint"
command = "cargo clippy"
tags = ["quality"]
depends_on = ["build"]

[[task]]
name = "release"
command = "cargo build --release"
tags = ["build", "release"]
depends_on = ["test", "lint"]
DATA_EOF

cat > data/complex.toml << 'DATA_EOF'
[[task]]
name = "setup-db"
command = "echo 'Creating database...'"
tags = ["infra"]
env = { DATABASE_URL = "sqlite://test.db" }

[[task]]
name = "migrate"
command = "echo 'Running migrations...'"
tags = ["infra"]
depends_on = ["setup-db"]

[[task]]
name = "seed"
command = "echo 'Seeding test data...'"
tags = ["infra", "test"]
depends_on = ["migrate"]

[[task]]
name = "build-api"
command = "echo 'Building API server...'"
tags = ["build"]

[[task]]
name = "build-worker"
command = "echo 'Building background worker...'"
tags = ["build"]

[[task]]
name = "test-api"
command = "echo 'Testing API...'"
tags = ["test"]
depends_on = ["build-api", "seed"]

[[task]]
name = "test-worker"
command = "echo 'Testing worker...'"
tags = ["test"]
depends_on = ["build-worker", "seed"]

[[task]]
name = "integration"
command = "echo 'Running integration tests...'"
tags = ["test", "integration"]
depends_on = ["test-api", "test-worker"]

[[task]]
name = "deploy"
command = "echo 'Deploying...'"
tags = ["deploy"]
depends_on = ["integration"]
DATA_EOF

cat > data/invalid.toml << 'DATA_EOF'
# Invalid task file for testing validate command
[[task]]
name = "build"
command = "cargo build"

[[task]]
name = "build"
command = "cargo build --release"

[[task]]
name = "test"
command = "cargo test"
depends_on = ["nonexistent"]

[[task]]
name = "a"
command = "echo a"
depends_on = ["b"]

[[task]]
name = "b"
command = "echo b"
depends_on = ["a"]

[[task]]
name = "empty"
DATA_EOF

cat > data/taskr.toml << 'DATA_EOF'
[project]
name = "sample-project"
task_dir = "data"
verbose = false

[env]
RUST_LOG = "info"
APP_ENV = "test"
DATA_EOF

# --- .gitignore ---
cat > .gitignore << 'GITIGNORE_EOF'
/target/
GITIGNORE_EOF

# --- Compile to verify skeleton ---
# The skeleton has todo!() at module level which won't compile,
# so we just verify the project structure exists.
# cargo check would fail due to todo!() at module level — that's intentional.
echo "Project structure created (todo!() stubs — won't compile until implemented)"

# --- Initial commit ---
jj describe -m "taskr: CLI skeleton with shared core module and three todo subcommands"
jj bookmark create main -r @
jj git push --bookmark main
jj new

# ============================================================
# Initialize with botbox (maw v2 bare repo layout)
# ============================================================
BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" \
  botbox init --name taskr --type cli --tools beads,maw,crit,botbus,botty --init-beads --no-interactive

# ============================================================
# Patch .botbox.json: enable missions, disable review, set models
# ============================================================
cd "$PROJECT_DIR"
CONFIG_FILE=".botbox.json"
PATCHED=$(jq '
  .review.enabled = false |
  .agents.dev.model = "opus" |
  .agents.dev.timeout = 900 |
  .agents.dev.missions.enabled = true |
  .agents.dev.missions.maxWorkers = 3 |
  .agents.dev.missions.maxChildren = 8 |
  .agents.dev.missions.checkpointIntervalSec = 30 |
  .agents.worker.model = "sonnet" |
  .agents.worker.timeout = 600
' "$CONFIG_FILE")
echo "$PATCHED" > "$CONFIG_FILE"

echo "Patched .botbox.json:"
jq '{review: .review, agents: .agents}' "$CONFIG_FILE"

# ============================================================
# Fix hooks: add BOTBUS_DATA_DIR to --env-inherit
# ============================================================
_fix_hooks() {
  ALL_HOOKS=$(BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus hooks list --format json 2>/dev/null)
  HOOK_COUNT=$(echo "$ALL_HOOKS" | jq '.hooks | length' 2>/dev/null || echo "0")

  for i in $(seq 0 $((HOOK_COUNT - 1))); do
    HOOK=$(echo "$ALL_HOOKS" | jq ".hooks[$i]" 2>/dev/null)
    hook_id=$(echo "$HOOK" | jq -r '.id')
    HOOK_CHANNEL=$(echo "$HOOK" | jq -r '.channel')
    HOOK_CWD=$(echo "$HOOK" | jq -r '.cwd')
    COND_TYPE=$(echo "$HOOK" | jq -r '.condition.type')

    readarray -t CMD_ARRAY < <(echo "$HOOK" | jq -r '.command[] | if startswith("BOTBUS_CHANNEL") then . + ",BOTBUS_DATA_DIR" else . end')

    BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus hooks remove "$hook_id" 2>/dev/null || true

    ADD_CMD=(bus hooks add --channel "$HOOK_CHANNEL" --cwd "$HOOK_CWD")
    if [[ "$COND_TYPE" == "claim_available" ]]; then
      CLAIM_PATTERN=$(echo "$HOOK" | jq -r '.condition.pattern')
      ADD_CMD+=(--claim "$CLAIM_PATTERN" --release-on-exit)
    elif [[ "$COND_TYPE" == "mention_received" ]]; then
      MENTION_AGENT=$(echo "$HOOK" | jq -r '.condition.agent')
      ADD_CMD+=(--mention "$MENTION_AGENT")
    fi

    ADD_CMD+=(--)
    ADD_CMD+=("${CMD_ARRAY[@]}")

    BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" "${ADD_CMD[@]}" 2>&1 || \
      echo "WARNING: Failed to update hook $hook_id with BOTBUS_DATA_DIR"
  done
}
_fix_hooks

BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus hooks list > "$EVAL_DIR/artifacts/hooks-after-init.txt" 2>&1

# ============================================================
# Projects registry
# ============================================================
BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus send --agent "$TASKR_DEV" projects \
  "project: taskr  repo: $PROJECT_DIR  lead: $TASKR_DEV  tools: cli, task-runner"

# Mark registry read
BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus inbox --agent "$TASKR_DEV" --channels projects --mark-read >/dev/null 2>&1 || true

# ============================================================
# Save env
# ============================================================
cat > "$EVAL_DIR/.eval-env" << EOF
export EVAL_DIR="$EVAL_DIR"
export BOTBUS_DATA_DIR="$EVAL_DIR/.botbus"
export PROJECT_DIR="$PROJECT_DIR"
export TASKR_DEV="$TASKR_DEV"
EOF

echo ""
echo "=== E11-L5 Setup Complete ==="
echo "EVAL_DIR=$EVAL_DIR"
echo "PROJECT_DIR=$PROJECT_DIR"
echo "TASKR_DEV=$TASKR_DEV"
echo ""
echo "Mission config:"
echo "  missions.enabled=true, maxWorkers=3, maxChildren=8"
echo "  review.enabled=false"
echo "  worker.model=sonnet"
echo ""
echo "Project: taskr — CLI with shared core module and three todo!() subcommands:"
echo "  src/core/mod.rs       — Task trait, TaskResult, Config, ShellTask (SHARED)"
echo "  src/core/config.rs    — TOML config parser (SHARED)"
echo "  src/commands/run.rs   — taskr run <task-file>"
echo "  src/commands/list.rs  — taskr list [--format json|table]"
echo "  src/commands/validate.rs — taskr validate <task-file>"
echo ""
echo "COORDINATION REQUIREMENT:"
echo "  All subcommands depend on core types. If one worker changes the"
echo "  Task trait or Config struct, siblings must adapt."
echo ""
echo "No bead seeded — !mission handler in respond.mjs creates it."
echo ""
echo "Source .eval-env before running:"
echo "  source $EVAL_DIR/.eval-env"
echo ""
