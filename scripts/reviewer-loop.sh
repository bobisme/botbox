#!/usr/bin/env bash
set -euo pipefail

# --- Configuration ---
MAX_LOOPS=${MAX_LOOPS:-20}
LOOP_PAUSE=${LOOP_PAUSE:-10}

# --- Arguments ---
PROJECT="${1:?Usage: reviewer-loop.sh <project> [agent-name]}"
AGENT="${2:-$(bus generate-name)}"

echo "Reviewer:  $AGENT"
echo "Project:   $PROJECT"
echo "Max loops: $MAX_LOOPS"

# --- Confirm identity ---
bus whoami --agent "$AGENT"

# --- Claim the agent lease ---
if ! bus claim --agent "$AGENT" "agent://$AGENT" -m "reviewer-loop for $PROJECT"; then
	echo "Claim denied. Reviewer $AGENT is already running."
	exit 0
fi

# --- Cleanup on exit ---
cleanup() {
	bus release --agent "$AGENT" "agent://$AGENT" >/dev/null 2>&1 || true
	echo "Cleanup complete for $AGENT."
}

trap cleanup EXIT

# --- Announce ---
bus send --agent "$AGENT" "$PROJECT" "Reviewer $AGENT online, starting review loop" \
	-L mesh -L spawn-ack

# --- Python check ---
PYTHON_BIN=${PYTHON_BIN:-python3}
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
	PYTHON_BIN=python
fi
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
	echo "python is required for parsing JSON output."
	exit 1
fi

# --- Helper: check if there are reviews to process ---
has_work() {
	local inbox_count

	# Check bus inbox for review-request or re-review messages
	inbox_count=$(bus inbox --agent "$AGENT" --channels "$PROJECT" --count-only --format json 2>/dev/null \
		| "$PYTHON_BIN" -c \
			'import json,sys; d=json.load(sys.stdin); print(d.get("total_unread",0) if isinstance(d,dict) else d)' \
		2>/dev/null || echo "0")

	if [[ "$inbox_count" -gt 0 ]]; then
		return 0
	fi
	return 1
}

# --- Main loop ---
for ((i = 1; i <= MAX_LOOPS; i++)); do
	echo "--- Review loop $i/$MAX_LOOPS ---"

	if ! has_work; then
		echo "No reviews pending. Exiting cleanly."
		bus send --agent "$AGENT" "$PROJECT" \
			"No reviews pending. Reviewer $AGENT signing off." \
			-L mesh -L agent-idle
		break
	fi

	claude ${CLAUDE_MODEL:+--model "$CLAUDE_MODEL"} --dangerously-skip-permissions --allow-dangerously-skip-permissions -p "$(
		cat <<EOF
You are reviewer agent "$AGENT" for project "$PROJECT".

IMPORTANT: Use --agent $AGENT on ALL bus and crit commands. Set BOTBOX_PROJECT=$PROJECT.

Execute exactly ONE review cycle, then STOP. Do not process multiple reviews.

1. INBOX:
   Run: bus inbox --agent $AGENT --channels $PROJECT --mark-read
   Note any review-request or review-response messages. Ignore task-claim, task-done, spawn-ack, etc.

2. FIND REVIEWS:
   Run: crit inbox --agent $AGENT
   Pick one review to process. If no reviews need attention, say "NO_REVIEWS_PENDING" and stop.

3. REVIEW (follow .agents/botbox/review-loop.md):
   a. Read the review and diff: crit review <id> and crit diff <id>
   b. Read the full source files changed in the diff — use absolute paths
   c. Check project config (e.g., Cargo.toml, package.json) for dependencies and settings
   d. Run static analysis if applicable (e.g., cargo clippy, oxlint) — cite warnings in comments
   e. Cross-file consistency: compare similar functions across files for uniform security/validation.
      If one function does it right and another doesn't, that's a bug.
   f. Boundary checks: trace user-supplied values through to where they're used.
      Check arithmetic for edge cases: 0, 1, MAX, negative, empty.
   g. For each issue found, comment with severity:
      - CRITICAL: Security vulnerabilities, data loss, crashes in production
      - HIGH: Correctness bugs, race conditions, resource leaks
      - MEDIUM: Error handling gaps, missing validation at boundaries
      - LOW: Code quality, naming, structure
      - INFO: Suggestions, style preferences, minor improvements
      Use: crit comment <id> "SEVERITY: <feedback>" --file <path> --line <line-or-range>
   h. Vote:
      - crit block <id> --reason "..." if any CRITICAL or HIGH issues exist
      - crit lgtm <id> if no CRITICAL or HIGH issues

4. ANNOUNCE:
   bus send --agent $AGENT $PROJECT "Review complete: <review-id> — <LGTM|BLOCKED>" -L mesh -L review-done

5. RE-REVIEW (if a review-response message indicates the author addressed feedback):
   The author's fixes are in their workspace, not the main branch.
   Check the review-response bus message for the workspace path.
   Read files from the workspace path (e.g., .workspaces/\$WS/src/...).
   Verify fixes against original issues — read actual code, don't just trust replies.
   Run static analysis in the workspace: cd <workspace-path> && <analysis-command>
   If all resolved: crit lgtm <id>. If not: reply on threads explaining what's still wrong.

Key rules:
- Process exactly one review per cycle, then STOP.
- Focus on security and correctness. Ground findings in evidence — compiler output,
  documentation, or source code — not assumptions about API behavior.
- All bus and crit commands use --agent $AGENT.
- STOP after completing one review. Do not loop.
EOF
	)"

	sleep "$LOOP_PAUSE"
done

# --- Shutdown ---
bus send --agent "$AGENT" "$PROJECT" \
	"Reviewer $AGENT shutting down after $((i - 1)) loops." \
	-L mesh -L agent-shutdown
echo "Reviewer $AGENT finished."
