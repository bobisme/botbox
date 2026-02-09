#!/usr/bin/env bash
set -euo pipefail

# E10 Phase 3: Beta Fixes + Releases (beta-dev, Sonnet)
# Beta-dev creates a workspace, fixes validate_email to allow +,
# adds tests, merges, closes bead, announces fix to alpha.

source "${1:?Usage: e10-phase3.sh <path-to-.eval-env>}"

PHASE="phase3"
ARTIFACTS="$EVAL_DIR/artifacts"
mkdir -p "$ARTIFACTS"

cd "$BETA_DIR"

# Re-discover bug bead if not in env
if [[ -z "${BUG_BEAD:-}" ]]; then
  BUG_BEAD=$(maw exec default -- br ready 2>&1 | grep -i 'validate\|email\|plus' | grep -oP 'bd-\w+' | head -1)
  if [[ -z "$BUG_BEAD" ]]; then
    BUG_BEAD=$(maw exec default -- br ready 2>&1 | grep -oP 'bd-\w+' | tail -1)
  fi
fi

echo "=== E10 Phase 3: Beta Fixes + Releases ==="
echo "BETA_DEV=$BETA_DEV"
echo "BETA_DIR=$BETA_DIR"
echo "BUG_BEAD=$BUG_BEAD"

PROMPT="You are dev agent \"${BETA_DEV}\" for the \"beta\" validation library.
Your project directory is: ${BETA_DIR}
This project uses maw v2 (bare repo layout). Source files are in ws/default/.
Use --agent ${BETA_DEV} on ALL bus mutation commands.
Use --actor ${BETA_DEV} on br mutations and --author ${BETA_DEV} on br comments.
Set BOTBUS_DATA_DIR=${BOTBUS_DATA_DIR} in your environment for all bus commands.

You have a bug bead ${BUG_BEAD} to fix validate_email to allow + in the local part.

1. START:
   - maw exec default -- br update --actor ${BETA_DEV} ${BUG_BEAD} --status=in_progress
   - maw ws create --random — note workspace name (\$WS)
     Your workspace files will be at: ${BETA_DIR}/ws/\$WS/
   - All file operations MUST use the absolute workspace path.

2. FIX:
   - In the workspace, modify ${BETA_DIR}/ws/\$WS/src/lib.rs to add '+' to the allowed characters in validate_email
   - Add a test: validate_email(\"user+tag@example.com\") should return Ok
   - Run: maw exec \$WS -- cargo test — all tests must pass
   - Describe: maw exec \$WS -- jj describe -m \"fix: allow + in email local part\"

3. FINISH:
   - Merge workspace: maw ws merge \$WS --destroy
   - Close bead: maw exec default -- br close --actor ${BETA_DEV} ${BUG_BEAD}
   - Announce fix to alpha: bus send --agent ${BETA_DEV} alpha \"@alpha-dev Fixed: validate_email now allows + in the local part. Should unblock your registration endpoint.\" -L task-done
   - Announce on beta channel: bus send --agent ${BETA_DEV} beta \"Closed ${BUG_BEAD}: validate_email + support\" -L task-done

Key rules:
- All file operations use the absolute workspace path: ${BETA_DIR}/ws/\$WS/
- Run br/bv commands via: maw exec default -- br ...
- Run jj/cargo via: maw exec \$WS -- <command>
- Use jj (not git) via maw exec"

echo "$PROMPT" > "$ARTIFACTS/$PHASE.prompt.md"

botbox run-agent claude -p "$PROMPT" -m sonnet -t 600 \
  > "$ARTIFACTS/$PHASE.stdout.log" 2> "$ARTIFACTS/$PHASE.stderr.log" \
  || echo "PHASE $PHASE exited with code $?"

echo ""
echo "=== Phase 3 Complete ==="
