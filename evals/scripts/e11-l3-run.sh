#!/usr/bin/env bash
set -euo pipefail

# E11-L3 Botty-Native Full Lifecycle Eval — Orchestrator
# Sends task-request to alpha channel, watches THREE agents (alpha-dev, alpha-security,
# beta-dev) coordinate across TWO projects via real hooks/botty/loop-scripts.
#
# Expected flow:
# 1. Router hook fires → respond.mjs → spawns alpha-dev via dev-loop
# 2. alpha-dev triages, claims bead, implements POST /users
# 3. alpha-dev discovers beta validate_email rejects +, posts to beta channel
# 4. beta-dev hook fires → beta-dev investigates, fixes, announces on alpha channel
# 5. alpha-dev resumes, creates crit review, @mentions alpha-security
# 6. alpha-security hook fires → reviews, finds /debug vulnerability, BLOCKs
# 7. alpha-dev fixes /debug, re-requests review
# 8. alpha-security re-reviews, LGTMs
# 9. alpha-dev merges, closes bead, releases claims

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OVERALL_TIMEOUT=${E11_TIMEOUT:-2700}  # 45 minutes default
POLL_INTERVAL=30                       # seconds between status checks
STUCK_THRESHOLD=300                    # 5 minutes without progress = stuck

echo "=== E11-L3 Botty-Native Full Lifecycle Eval ==="
echo "Starting at $(date)"
echo "Overall timeout: ${OVERALL_TIMEOUT}s"
echo ""

# --- Phase 0: Setup ---
echo "--- Running setup ---"
SETUP_OUTPUT=$("$SCRIPT_DIR/e11-l3-setup.sh" 2>&1) || {
  echo "$SETUP_OUTPUT"
  echo "FATAL: Setup failed"
  exit 1
}
echo "$SETUP_OUTPUT"

EVAL_DIR=$(echo "$SETUP_OUTPUT" | grep -oP 'EVAL_DIR=\K.*' | head -1)
if [[ -z "$EVAL_DIR" || ! -f "$EVAL_DIR/.eval-env" ]]; then
  echo "FATAL: Setup completed but could not find .eval-env"
  echo "Output was:"
  echo "$SETUP_OUTPUT"
  exit 1
fi

source "$EVAL_DIR/.eval-env"
ARTIFACTS="$EVAL_DIR/artifacts"
echo "--- setup: OK (EVAL_DIR=$EVAL_DIR) ---"
echo ""

# --- Verify hooks ---
echo "--- Verifying hooks ---"
HOOKS=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus hooks list 2>&1)
echo "$HOOKS"

ALPHA_ROUTER_OK=false
ALPHA_REVIEWER_OK=false
BETA_ROUTER_OK=false
if echo "$HOOKS" | grep -qi "alpha.*claim\|claim.*alpha"; then
  ALPHA_ROUTER_OK=true
  echo "  Alpha router hook: OK"
fi
if echo "$HOOKS" | grep -qi "mention.*security\|security.*mention"; then
  ALPHA_REVIEWER_OK=true
  echo "  Alpha reviewer hook: OK"
fi
if echo "$HOOKS" | grep -qi "beta.*claim\|claim.*beta"; then
  BETA_ROUTER_OK=true
  echo "  Beta router hook: OK"
fi

if ! $ALPHA_ROUTER_OK; then echo "WARNING: No alpha router hook found"; fi
if ! $ALPHA_REVIEWER_OK; then echo "WARNING: No alpha reviewer hook found"; fi
if ! $BETA_ROUTER_OK; then echo "WARNING: No beta router hook found"; fi
echo "--- hooks: OK ---"
echo ""

# --- Send task-request (triggers alpha router hook → dev-loop) ---
echo "--- Sending task-request to alpha channel ($(date +%H:%M:%S)) ---"
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus send --agent setup alpha \
  "New task: Add POST /users registration endpoint with email validation. Must support standard email formats including subaddressing (user+tag@example.com). Use beta's validate_email for validation. See bead $ALPHA_BEAD for full requirements." \
  -L task-request
echo "Task-request sent. Alpha router hook should fire shortly."
echo ""

# --- Poll loop ---
echo "--- Polling for completion (timeout: ${OVERALL_TIMEOUT}s) ---"
START_TIME=$(date +%s)
LAST_BEAD_STATUS=""
LAST_ACTIVITY_TIME=$START_TIME
LAST_ALPHA_MSG_COUNT=0
LAST_BETA_MSG_COUNT=0
LAST_REVIEW_COUNT=0

FINAL_STATUS_ALPHA_DEV="unknown"
FINAL_STATUS_ALPHA_SECURITY="unknown"
FINAL_STATUS_BETA_DEV="unknown"

# Phase timing
ALPHA_DEV_SPAWN_TIME=""
ALPHA_SECURITY_SPAWN_TIME=""
BETA_DEV_SPAWN_TIME=""
BEAD_CLOSED_TIME=""
PHASE_TIMES=""

while true; do
  ELAPSED=$(( $(date +%s) - START_TIME ))

  if [[ $ELAPSED -ge $OVERALL_TIMEOUT ]]; then
    echo "TIMEOUT: Overall timeout reached (${OVERALL_TIMEOUT}s)"
    FINAL_STATUS_ALPHA_DEV="timeout"
    FINAL_STATUS_ALPHA_SECURITY="timeout"
    FINAL_STATUS_BETA_DEV="timeout"
    break
  fi

  sleep "$POLL_INTERVAL"
  ELAPSED=$(( $(date +%s) - START_TIME ))
  echo ""
  echo "--- Poll (${ELAPSED}s / ${OVERALL_TIMEOUT}s) ---"

  # Check botty — which agents are running?
  BOTTY_JSON=$(botty list --format json 2>/dev/null || echo '{"agents":[]}')

  ALPHA_DEV_RUNNING=$(echo "$BOTTY_JSON" | jq -r ".agents[] | select(.id == \"$ALPHA_DEV\") | .id" 2>/dev/null || echo "")
  ALPHA_SEC_RUNNING=$(echo "$BOTTY_JSON" | jq -r ".agents[] | select(.id == \"$ALPHA_SECURITY\") | .id" 2>/dev/null || echo "")
  BETA_DEV_RUNNING=$(echo "$BOTTY_JSON" | jq -r ".agents[] | select(.id == \"$BETA_DEV\") | .id" 2>/dev/null || echo "")
  # Also check for respond agents
  RESPOND_RUNNING=$(echo "$BOTTY_JSON" | jq -r '.agents[] | select(.id | test("respond")) | .id' 2>/dev/null || echo "")

  if [[ -n "$ALPHA_DEV_RUNNING" ]]; then
    echo "  alpha-dev: RUNNING"
    if [[ -z "$ALPHA_DEV_SPAWN_TIME" ]]; then
      ALPHA_DEV_SPAWN_TIME=$ELAPSED
      PHASE_TIMES+="alpha_dev_spawn=${ALPHA_DEV_SPAWN_TIME}s\n"
    fi
  else
    echo "  alpha-dev: not running"
  fi

  if [[ -n "$ALPHA_SEC_RUNNING" ]]; then
    echo "  alpha-security: RUNNING"
    if [[ -z "$ALPHA_SECURITY_SPAWN_TIME" ]]; then
      ALPHA_SECURITY_SPAWN_TIME=$ELAPSED
      PHASE_TIMES+="alpha_security_spawn=${ALPHA_SECURITY_SPAWN_TIME}s\n"
    fi
  else
    echo "  alpha-security: not running"
  fi

  if [[ -n "$BETA_DEV_RUNNING" ]]; then
    echo "  beta-dev: RUNNING"
    if [[ -z "$BETA_DEV_SPAWN_TIME" ]]; then
      BETA_DEV_SPAWN_TIME=$ELAPSED
      PHASE_TIMES+="beta_dev_spawn=${BETA_DEV_SPAWN_TIME}s\n"
    fi
  else
    echo "  beta-dev: not running"
  fi

  if [[ -n "$RESPOND_RUNNING" ]]; then
    echo "  respond: RUNNING ($RESPOND_RUNNING)"
  fi

  # Check alpha bead status
  cd "$ALPHA_DIR"
  BEAD_JSON=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br show "$ALPHA_BEAD" --format json 2>/dev/null || echo "[]")
  BEAD_STATUS=$(echo "$BEAD_JSON" | jq -r '.[0].status // "unknown"' 2>/dev/null || echo "unknown")
  echo "  Alpha bead $ALPHA_BEAD: $BEAD_STATUS"

  if [[ "$BEAD_STATUS" != "$LAST_BEAD_STATUS" ]]; then
    LAST_BEAD_STATUS="$BEAD_STATUS"
    LAST_ACTIVITY_TIME=$(date +%s)
    if [[ "$BEAD_STATUS" == "closed" && -z "$BEAD_CLOSED_TIME" ]]; then
      BEAD_CLOSED_TIME=$ELAPSED
      PHASE_TIMES+="bead_closed=${BEAD_CLOSED_TIME}s\n"
    fi
  fi

  # Check bus activity on both channels
  ALPHA_MSG_COUNT=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history alpha -n 200 2>/dev/null | wc -l || echo "0")
  BETA_MSG_COUNT=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history beta -n 200 2>/dev/null | wc -l || echo "0")
  echo "  Alpha channel messages: $ALPHA_MSG_COUNT"
  echo "  Beta channel messages: $BETA_MSG_COUNT"

  if [[ "$ALPHA_MSG_COUNT" -gt "$LAST_ALPHA_MSG_COUNT" || "$BETA_MSG_COUNT" -gt "$LAST_BETA_MSG_COUNT" ]]; then
    LAST_ACTIVITY_TIME=$(date +%s)
    LAST_ALPHA_MSG_COUNT=$ALPHA_MSG_COUNT
    LAST_BETA_MSG_COUNT=$BETA_MSG_COUNT
  fi

  # Check review status on alpha
  REVIEW_JSON=$(cd "$ALPHA_DIR" && BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- crit reviews list --format json 2>/dev/null || echo '{"reviews":[]}')
  REVIEW_COUNT=$(echo "$REVIEW_JSON" | jq '.reviews | length' 2>/dev/null || echo "0")
  if [[ "$REVIEW_COUNT" -gt 0 ]]; then
    echo "  Alpha reviews: $REVIEW_COUNT"
    echo "$REVIEW_JSON" | jq -r '.reviews[] | "    \(.review_id): \(.state) (LGTM=\(.vote_summary.lgtm) BLOCK=\(.vote_summary.block))"' 2>/dev/null || true
  fi
  if [[ "$REVIEW_COUNT" -gt "$LAST_REVIEW_COUNT" ]]; then
    LAST_ACTIVITY_TIME=$(date +%s)
    LAST_REVIEW_COUNT=$REVIEW_COUNT
  fi

  # Check for beta beads (cross-project signal)
  cd "$BETA_DIR"
  BETA_BEAD_COUNT=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br ready 2>/dev/null | wc -l || echo "0")
  if [[ "$BETA_BEAD_COUNT" -gt 0 ]]; then
    echo "  Beta ready beads: $BETA_BEAD_COUNT"
  fi

  # Check for completion
  if [[ "$BEAD_STATUS" == "closed" ]]; then
    echo "  Alpha bead is CLOSED — workflow completed!"
    FINAL_STATUS_ALPHA_DEV="completed-still-running"
    FINAL_STATUS_ALPHA_SECURITY="completed"
    FINAL_STATUS_BETA_DEV="completed"
    # Grace period for agents to exit
    for WAIT_I in 1 2 3 4 5 6; do
      sleep 15
      BOTTY_FINAL=$(botty list --format json 2>/dev/null || echo '{"agents":[]}')
      AD_RUNNING=$(echo "$BOTTY_FINAL" | jq -r ".agents[] | select(.id == \"$ALPHA_DEV\") | .id" 2>/dev/null || echo "")
      AS_RUNNING=$(echo "$BOTTY_FINAL" | jq -r ".agents[] | select(.id == \"$ALPHA_SECURITY\") | .id" 2>/dev/null || echo "")
      BD_RUNNING=$(echo "$BOTTY_FINAL" | jq -r ".agents[] | select(.id == \"$BETA_DEV\") | .id" 2>/dev/null || echo "")
      [[ -z "$AD_RUNNING" ]] && FINAL_STATUS_ALPHA_DEV="completed"
      [[ -n "$AS_RUNNING" ]] && FINAL_STATUS_ALPHA_SECURITY="completed-still-running"
      [[ -n "$BD_RUNNING" ]] && FINAL_STATUS_BETA_DEV="completed-still-running"
      if [[ -z "$AD_RUNNING" && -z "$AS_RUNNING" && -z "$BD_RUNNING" ]]; then
        break
      fi
      echo "  Waiting for agents to exit... (${WAIT_I}/6)"
    done
    break
  fi

  # Stuck detection
  IDLE_TIME=$(( $(date +%s) - LAST_ACTIVITY_TIME ))
  if [[ $IDLE_TIME -ge $STUCK_THRESHOLD ]]; then
    echo "  WARNING: No activity for ${IDLE_TIME}s (threshold: ${STUCK_THRESHOLD}s)"
    # If ALL agents have exited without closing bead, it's a failure
    if [[ -z "$ALPHA_DEV_RUNNING" && -z "$ALPHA_SEC_RUNNING" && -z "$BETA_DEV_RUNNING" && -z "$RESPOND_RUNNING" ]]; then
      echo "  All agents exited without closing bead — marking as agent-exited"
      FINAL_STATUS_ALPHA_DEV="agent-exited"
      FINAL_STATUS_ALPHA_SECURITY="agent-exited"
      FINAL_STATUS_BETA_DEV="agent-exited"
      break
    fi
  fi
done

echo ""
echo "--- Final status: alpha-dev=$FINAL_STATUS_ALPHA_DEV, alpha-security=$FINAL_STATUS_ALPHA_SECURITY, beta-dev=$FINAL_STATUS_BETA_DEV ($(date +%H:%M:%S)) ---"
echo ""

# --- Capture artifacts ---
echo "--- Capturing artifacts ---"

# Agent logs
for AGENT_NAME in "$ALPHA_DEV" "$ALPHA_SECURITY" "$BETA_DEV"; do
  botty tail "$AGENT_NAME" -n 500 > "$ARTIFACTS/agent-${AGENT_NAME}.log" 2>/dev/null || \
    echo "(agent already exited, no tail available)" > "$ARTIFACTS/agent-${AGENT_NAME}.log"
  echo "  log: $ARTIFACTS/agent-${AGENT_NAME}.log"
done

# Respond agent logs (may be multiple — alpha-respond, beta-respond)
for RESP_NAME in $(botty list --format json 2>/dev/null | jq -r '.agents[]? | select(.id | test("respond")) | .id' 2>/dev/null || true); do
  botty tail "$RESP_NAME" -n 500 > "$ARTIFACTS/agent-${RESP_NAME}.log" 2>/dev/null || true
  echo "  respond log: $ARTIFACTS/agent-${RESP_NAME}.log"
done

# Also try respond names that may have already exited
for RNAME in "alpha-respond" "beta-respond" "respond"; do
  if [[ ! -f "$ARTIFACTS/agent-${RNAME}.log" ]]; then
    botty tail "$RNAME" -n 500 > "$ARTIFACTS/agent-${RNAME}.log" 2>/dev/null || true
  fi
done

# Any other worker agents
for AGENT_NAME in $(botty list --format json 2>/dev/null | jq -r '.agents[]?.id // empty' 2>/dev/null || true); do
  if [[ ! -f "$ARTIFACTS/agent-${AGENT_NAME}.log" ]]; then
    botty tail "$AGENT_NAME" -n 500 > "$ARTIFACTS/agent-${AGENT_NAME}.log" 2>/dev/null || true
    echo "  worker log: $ARTIFACTS/agent-${AGENT_NAME}.log"
  fi
done

# Channel history (both projects)
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history alpha -n 200 > "$ARTIFACTS/channel-alpha-history.log" 2>/dev/null || \
  echo "(no alpha history)" > "$ARTIFACTS/channel-alpha-history.log"
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history beta -n 200 > "$ARTIFACTS/channel-beta-history.log" 2>/dev/null || \
  echo "(no beta history)" > "$ARTIFACTS/channel-beta-history.log"
echo "  alpha channel: $ARTIFACTS/channel-alpha-history.log"
echo "  beta channel: $ARTIFACTS/channel-beta-history.log"

# Bead state (both projects)
cd "$ALPHA_DIR"
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br show "$ALPHA_BEAD" --format json > "$ARTIFACTS/alpha-bead-state.json" 2>/dev/null || \
  echo "[]" > "$ARTIFACTS/alpha-bead-state.json"

# Beta beads (may have been created by cross-project communication)
cd "$BETA_DIR"
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br ready > "$ARTIFACTS/beta-beads-ready.txt" 2>/dev/null || \
  echo "(no beta beads)" > "$ARTIFACTS/beta-beads-ready.txt"
# List all beads in beta for forensics
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br list --format json > "$ARTIFACTS/beta-beads-all.json" 2>/dev/null || \
  echo '{"beads":[]}' > "$ARTIFACTS/beta-beads-all.json"
echo "  beta beads: $ARTIFACTS/beta-beads-all.json"

# Workspace state (both projects)
cd "$ALPHA_DIR"
maw ws list --format json > "$ARTIFACTS/alpha-workspace-state.json" 2>/dev/null || \
  echo "{}" > "$ARTIFACTS/alpha-workspace-state.json"
cd "$BETA_DIR"
maw ws list --format json > "$ARTIFACTS/beta-workspace-state.json" 2>/dev/null || \
  echo "{}" > "$ARTIFACTS/beta-workspace-state.json"

# Claims state
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus claims list > "$ARTIFACTS/claims-state.txt" 2>/dev/null || \
  echo "(no claims)" > "$ARTIFACTS/claims-state.txt"

# Review state (alpha)
cd "$ALPHA_DIR"
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- crit reviews list --format json > "$ARTIFACTS/alpha-reviews-state.json" 2>/dev/null || \
  echo '{"reviews":[]}' > "$ARTIFACTS/alpha-reviews-state.json"

# Save final status
cat > "$ARTIFACTS/final-status.txt" << EOF
ALPHA_DEV_STATUS=$FINAL_STATUS_ALPHA_DEV
ALPHA_SECURITY_STATUS=$FINAL_STATUS_ALPHA_SECURITY
BETA_DEV_STATUS=$FINAL_STATUS_BETA_DEV
EOF

echo -e "$PHASE_TIMES" > "$ARTIFACTS/phase-times.log" 2>/dev/null || true

echo ""

# --- Kill remaining agents ---
echo "--- Cleaning up agents ---"
for AGENT_NAME in "$ALPHA_DEV" "$ALPHA_SECURITY" "$BETA_DEV"; do
  botty kill "$AGENT_NAME" 2>/dev/null || true
done
# Kill respond agents and any workers
for AGENT_NAME in $(botty list --format json 2>/dev/null | jq -r '.agents[]?.id // empty' 2>/dev/null || true); do
  botty kill "$AGENT_NAME" 2>/dev/null || true
done
echo "  All agents stopped."
echo ""

# --- Verification ---
echo "--- Running verify ($(date +%H:%M:%S)) ---"
"$SCRIPT_DIR/e11-l3-verify.sh" "$EVAL_DIR/.eval-env" || true

# --- Summary ---
echo ""
echo "========================================="
echo "=== E11-L3 Complete ($(date +%H:%M:%S)) ==="
echo "========================================="
echo ""
echo "Final status:"
echo "  alpha-dev: $FINAL_STATUS_ALPHA_DEV"
echo "  alpha-security: $FINAL_STATUS_ALPHA_SECURITY"
echo "  beta-dev: $FINAL_STATUS_BETA_DEV"
echo "Elapsed: $(( $(date +%s) - START_TIME ))s"
echo ""
echo "Phase timing:"
[[ -n "$ALPHA_DEV_SPAWN_TIME" ]] && echo "  alpha-dev spawn: ${ALPHA_DEV_SPAWN_TIME}s"
[[ -n "$BETA_DEV_SPAWN_TIME" ]] && echo "  beta-dev spawn: ${BETA_DEV_SPAWN_TIME}s"
[[ -n "$ALPHA_SECURITY_SPAWN_TIME" ]] && echo "  alpha-security spawn: ${ALPHA_SECURITY_SPAWN_TIME}s"
[[ -n "$BEAD_CLOSED_TIME" ]] && echo "  Alpha bead closed: ${BEAD_CLOSED_TIME}s"
echo ""
echo "Artifacts: $ARTIFACTS/"
echo "EVAL_DIR=$EVAL_DIR"
echo ""
echo "To inspect results:"
echo "  source $EVAL_DIR/.eval-env"
echo "  ls $ARTIFACTS/"
echo "  cat $ARTIFACTS/agent-${ALPHA_DEV}.log"
echo "  cat $ARTIFACTS/agent-${ALPHA_SECURITY}.log"
echo "  cat $ARTIFACTS/agent-${BETA_DEV}.log"
echo "  cat $ARTIFACTS/channel-alpha-history.log"
echo "  cat $ARTIFACTS/channel-beta-history.log"
