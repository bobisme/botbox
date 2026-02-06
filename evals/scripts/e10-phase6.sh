#!/usr/bin/env bash
set -euo pipefail

# E10 Phase 6: Alpha Fixes Review Feedback (alpha-dev, Opus)
# Alpha-dev reads the security review block, fixes the /debug endpoint,
# replies on the crit thread, and re-requests review.

source "${1:?Usage: e10-phase6.sh <path-to-.eval-env>}"

PHASE="phase6"
ARTIFACTS="$EVAL_DIR/artifacts"
mkdir -p "$ARTIFACTS"

cd "$ALPHA_DIR"

# Re-discover state if not in env
if [[ -z "${REVIEW_ID:-}" ]]; then
  REVIEW_ID=$(crit reviews list --all-workspaces --path "$ALPHA_DIR" --format json 2>/dev/null | jq -r '.[-1].review_id // empty' || true)
fi
if [[ -z "${REVIEW_ID:-}" ]]; then
  REVIEW_ID=$(grep -oP 'cr-[a-z0-9]+' "$ARTIFACTS/phase4.stdout.log" 2>/dev/null | head -1 || true)
  if [[ -n "$REVIEW_ID" ]]; then
    echo "FALLBACK: REVIEW_ID=$REVIEW_ID recovered from phase4 log (crit reviews list --all-workspaces failed)"
  fi
fi
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
if [[ -z "${THREAD_ID:-}" ]]; then
  THREAD_ID=$(crit review "$REVIEW_ID" --path "$WS_PATH" --format json 2>/dev/null | jq -r '.threads[0].thread_id // empty' || true)
fi
if [[ -z "${THREAD_ID:-}" ]]; then
  THREAD_ID=$(grep -oP 'th-[a-z0-9]+' "$ARTIFACTS/phase5.stdout.log" 2>/dev/null | head -1 || true)
  if [[ -n "$THREAD_ID" ]]; then
    echo "FALLBACK: THREAD_ID=$THREAD_ID recovered from phase5 log (crit review --path failed)"
  fi
fi

echo "=== E10 Phase 6: Alpha Fixes Review Feedback ==="
echo "ALPHA_DEV=$ALPHA_DEV"
echo "REVIEW_ID=$REVIEW_ID"
echo "THREAD_ID=${THREAD_ID:-unknown}"
echo "WS=$WS"
echo "WS_PATH=$WS_PATH"

PROMPT="You are dev agent \"${ALPHA_DEV}\" for project \"alpha\".
Your project directory is: ${ALPHA_DIR}
Use --agent ${ALPHA_DEV} on ALL bus, crit, and br mutation commands.
Use --actor ${ALPHA_DEV} on br mutations and --author ${ALPHA_DEV} on br comments.
Set BOTBUS_DATA_DIR=${BOTBUS_DATA_DIR} in your environment for all bus commands.

Your code review ${REVIEW_ID} has been BLOCKED by the security reviewer.
Your workspace is: ${WS} at ${WS_PATH}

1. READ FEEDBACK:
   - bus inbox --agent ${ALPHA_DEV} --channels alpha --mark-read
   - crit review ${REVIEW_ID} — read the threads and comments

2. FIX THE ISSUE:
   - Address the security reviewer's feedback in your workspace
   - The issue is likely about the /debug endpoint — remove it or strip sensitive data
   - Edit ${WS_PATH}/src/main.rs to fix the issue
   - Verify it compiles: cd ${WS_PATH} && cargo check

3. REPLY ON CRIT:
   - Reply to the thread explaining your fix:
     crit reply <thread-id> \"<explanation of what you fixed and why>\"
   - If the thread ID from the review is available, use it. Otherwise, read the review
     to find the thread ID: crit review ${REVIEW_ID}

4. UPDATE AND RE-REQUEST:
   - Update the commit message:
     maw ws jj ${WS} describe -m \"feat: add POST /users registration with email validation

Removed /debug endpoint (security: exposed api_secret)\"
   - Re-request review:
     crit reviews request ${REVIEW_ID} --reviewers ${ALPHA_SECURITY} --agent ${ALPHA_DEV}
   - Announce:
     bus send --agent ${ALPHA_DEV} alpha \"Fixed review feedback, re-requesting review @${ALPHA_SECURITY}\" -L review-request

5. STOP HERE. Wait for re-review.

Key rules:
- All file operations use the absolute workspace path
- Run br commands from project root (${ALPHA_DIR})
- Use jj via maw ws jj, not git"

echo "$PROMPT" > "$ARTIFACTS/$PHASE.prompt.md"

botbox run-agent claude -p "$PROMPT" -m opus -t 900 \
  > "$ARTIFACTS/$PHASE.stdout.log" 2> "$ARTIFACTS/$PHASE.stderr.log" \
  || echo "PHASE $PHASE exited with code $?"

echo ""
echo "=== Phase 6 Complete ==="
