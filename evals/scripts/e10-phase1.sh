#!/usr/bin/env bash
set -euo pipefail

# E10 Phase 1: Alpha Triage + Implement + Discover Issue (alpha-dev, Opus)
# Alpha-dev triages inbox, claims bead, creates workspace, implements POST /users,
# discovers beta's validate_email rejects +, communicates with beta-dev via bus.

source "${1:?Usage: e10-phase1.sh <path-to-.eval-env>}"

PHASE="phase1"
ARTIFACTS="$EVAL_DIR/artifacts"
mkdir -p "$ARTIFACTS"

cd "$ALPHA_DIR"

echo "=== E10 Phase 1: Alpha Triage + Implement + Discover ==="
echo "ALPHA_DEV=$ALPHA_DEV"
echo "ALPHA_DIR=$ALPHA_DIR"
echo "BEAD=$BEAD"

PROMPT="You are dev agent \"${ALPHA_DEV}\" for project \"alpha\".
Your project directory is: ${ALPHA_DIR}
Use --agent ${ALPHA_DEV} on ALL bus, crit, and br mutation commands.
Use --actor ${ALPHA_DEV} on br mutations and --author ${ALPHA_DEV} on br comments.
Set BOTBUS_DATA_DIR=${BOTBUS_DATA_DIR} in your environment for all bus commands.

Execute the steps below, then STOP.

1. TRIAGE:
   - Check inbox: bus inbox --agent ${ALPHA_DEV} --channels alpha --mark-read
   - Check ready beads: br ready
   - Read the bead: br show ${BEAD}

2. START:
   - br update --actor ${ALPHA_DEV} ${BEAD} --status=in_progress
   - bus claims stake --agent ${ALPHA_DEV} \"bead://alpha/${BEAD}\" -m \"${BEAD}\"
   - maw ws create --random — note the workspace name (\$WS) and absolute path (\$WS_PATH)
   - bus claims stake --agent ${ALPHA_DEV} \"workspace://alpha/\$WS\" -m \"${BEAD}\"
   - All file operations MUST use the absolute workspace path. For jj: maw ws jj \$WS <args>.
   - Do NOT cd into the workspace directory.

3. WORK:
   - Implement a POST /users endpoint in the workspace:
     - Accept JSON: {\"name\": \"...\", \"email\": \"...\"}
     - Validate email using beta::validate_email()
     - On success: add user to AppState.users, return 201 with the created user
     - On validation failure: return 400 with error message
   - Add the handler to the router in src/main.rs
   - Write tests including: user+tag@example.com (subaddressing / plus-addressing)
   - Run: cd \$WS_PATH && cargo test
   - When the plus-address test fails, investigate beta's code:
     - Read ${BETA_DIR}/src/lib.rs — examine the character whitelist in validate_email
   - Describe the change: maw ws jj \$WS describe -m \"feat: add POST /users registration with email validation\"

4. DISCOVER + COMMUNICATE:
   - Discover the beta project: bus history projects -n 10
   - Send a message to beta-dev asking about the behavior. Be collaborative — ask if the + exclusion is intentional, don't just file a bug:
     bus send --agent ${ALPHA_DEV} beta \"Hey @beta-dev — I'm using validate_email() in alpha's new registration endpoint and hit an issue: it rejects user+tag@example.com. We need subaddressing support (plus addressing). Is the + exclusion intentional? The local-part whitelist only allows alphanumeric, dots, hyphens, underscores.\" -L feedback
   - Add a progress comment on the bead:
     br comments add --actor ${ALPHA_DEV} --author ${ALPHA_DEV} ${BEAD} \"Blocked: beta validate_email rejects + in local part. Asked beta-dev about it on bus.\"

5. STOP HERE. Do NOT close the bead. Do NOT merge the workspace. Wait for beta-dev's response.

Key rules:
- All file operations use the absolute workspace path from maw ws create output
- Run br commands from the project root (${ALPHA_DIR}), not from inside the workspace
- Use jj via maw ws jj, not git
- The beta library is at ${BETA_DIR} — you can read its source to investigate"

echo "$PROMPT" > "$ARTIFACTS/$PHASE.prompt.md"

botbox run-agent claude -p "$PROMPT" -m opus -t 900 \
  > "$ARTIFACTS/$PHASE.stdout.log" 2> "$ARTIFACTS/$PHASE.stderr.log" \
  || echo "PHASE $PHASE exited with code $?"

# --- Discover workspace name/path for subsequent phases ---
# maw ws list JSON doesn't include path — construct from name.
# Prefer non-default workspace (agent should have created one via maw ws create --random).
WS=$(cd "$ALPHA_DIR" && maw ws list --format json 2>/dev/null | jq -r '[.[] | select(.is_default == false)] | .[0].name // empty')
if [[ -z "$WS" ]]; then
  # Fallback to default workspace if agent didn't create a named one
  WS="default"
fi

if [[ "$WS" == "default" ]]; then
  WS_PATH="$ALPHA_DIR"
else
  WS_PATH="$ALPHA_DIR/.workspaces/$WS"
fi

if [[ -n "$WS" ]]; then
  echo "export WS=\"$WS\"" >> "$EVAL_DIR/.eval-env"
  echo "export WS_PATH=\"$WS_PATH\"" >> "$EVAL_DIR/.eval-env"
  echo "Workspace: $WS at $WS_PATH"
else
  echo "WARNING: No workspace found after Phase 1"
fi

echo ""
echo "=== Phase 1 Complete ==="
