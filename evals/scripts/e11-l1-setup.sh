#!/usr/bin/env bash
set -euo pipefail

# E11-L1 Botty-Native End-to-End Eval — Setup
# Creates a single Rust/Axum project with isolated botbus, seeds one bead,
# and registers hooks via botbox init. Does NOT send the task-request —
# that goes in the run script (it triggers the hook → botty spawn).
#
# This is the simplest possible botty-native eval: one project, one agent,
# one bead. Tests the full spawn chain: message → hook → botty → loop script.

# --- Preflight: fail fast on missing dependencies ---
REQUIRED_CMDS=(botbox bus br bv maw crit botty jj cargo jq)
for cmd in "${REQUIRED_CMDS[@]}"; do
  command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd" >&2; exit 1; }
done

# --- Paths and identities ---
EVAL_BASE="${EVAL_BASE:-${HOME}/.cache/botbox-evals}"
mkdir -p "$EVAL_BASE"
EVAL_DIR=$(mktemp -d "$EVAL_BASE/e11-l1-XXXXXXXXXX")
PROJECT_DIR="$EVAL_DIR/echo"
mkdir -p "$PROJECT_DIR" "$EVAL_DIR/artifacts"

ECHO_DEV="echo-dev"

export BOTBUS_DATA_DIR="$EVAL_DIR/.botbus"
bus init

# --- Capture tool versions for forensics ---
{
  echo "timestamp=$(date -Iseconds)"
  for cmd in botbox bus br bv maw crit botty jj cargo; do
    echo "$cmd=$($cmd --version 2>/dev/null || echo unknown)"
  done
  echo "eval=e11-l1"
} > "$EVAL_DIR/artifacts/tool-versions.env"

# --- Echo project ---
# Create source files FIRST (before botbox init converts to bare repo via maw init)
cd "$PROJECT_DIR"
jj git init

mkdir -p src

cat > Cargo.toml << 'CARGO_EOF'
[package]
name = "echo"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "0.8"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
CARGO_EOF

cat > src/main.rs << 'RUST_EOF'
use axum::{response::IntoResponse, routing::get, Json, Router};

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({"status": "ok"}))
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(health));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
RUST_EOF

cargo check

# Initial commit and bookmark (before maw init converts to bare)
jj describe -m "echo: initial API with health endpoint"
jj bookmark create main -r @
jj new

# botbox init handles: maw init (-> bare repo + ws/default/), br init, crit init, hooks
BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" \
  botbox init --name echo --type api --tools beads,maw,crit,botbus,botty --reviewers security --init-beads --no-interactive

# --- Fix hooks: add BOTBUS_DATA_DIR to --env-inherit ---
# botty starts agents with a clean env. botbox init registers hooks with
# --env-inherit for BOTBUS_CHANNEL etc but NOT BOTBUS_DATA_DIR. Without it,
# spawned agents talk to the system botbus instead of the eval's isolated one.
#
# Strategy: for each hook, modify its command array to append BOTBUS_DATA_DIR
# to the --env-inherit value, then remove and re-register.
ALL_HOOKS=$(BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus hooks list --format json 2>/dev/null)

for hook_id in $(echo "$ALL_HOOKS" | jq -r '.hooks[]?.id' 2>/dev/null); do
  HOOK=$(echo "$ALL_HOOKS" | jq ".hooks[] | select(.id == \"$hook_id\")" 2>/dev/null)

  # Build the new command: find --env-inherit arg and append BOTBUS_DATA_DIR
  NEW_CMD=$(echo "$HOOK" | jq -c '[.command[] | if (. | startswith("BOTBUS_CHANNEL")) then (. + ",BOTBUS_DATA_DIR") else . end]')

  # Extract hook properties
  HOOK_CHANNEL=$(echo "$HOOK" | jq -r '.channel' 2>/dev/null)
  HOOK_CWD=$(echo "$HOOK" | jq -r '.cwd' 2>/dev/null)
  COND_TYPE=$(echo "$HOOK" | jq -r '.condition.type' 2>/dev/null)

  # Remove old hook
  BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus hooks remove "$hook_id" 2>/dev/null || true

  # Re-register with condition-specific flags
  ADD_ARGS="--channel $HOOK_CHANNEL --cwd $HOOK_CWD"
  if [[ "$COND_TYPE" == "claim_available" ]]; then
    CLAIM_PATTERN=$(echo "$HOOK" | jq -r '.condition.pattern' 2>/dev/null)
    ADD_ARGS="$ADD_ARGS --claim $CLAIM_PATTERN"
  elif [[ "$COND_TYPE" == "mention_received" ]]; then
    MENTION_AGENT=$(echo "$HOOK" | jq -r '.condition.agent' 2>/dev/null)
    ADD_ARGS="$ADD_ARGS --mention $MENTION_AGENT"
  fi

  # Build command args from JSON array
  CMD_ARGS=$(echo "$NEW_CMD" | jq -r '.[]' 2>/dev/null | while IFS= read -r arg; do printf '%q ' "$arg"; done)

  BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" eval "bus hooks add $ADD_ARGS $CMD_ARGS" 2>/dev/null || \
    echo "WARNING: Failed to update hook $hook_id with BOTBUS_DATA_DIR"
done

BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus hooks list > "$EVAL_DIR/artifacts/hooks-after-init.txt" 2>&1

# --- Seed work ---
cd "$PROJECT_DIR"
BEAD=$(BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" maw exec default -- br create --actor setup --owner "$ECHO_DEV" \
  --title="Add GET /version endpoint returning JSON with name and version" \
  --description="Implement a GET /version endpoint that returns {\"name\":\"echo\",\"version\":\"0.1.0\"}. Add the route to the existing Router. The response must be JSON with Content-Type application/json." \
  --type=task --priority=2 2>&1 | grep -oP 'bd-\w+')

# Do NOT send task-request yet — that goes in the run script (triggers the hook)

# --- Projects registry ---
BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus send --agent "$ECHO_DEV" projects \
  "project: echo  repo: $PROJECT_DIR  lead: $ECHO_DEV  tools: api, axum"

# Mark projects registry read (agents discover via bus history, not inbox)
BOTBUS_DATA_DIR="$EVAL_DIR/.botbus" bus inbox --agent "$ECHO_DEV" --channels projects --mark-read >/dev/null 2>&1 || true

# --- Save env ---
cat > "$EVAL_DIR/.eval-env" << EOF
export EVAL_DIR="$EVAL_DIR"
export BOTBUS_DATA_DIR="$EVAL_DIR/.botbus"
export PROJECT_DIR="$PROJECT_DIR"
export ECHO_DEV="$ECHO_DEV"
export BEAD="$BEAD"
EOF

echo ""
echo "=== E11-L1 Setup Complete ==="
echo "EVAL_DIR=$EVAL_DIR"
echo "PROJECT_DIR=$PROJECT_DIR"
echo "BEAD=$BEAD"
echo ""
echo "Source .eval-env before running:"
echo "  source $EVAL_DIR/.eval-env"
