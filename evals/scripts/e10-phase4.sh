#!/usr/bin/env bash
set -euo pipefail

# E10 Phase 4: Alpha Resumes + Completes + Requests Review (alpha-dev, Opus)
# Alpha-dev reads beta's fix announcement, verifies tests pass,
# completes implementation, creates crit review, requests alpha-security.

source "${1:?Usage: e10-phase4.sh <path-to-.eval-env>}"

PHASE="phase4"
ARTIFACTS="$EVAL_DIR/artifacts"
mkdir -p "$ARTIFACTS"

cd "$ALPHA_DIR"

# Re-discover workspace if not in env
if [[ -z "${WS:-}" ]]; then
  WS=$(maw ws list --format json 2>/dev/null | jq -r '[.[] | select(.is_default == false)] | .[0].name // empty')
  if [[ -z "$WS" ]]; then WS="default"; fi
fi
if [[ -z "${WS_PATH:-}" ]]; then
  if [[ "$WS" == "default" ]]; then
    WS_PATH="$ALPHA_DIR"
  else
    WS_PATH="$ALPHA_DIR/.workspaces/$WS"
  fi
fi

echo "=== E10 Phase 4: Alpha Resumes + Review Request ==="
echo "ALPHA_DEV=$ALPHA_DEV"
echo "ALPHA_DIR=$ALPHA_DIR"
echo "BEAD=$BEAD"
echo "WS=$WS"
echo "WS_PATH=$WS_PATH"

PROMPT="You are dev agent \"${ALPHA_DEV}\" for project \"alpha\".
Your project directory is: ${ALPHA_DIR}
Use --agent ${ALPHA_DEV} on ALL bus, crit, and br mutation commands.
Use --actor ${ALPHA_DEV} on br mutations and --author ${ALPHA_DEV} on br comments.
Set BOTBUS_DATA_DIR=${BOTBUS_DATA_DIR} in your environment for all bus commands.

You previously started work on bead ${BEAD} (POST /users registration) and discovered
that beta's validate_email rejected + characters. You asked beta-dev about it and they
have now fixed it.

Your workspace is: ${WS} at ${WS_PATH}

1. CHECK INBOX:
   - bus inbox --agent ${ALPHA_DEV} --channels alpha --mark-read
   - You should see beta-dev's fix announcement

2. VERIFY:
   - Run tests in your workspace: cd ${WS_PATH} && cargo test
   - The plus-address test should now pass (beta's fix was merged to main,
     and your Cargo.toml path dependency resolves to beta's main worktree)

3. COMPLETE:
   - Finish any remaining implementation work for POST /users
   - Make sure the endpoint handles both success (201) and validation failure (400)
   - Describe: maw ws jj ${WS} describe -m \"feat: add POST /users registration with email validation\"

4. REQUEST REVIEW:
   - Add a progress comment:
     br comments add --actor ${ALPHA_DEV} --author ${ALPHA_DEV} ${BEAD} \"Beta fixed validate_email. Tests pass. Implementation complete, requesting review.\"
   - Create a crit review: crit reviews create --agent ${ALPHA_DEV} --path ${WS_PATH}
   - Note the review ID from the output
   - Request review from alpha-security:
     crit reviews request <review-id> --reviewers ${ALPHA_SECURITY} --agent ${ALPHA_DEV}
   - Announce with @mention:
     bus send --agent ${ALPHA_DEV} alpha \"Review requested: <review-id> @${ALPHA_SECURITY}\" -L review-request

5. STOP HERE. Wait for the security review.

Key rules:
- All file operations use the absolute workspace path
- Run br commands from project root (${ALPHA_DIR}), not inside workspace
- Use jj via maw ws jj, not git"

echo "$PROMPT" > "$ARTIFACTS/$PHASE.prompt.md"

botbox run-agent claude -p "$PROMPT" -m opus -t 900 \
  > "$ARTIFACTS/$PHASE.stdout.log" 2> "$ARTIFACTS/$PHASE.stderr.log" \
  || echo "PHASE $PHASE exited with code $?"

# --- Discover review ID for subsequent phases ---
REVIEW_ID=$(crit reviews list --all-workspaces --path "$ALPHA_DIR" --format json 2>/dev/null | jq -r '.[-1].review_id // empty' || true)
if [[ -z "$REVIEW_ID" ]]; then
  # Fallback: grep the agent's stdout log for a review ID (cr-XXXX)
  REVIEW_ID=$(grep -oP 'cr-[a-z0-9]+' "$ARTIFACTS/$PHASE.stdout.log" 2>/dev/null | head -1 || true)
  if [[ -n "$REVIEW_ID" ]]; then
    echo "FALLBACK: REVIEW_ID=$REVIEW_ID recovered from stdout log (crit reviews list --all-workspaces failed)"
  fi
fi

if [[ -n "$REVIEW_ID" ]]; then
  echo "export REVIEW_ID=\"$REVIEW_ID\"" >> "$EVAL_DIR/.eval-env"
  echo "Review: $REVIEW_ID"
else
  echo "WARNING: No review ID found after Phase 4"
fi

echo ""
echo "=== Phase 4 Complete ==="
