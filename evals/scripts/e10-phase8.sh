#!/usr/bin/env bash
set -euo pipefail

# E10 Phase 8: Merge + Finish + Release (alpha-dev, Opus)
# Alpha-dev completes the full finish protocol: merge workspace,
# mark review merged (from default, after merge), close bead,
# release claims, sync, version bump, announce.

source "${1:?Usage: e10-phase8.sh <path-to-.eval-env>}"

PHASE="phase8"
ARTIFACTS="$EVAL_DIR/artifacts"
mkdir -p "$ARTIFACTS"

cd "$ALPHA_DIR"

# Re-discover state if not in env
if [[ -z "${WS:-}" ]]; then
  WS=$(maw ws list --format json 2>/dev/null | jq -r '[.workspaces[] | select(.is_default == false)] | .[0].name // empty')
  if [[ -z "$WS" ]]; then WS="default"; fi
fi
if [[ -z "${REVIEW_ID:-}" ]]; then
  REVIEW_ID=$(maw exec "$WS" -- crit reviews list --format json 2>/dev/null | jq -r '.[-1].review_id // empty' || true)
fi
if [[ -z "${REVIEW_ID:-}" ]]; then
  REVIEW_ID=$(grep -oP 'cr-[a-z0-9]+' "$ARTIFACTS/phase4.stdout.log" 2>/dev/null | head -1 || true)
  if [[ -n "$REVIEW_ID" ]]; then
    echo "FALLBACK: REVIEW_ID=$REVIEW_ID recovered from phase4 log (crit reviews list failed)"
  fi
fi

echo "=== E10 Phase 8: Merge + Finish + Release ==="
echo "ALPHA_DEV=$ALPHA_DEV"
echo "REVIEW_ID=$REVIEW_ID"
echo "WS=$WS"
echo "BEAD=$BEAD"

PROMPT="You are dev agent \"${ALPHA_DEV}\" for project \"alpha\".
Your project directory is: ${ALPHA_DIR}
This project uses maw v2 (bare repo layout). Source files are in ws/default/.
Use --agent ${ALPHA_DEV} on ALL bus, crit, and br mutation commands.
Use --actor ${ALPHA_DEV} on br mutations.
Set BOTBUS_DATA_DIR=${BOTBUS_DATA_DIR} in your environment for all bus commands.

Your code review ${REVIEW_ID} has been approved (LGTM). Complete the full finish protocol.

1. VERIFY APPROVAL:
   - bus inbox --agent ${ALPHA_DEV} --channels alpha --mark-read
   - maw exec ${WS} -- crit review ${REVIEW_ID} — confirm LGTM, no blocks

2. FINISH PROTOCOL:
   Follow these steps in order — this is the mandatory teardown:

   a. Merge workspace FIRST: maw ws merge ${WS} --destroy
      - The --destroy flag is required — it cleans up after merging
      - If merge fails due to conflicts, try: maw exec ${WS} -- jj restore --from main .beads/
        then retry maw ws merge ${WS} --destroy
   b. Mark review merged (from default workspace, AFTER merge):
      maw exec default -- crit reviews mark-merged ${REVIEW_ID}
   c. Close bead: maw exec default -- br close --actor ${ALPHA_DEV} ${BEAD}
   d. Release all claims: bus claims release --agent ${ALPHA_DEV} --all
   e. Sync beads: maw exec default -- br sync --flush-only

3. RELEASE:
   - This was a feat: commit, so bump the minor version
   - Edit the Cargo.toml in ws/default/: change version from \"0.1.0\" to \"0.2.0\"
   - maw exec default -- jj describe -m \"feat: add POST /users registration with email validation\"
   - maw exec default -- jj new
   - maw exec default -- jj tag set v0.2.0 -r @-

4. ANNOUNCE:
   - bus send --agent ${ALPHA_DEV} alpha \"Closed ${BEAD}: user registration endpoint. Released v0.2.0.\" -L task-done

Key rules:
- After workspace merge, all commands run from default workspace: maw exec default -- ...
- IMPORTANT: Merge workspace BEFORE mark-merged (otherwise the event is lost with the workspace)
- Use jj (not git) via maw exec
- The finish protocol steps must all complete — they prevent workspace leaks and keep the bead ledger synchronized"

echo "$PROMPT" > "$ARTIFACTS/$PHASE.prompt.md"

botbox run-agent claude -p "$PROMPT" -m opus -t 900 \
  > "$ARTIFACTS/$PHASE.stdout.log" 2> "$ARTIFACTS/$PHASE.stderr.log" \
  || echo "PHASE $PHASE exited with code $?"

echo ""
echo "=== Phase 8 Complete ==="
