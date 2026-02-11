#!/usr/bin/env bash
set -euo pipefail

# E11-L4 Mission Eval — Setup
# Creates a single Rust CLI project (futil) with three todo!() subcommands,
# enables missions in .botbox.json, and disables review.
#
# The futil project is a file utility CLI with:
#   futil stats <path>     — line/word/byte counts (todo!)
#   futil search <pat> <p> — regex search (todo!)
#   futil convert <in> -f  — format conversion json|csv (todo!)
#
# Does NOT send the task-request — that goes in the run script.

# --- Preflight ---
REQUIRED_CMDS=(botbox bus br bv maw crit botty jj cargo jq)
for cmd in "${REQUIRED_CMDS[@]}"; do
  command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd" >&2; exit 1; }
done

# --- Paths and identities ---
EVAL_BASE="${EVAL_BASE:-${HOME}/.cache/botbox-evals}"
mkdir -p "$EVAL_BASE"
EVAL_DIR=$(mktemp -d "$EVAL_BASE/e11-l4-XXXXXXXXXX")
PROJECT_DIR="$EVAL_DIR/futil"
PROJECT_REMOTE="$EVAL_DIR/futil-remote.git"
mkdir -p "$PROJECT_DIR" "$EVAL_DIR/artifacts"

FUTIL_DEV="futil-dev"

export BOTBUS_DATA_DIR="$EVAL_DIR/.botbus"
bus init

# --- Tool versions ---
{
  echo "timestamp=$(date -Iseconds)"
  for cmd in botbox bus br bv maw crit botty jj cargo; do
    echo "$cmd=$($cmd --version 2>/dev/null || echo unknown)"
  done
  echo "eval=e11-l4"
} > "$EVAL_DIR/artifacts/tool-versions.env"

# ============================================================
# Fake git remote (so maw push / maw release succeed)
# ============================================================
git init --bare "$PROJECT_REMOTE"

# ============================================================
# Create futil project
# ============================================================
cd "$PROJECT_DIR"
jj git init
jj git remote add origin "$PROJECT_REMOTE"

mkdir -p src data

# --- Cargo.toml ---
cat > Cargo.toml << 'CARGO_EOF'
[package]
name = "futil"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "futil"
path = "src/main.rs"

[dependencies]
clap = { version = "4", features = ["derive"] }
regex = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
csv = "1"
CARGO_EOF

# --- src/main.rs (clap skeleton with todo!() subcommands) ---
cat > src/main.rs << 'RUST_EOF'
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "futil", version, about = "File utility CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Show line, word, and byte counts for a file
    Stats {
        /// Path to the file
        path: String,
    },
    /// Search for a regex pattern in a file
    Search {
        /// Regex pattern to search for
        pattern: String,
        /// Path to the file
        path: String,
    },
    /// Convert between JSON and CSV formats
    Convert {
        /// Input file path
        input: String,
        /// Output format
        #[arg(short, long)]
        format: String,
    },
}

fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Stats { path: _ } => {
            todo!("Implement stats: count lines, words, and bytes")
        }
        Commands::Search { pattern: _, path: _ } => {
            todo!("Implement search: find regex matches with line numbers")
        }
        Commands::Convert { input: _, format: _ } => {
            todo!("Implement convert: transform between JSON and CSV")
        }
    }
}
RUST_EOF

# --- Sample data files ---
cat > data/sample.txt << 'DATA_EOF'
Hello world
This is a sample file for testing futil.
It has multiple lines with various words.
Numbers like 42 and 100 appear here too.
The quick brown fox jumps over the lazy dog.
DATA_EOF

cat > data/sample.csv << 'DATA_EOF'
name,age,city
Alice,30,New York
Bob,25,San Francisco
Charlie,35,Chicago
DATA_EOF

cat > data/sample.json << 'DATA_EOF'
[
  {"name": "Alice", "age": 30, "city": "New York"},
  {"name": "Bob", "age": 25, "city": "San Francisco"},
  {"name": "Charlie", "age": 35, "city": "Chicago"}
]
DATA_EOF

# --- .gitignore ---
cat > .gitignore << 'GITIGNORE_EOF'
/target/
GITIGNORE_EOF

# --- Compile to verify skeleton ---
cargo check

# --- Initial commit ---
jj describe -m "futil: CLI skeleton with three todo subcommands"
jj bookmark create main -r @
jj git push --bookmark main
jj new

# ============================================================
# Initialize with botbox (maw v2 bare repo layout)
# ============================================================
BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" \
  botbox init --name futil --type cli --tools beads,maw,crit,botbus,botty --init-beads --no-interactive

# ============================================================
# Patch .botbox.json: enable missions, disable review, set models
# ============================================================
cd "$PROJECT_DIR"
CONFIG_FILE="ws/default/.botbox.json"
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
BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus send --agent "$FUTIL_DEV" projects \
  "project: futil  repo: $PROJECT_DIR  lead: $FUTIL_DEV  tools: cli, file-utils"

# Mark registry read
BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus inbox --agent "$FUTIL_DEV" --channels projects --mark-read >/dev/null 2>&1 || true

# ============================================================
# Save env
# ============================================================
cat > "$EVAL_DIR/.eval-env" << EOF
export EVAL_DIR="$EVAL_DIR"
export BOTBUS_DATA_DIR="$EVAL_DIR/.botbus"
export PROJECT_DIR="$PROJECT_DIR"
export FUTIL_DEV="$FUTIL_DEV"
EOF

echo ""
echo "=== E11-L4 Setup Complete ==="
echo "EVAL_DIR=$EVAL_DIR"
echo "PROJECT_DIR=$PROJECT_DIR"
echo "FUTIL_DEV=$FUTIL_DEV"
echo ""
echo "Mission config:"
echo "  missions.enabled=true, maxWorkers=3, maxChildren=8"
echo "  review.enabled=false"
echo "  worker.model=sonnet"
echo ""
echo "Project: futil — CLI with three todo!() subcommands:"
echo "  futil stats <path>           — line/word/byte counts"
echo "  futil search <pattern> <path> — regex search"
echo "  futil convert <input> -f fmt  — JSON/CSV conversion"
echo ""
echo "No bead seeded — !mission handler in respond.mjs creates it."
echo ""
echo "Source .eval-env before running:"
echo "  source $EVAL_DIR/.eval-env"
echo ""
