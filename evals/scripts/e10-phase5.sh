#!/usr/bin/env bash
set -euo pipefail

# E10 Phase 5: Security Review (alpha-security, Opus)
# Alpha-security reviews the code, finds the /debug vulnerability,
# leaves a CRITICAL crit comment, and blocks the review.

source "${1:?Usage: e10-phase5.sh <path-to-.eval-env>}"

PHASE="phase5"
ARTIFACTS="$EVAL_DIR/artifacts"
mkdir -p "$ARTIFACTS"

cd "$ALPHA_DIR"

# Re-discover review ID and workspace path if not in env
if [[ -z "${REVIEW_ID:-}" ]]; then
  REVIEW_ID=$(crit reviews list --all-workspaces --path "$ALPHA_DIR" --format json 2>/dev/null | jq -r '.[-1].review_id // empty' || true)
fi
if [[ -z "${REVIEW_ID:-}" ]]; then
  REVIEW_ID=$(grep -oP 'cr-[a-z0-9]+' "$ARTIFACTS/phase4.stdout.log" 2>/dev/null | head -1 || true)
  if [[ -n "$REVIEW_ID" ]]; then
    echo "FALLBACK: REVIEW_ID=$REVIEW_ID recovered from phase4 log (crit reviews list --all-workspaces failed)"
  fi
fi
if [[ -z "${WS_PATH:-}" ]]; then
  WS=$(maw ws list --format json 2>/dev/null | jq -r '[.[] | select(.is_default == false)] | .[0].name // empty')
  if [[ -z "$WS" ]]; then WS="default"; fi
  if [[ "$WS" == "default" ]]; then
    WS_PATH="$ALPHA_DIR"
  else
    WS_PATH="$ALPHA_DIR/.workspaces/$WS"
  fi
fi

echo "=== E10 Phase 5: Security Review ==="
echo "ALPHA_SECURITY=$ALPHA_SECURITY"
echo "ALPHA_DIR=$ALPHA_DIR"
echo "REVIEW_ID=$REVIEW_ID"
echo "WS_PATH=$WS_PATH"

PROMPT="You are security reviewer agent \"${ALPHA_SECURITY}\" for project \"alpha\".
Your project directory is: ${ALPHA_DIR}
Use --agent ${ALPHA_SECURITY} on ALL crit and bus commands.
Set BOTBUS_DATA_DIR=${BOTBUS_DATA_DIR} in your environment for all bus commands.

You have a pending code review to perform.

1. DISCOVER REVIEW:
   - crit inbox --agent ${ALPHA_SECURITY} --all-workspaces
   - The review ID is: ${REVIEW_ID}

2. READ THE REVIEW:
   - crit review ${REVIEW_ID}
   - This shows the diff of changes made in the workspace

3. REVIEW THE FULL CODEBASE:
   IMPORTANT: Do not limit your review to just the diff. Review ALL source files
   accessible at the workspace path. Pre-existing security issues are just as important
   as newly introduced ones.
   - Read the full source code from the workspace: ${WS_PATH}/src/main.rs
   - Look for: input validation issues, data exposure, access control problems,
     secret management, authentication/authorization gaps

4. COMMENT ON ISSUES:
   For each issue found, add a crit comment with severity:
   - CRITICAL: Security vulnerabilities, secret exposure, data leaks
   - HIGH: Correctness bugs, missing auth checks
   - MEDIUM: Error handling gaps, missing validation
   - LOW: Code quality, naming
   - INFO: Suggestions

   Use: crit comment --file <path> --line <line-number> ${REVIEW_ID} \"SEVERITY: description\"

5. VOTE:
   - If any CRITICAL or HIGH issues: crit block ${REVIEW_ID} --reason \"<reason>\"
   - Otherwise: crit lgtm ${REVIEW_ID}

6. ANNOUNCE:
   - bus send --agent ${ALPHA_SECURITY} alpha \"Review ${REVIEW_ID}: <BLOCKED|LGTM> — <summary>. @${ALPHA_DEV}\" -L review-done

Focus areas for this codebase:
- Does any endpoint expose sensitive data (secrets, internal state)?
- Is user input properly validated?
- Are error responses safe (no internal details leaked)?
- Is there any debug or development functionality that shouldn't be in production?"

echo "$PROMPT" > "$ARTIFACTS/$PHASE.prompt.md"

botbox run-agent claude -p "$PROMPT" -m opus -t 900 \
  > "$ARTIFACTS/$PHASE.stdout.log" 2> "$ARTIFACTS/$PHASE.stderr.log" \
  || echo "PHASE $PHASE exited with code $?"

# --- Discover thread ID for Phase 6 ---
THREAD_ID=$(crit review "$REVIEW_ID" --path "$WS_PATH" --format json 2>/dev/null | jq -r '.threads[0].thread_id // empty' || true)
if [[ -z "$THREAD_ID" ]]; then
  THREAD_ID=$(grep -oP 'th-[a-z0-9]+' "$ARTIFACTS/$PHASE.stdout.log" 2>/dev/null | head -1 || true)
  if [[ -n "$THREAD_ID" ]]; then
    echo "FALLBACK: THREAD_ID=$THREAD_ID recovered from stdout log (crit review --path failed)"
  fi
fi

if [[ -n "$THREAD_ID" ]]; then
  echo "export THREAD_ID=\"$THREAD_ID\"" >> "$EVAL_DIR/.eval-env"
  echo "Thread: $THREAD_ID"
else
  echo "WARNING: No thread ID found after Phase 5"
fi

echo ""
echo "=== Phase 5 Complete ==="
