#!/usr/bin/env bash
set -euo pipefail

# R8 Adversarial Review Eval — Reviewer Run
# Uses the proven R1 v2 prompt (clippy, web search, severity levels, evidence-grounding).
# Same shape as R1: single reviewer, score against 65-point rubric.

cd "${EVAL_DIR:?Set EVAL_DIR first (source .eval-env)}"
source .eval-env

echo "=== R8: Adversarial Review ==="
echo "REVIEWER=$REVIEWER"
echo "EVAL_DIR=$EVAL_DIR"
echo "REVIEW_ID=$REVIEW_ID"

PROMPT="You are security reviewer agent \"${REVIEWER}\" for project \"r8-eval\".
Use --agent ${REVIEWER} on ALL crit and botbus commands.

Review workflow:
1. Check botbus inbox: botbus inbox --agent ${REVIEWER} --channels r8-eval --mark-read
2. Check crit inbox: crit inbox --agent ${REVIEWER}
3. For each pending review:
   a. Read the review and diff: crit review <id>, crit diff <id>
   b. Read the full source files changed in the diff
   c. Read Cargo.toml for edition and dependency versions
   d. Run static analysis: cargo clippy 2>&1 — cite any warnings in your comments
   e. If unsure about framework or library behavior, use web search to verify before commenting
4. For each issue found, comment with a severity level:
   - CRITICAL: Security vulnerabilities, data loss, crashes in production
   - HIGH: Correctness bugs, race conditions, resource leaks
   - MEDIUM: Error handling gaps, missing validation at boundaries
   - LOW: Code quality, naming, structure
   - INFO: Suggestions, style preferences, minor improvements
   Use: crit comment <id> \"SEVERITY: <feedback>\" --file <path> --line <line-or-range>
5. Vote:
   - crit block <id> --reason \"<reason>\" if any CRITICAL or HIGH issues exist
   - crit lgtm <id> if no CRITICAL or HIGH issues
6. Announce: botbus send --agent ${REVIEWER} r8-eval \"Review complete: <id>\" -L mesh -L review-done

Focus on security and correctness. Ground your findings in evidence — compiler
output, documentation, or source code — not assumptions about API behavior."

claude ${CLAUDE_MODEL:+--model "$CLAUDE_MODEL"} \
  --dangerously-skip-permissions --allow-dangerously-skip-permissions \
  -p "$PROMPT"

echo ""
echo "=== R8 Run Complete ==="
echo "Verify:"
echo "  crit review $REVIEW_ID"
echo "  crit threads list $REVIEW_ID"
echo "  botbus history r8-eval --limit 10"
echo ""
echo "Score against rubric (65 points):"
echo "  Bug 1 (race condition): found + fix + severity = 12"
echo "  Bug 2 (TOCTOU delete): found + fix + severity = 12"
echo "  Bug 3 (pagination underflow): found + fix = 6"
echo "  Blocking decision: 5"
echo "  Quality feedback (2 issues): 10"
echo "  FP resistance (2 traps): 10"
echo "  Protocol (crit + botbus): 10"
echo "  Total: 65"
