#!/usr/bin/env bash
set -euo pipefail

# E10 Phase 8: Merge + Finish + Release (alpha-dev, Opus)
# Alpha-dev completes the full finish protocol: mark review merged,
# merge workspace, close bead, release claims, sync, version bump, announce.

source "${1:?Usage: e10-phase8.sh <path-to-.eval-env>}"

PHASE="phase8"
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

echo "=== E10 Phase 8: Merge + Finish + Release ==="
echo "ALPHA_DEV=$ALPHA_DEV"
echo "REVIEW_ID=$REVIEW_ID"
echo "WS=$WS"
echo "BEAD=$BEAD"

PROMPT="You are dev agent \"${ALPHA_DEV}\" for project \"alpha\".
Your project directory is: ${ALPHA_DIR}
Use --agent ${ALPHA_DEV} on ALL bus, crit, and br mutation commands.
Use --actor ${ALPHA_DEV} on br mutations.
Set BOTBUS_DATA_DIR=${BOTBUS_DATA_DIR} in your environment for all bus commands.

Your code review ${REVIEW_ID} has been approved (LGTM). Complete the full finish protocol.

1. VERIFY APPROVAL:
   - bus inbox --agent ${ALPHA_DEV} --channels alpha --mark-read
   - crit review ${REVIEW_ID} — confirm LGTM, no blocks

2. FINISH PROTOCOL:
   Follow these steps in order — this is the mandatory teardown:

   a. Mark review merged: crit reviews mark-merged ${REVIEW_ID}
   b. Merge workspace: maw ws merge ${WS} --destroy
      - The --destroy flag is required — it cleans up after merging
      - If merge fails due to conflicts, try: jj restore --from main .beads/ && jj squash
        then retry maw ws merge ${WS} --destroy
   c. Close bead: br close --actor ${ALPHA_DEV} ${BEAD}
   d. Release all claims: bus claims release --agent ${ALPHA_DEV} --all
   e. Sync beads: br sync --flush-only

3. RELEASE:
   - This was a feat: commit, so bump the minor version
   - Edit Cargo.toml: change version from \"0.1.0\" to \"0.2.0\"
   - jj describe -m \"feat: add POST /users registration with email validation\"
   - jj new
   - jj tag set v0.2.0 -r @-

4. ANNOUNCE:
   - bus send --agent ${ALPHA_DEV} alpha \"Closed ${BEAD}: user registration endpoint. Released v0.2.0.\" -L task-done

Key rules:
- Run all commands from project root (${ALPHA_DIR})
- Use jj, not git
- The finish protocol steps must all complete — they prevent workspace leaks and keep the bead ledger synchronized"

echo "$PROMPT" > "$ARTIFACTS/$PHASE.prompt.md"

botbox run-agent claude -p "$PROMPT" -m opus -t 900 \
  > "$ARTIFACTS/$PHASE.stdout.log" 2> "$ARTIFACTS/$PHASE.stderr.log" \
  || echo "PHASE $PHASE exited with code $?"

echo ""
echo "=== Phase 8 Complete ==="
