#!/usr/bin/env bash
set -euo pipefail

# E11-L4 Mission Eval — Orchestrator
# Sends !mission message to futil channel, polls mission lifecycle
# (decomposition → worker dispatch → checkpoint → synthesis), captures artifacts.
#
# Expected flow:
# 1. Router hook fires → respond.mjs → routes !mission
# 2. respond.mjs creates mission bead → execs into dev-loop with BOTBOX_MISSION
# 3. Dev-loop decomposes mission into child beads
# 4. Dev-loop dispatches workers (futil-dev/<random>) for independent children
# 5. Workers implement subcommands in parallel
# 6. Dev-loop monitors via checkpoints
# 7. Dev-loop synthesizes and closes mission

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OVERALL_TIMEOUT=${E11_TIMEOUT:-1800}  # 30 minutes default
POLL_INTERVAL=30                       # seconds between status checks
STUCK_THRESHOLD=300                    # 5 minutes without progress = stuck

echo "=== E11-L4 Mission Eval ==="
echo "Starting at $(date)"
echo "Overall timeout: ${OVERALL_TIMEOUT}s"
echo ""

# --- Phase 0: Setup ---
echo "--- Running setup ---"
SETUP_OUTPUT=$("$SCRIPT_DIR/e11-l4-setup.sh" 2>&1) || {
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

FUTIL_ROUTER_OK=false
if echo "$HOOKS" | grep -qi "futil.*claim\|claim.*futil"; then
  FUTIL_ROUTER_OK=true
  echo "  Futil router hook: OK"
fi

if ! $FUTIL_ROUTER_OK; then echo "WARNING: No futil router hook found"; fi
echo "--- hooks: OK ---"
echo ""

# --- Build mission spec ---
MISSION_SPEC='!mission Implement all three futil subcommands
Outcome: A working futil CLI where all three subcommands (stats, search, convert) produce correct output.

## Subcommand specs

### futil stats <path>
Read the file and print line count, word count, and byte count.
Output format: "lines: N  words: N  bytes: N"
Must handle missing files with a clear error message.

### futil search <pattern> <path>
Search for regex matches in the file, printing matching lines with line numbers.
Output format: "N: <matching line>" for each match.
Must handle invalid regex with a clear error message.
Must handle missing files with a clear error message.

### futil convert <input> --format json|csv
Read input file and convert to the target format.
- JSON to CSV: read JSON array of objects, write CSV with headers from object keys.
- CSV to JSON: read CSV with headers, write JSON array of objects.
Must handle invalid input with a clear error message.
Sample data files exist in data/ directory for testing.

Success metric: cargo test passes with at least 3 tests, all subcommands produce correct output on sample data.
Constraints: Use existing dependencies (clap, regex, serde, serde_json, csv). No new dependencies.
Stop criteria: All three subcommands work correctly on sample data files in data/.'

# --- Send !mission message (triggers router hook → respond.mjs → dev-loop) ---
echo "--- Sending !mission to futil channel ($(date +%H:%M:%S)) ---"
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus send --agent setup futil \
  "$MISSION_SPEC" \
  -L task-request
echo "Mission spec sent. Router hook should fire shortly."
echo ""

# --- Poll loop ---
echo "--- Polling for completion (timeout: ${OVERALL_TIMEOUT}s) ---"
START_TIME=$(date +%s)
LAST_ACTIVITY_TIME=$START_TIME
LAST_MSG_COUNT=0

FINAL_STATUS_DEV="unknown"

# Mission tracking
MISSION_BEAD=""
CHILD_COUNT=0
CHILDREN_CLOSED=0

# Worker tracking
declare -A KNOWN_WORKERS
declare -A WORKER_LOG_CAPTURED

# Phase timing
DEV_SPAWN_TIME=""
MISSION_FOUND_TIME=""
FIRST_CHILD_TIME=""
FIRST_WORKER_TIME=""
MISSION_CLOSED_TIME=""
PHASE_TIMES=""

# Previous state for incremental capture
PREV_DEV_RUNNING=""

while true; do
  ELAPSED=$(( $(date +%s) - START_TIME ))

  if [[ $ELAPSED -ge $OVERALL_TIMEOUT ]]; then
    echo "TIMEOUT: Overall timeout reached (${OVERALL_TIMEOUT}s)"
    FINAL_STATUS_DEV="timeout"
    break
  fi

  sleep "$POLL_INTERVAL"
  ELAPSED=$(( $(date +%s) - START_TIME ))
  echo ""
  echo "--- Poll (${ELAPSED}s / ${OVERALL_TIMEOUT}s) ---"

  # Check botty — which agents are running?
  BOTTY_JSON=$(botty list --format json 2>/dev/null || echo '{"agents":[]}')

  DEV_RUNNING=$(echo "$BOTTY_JSON" | jq -r ".agents[] | select(.id == \"$FUTIL_DEV\") | .id" 2>/dev/null || echo "")
  RESPOND_RUNNING=$(echo "$BOTTY_JSON" | jq -r '.agents[] | select(.id | test("respond")) | .id' 2>/dev/null || echo "")

  if [[ -n "$DEV_RUNNING" ]]; then
    echo "  futil-dev: RUNNING"
    if [[ -z "$DEV_SPAWN_TIME" ]]; then
      DEV_SPAWN_TIME=$ELAPSED
      PHASE_TIMES+="dev_spawn=${DEV_SPAWN_TIME}s\n"
    fi
  else
    echo "  futil-dev: not running"
  fi

  if [[ -n "$RESPOND_RUNNING" ]]; then
    echo "  respond: RUNNING ($RESPOND_RUNNING)"
  fi

  # Discover workers (hierarchical names: futil-dev/<random>)
  WORKER_LIST=$(echo "$BOTTY_JSON" | jq -r '.agents[] | select(.id | test("/")) | .id' 2>/dev/null || echo "")
  if [[ -n "$WORKER_LIST" ]]; then
    while IFS= read -r worker_id; do
      [[ -z "$worker_id" ]] && continue
      if [[ -z "${KNOWN_WORKERS[$worker_id]+_}" ]]; then
        KNOWN_WORKERS["$worker_id"]=1
        WORKER_LOG_CAPTURED["$worker_id"]=0
        echo "  NEW WORKER: $worker_id"
        LAST_ACTIVITY_TIME=$(date +%s)
        if [[ -z "$FIRST_WORKER_TIME" ]]; then
          FIRST_WORKER_TIME=$ELAPSED
          PHASE_TIMES+="first_worker=${FIRST_WORKER_TIME}s\n"
        fi
      else
        echo "  worker: $worker_id (running)"
      fi
    done <<< "$WORKER_LIST"
  fi

  # Check for workers that disappeared — capture their logs
  for wid in "${!KNOWN_WORKERS[@]}"; do
    if ! echo "$WORKER_LIST" | grep -q "^${wid}$" 2>/dev/null; then
      if [[ "${WORKER_LOG_CAPTURED[$wid]}" -eq 0 ]]; then
        SAFE_NAME="${wid//\//_}"
        botty tail "$wid" -n 500 > "$ARTIFACTS/agent-${SAFE_NAME}.log" 2>/dev/null || true
        WORKER_LOG_CAPTURED["$wid"]=1
        echo "  worker EXITED: $wid (log captured)"
        LAST_ACTIVITY_TIME=$(date +%s)
      fi
    fi
  done

  # Discover mission bead
  cd "$PROJECT_DIR"
  if [[ -z "$MISSION_BEAD" ]]; then
    MISSION_BEADS=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br list -l mission --format json 2>/dev/null || echo '[]')
    MISSION_BEAD=$(echo "$MISSION_BEADS" | jq -r '.[0].id // empty' 2>/dev/null || echo "")
    if [[ -z "$MISSION_BEAD" ]]; then
      # Try alternative JSON shape
      MISSION_BEAD=$(echo "$MISSION_BEADS" | jq -r '.beads[0].id // empty' 2>/dev/null || echo "")
    fi
    if [[ -n "$MISSION_BEAD" ]]; then
      echo "  MISSION BEAD: $MISSION_BEAD"
      MISSION_FOUND_TIME=$ELAPSED
      PHASE_TIMES+="mission_found=${MISSION_FOUND_TIME}s\n"
      LAST_ACTIVITY_TIME=$(date +%s)
    fi
  fi

  # Track children if mission exists
  if [[ -n "$MISSION_BEAD" ]]; then
    CHILDREN_JSON=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br list -l "mission:$MISSION_BEAD" --format json 2>/dev/null || echo '[]')
    # Try both JSON shapes
    NEW_CHILD_COUNT=$(echo "$CHILDREN_JSON" | jq 'if type == "array" then length elif .beads then (.beads | length) else 0 end' 2>/dev/null || echo "0")
    NEW_CLOSED=$(echo "$CHILDREN_JSON" | jq '[if type == "array" then .[] elif .beads then .beads[] else empty end | select(.status == "closed")] | length' 2>/dev/null || echo "0")

    if [[ "$NEW_CHILD_COUNT" -gt "$CHILD_COUNT" ]]; then
      LAST_ACTIVITY_TIME=$(date +%s)
      if [[ "$CHILD_COUNT" -eq 0 && "$NEW_CHILD_COUNT" -gt 0 && -z "$FIRST_CHILD_TIME" ]]; then
        FIRST_CHILD_TIME=$ELAPSED
        PHASE_TIMES+="first_child=${FIRST_CHILD_TIME}s\n"
      fi
    fi
    CHILD_COUNT=$NEW_CHILD_COUNT

    if [[ "$NEW_CLOSED" -gt "$CHILDREN_CLOSED" ]]; then
      LAST_ACTIVITY_TIME=$(date +%s)
    fi
    CHILDREN_CLOSED=$NEW_CLOSED

    echo "  Children: $CHILDREN_CLOSED/$CHILD_COUNT closed"

    # Check mission bead status
    MISSION_STATUS=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br show "$MISSION_BEAD" --format json 2>/dev/null | jq -r '.[0].status // "unknown"' 2>/dev/null || echo "unknown")
    echo "  Mission $MISSION_BEAD: $MISSION_STATUS"

    if [[ "$MISSION_STATUS" == "closed" ]]; then
      echo "  Mission is CLOSED — workflow completed!"
      MISSION_CLOSED_TIME=$ELAPSED
      PHASE_TIMES+="mission_closed=${MISSION_CLOSED_TIME}s\n"
      FINAL_STATUS_DEV="completed-still-running"

      # Grace period for agents to exit
      for WAIT_I in 1 2 3 4; do
        sleep 15
        BOTTY_FINAL=$(botty list --format json 2>/dev/null || echo '{"agents":[]}')
        AD_RUNNING=$(echo "$BOTTY_FINAL" | jq -r ".agents[] | select(.id == \"$FUTIL_DEV\") | .id" 2>/dev/null || echo "")
        [[ -z "$AD_RUNNING" ]] && FINAL_STATUS_DEV="completed"
        REMAINING=$(echo "$BOTTY_FINAL" | jq '.agents | length' 2>/dev/null || echo "0")
        if [[ "$REMAINING" -eq 0 ]]; then
          FINAL_STATUS_DEV="completed"
          break
        fi
        echo "  Waiting for agents to exit... (${WAIT_I}/4)"
      done
      break
    fi
  fi

  # Check bus activity
  MSG_COUNT=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history futil -n 200 2>/dev/null | wc -l || echo "0")
  echo "  Channel messages: $MSG_COUNT"

  if [[ "$MSG_COUNT" -gt "$LAST_MSG_COUNT" ]]; then
    LAST_ACTIVITY_TIME=$(date +%s)
    LAST_MSG_COUNT=$MSG_COUNT
  fi

  # Stuck detection
  IDLE_TIME=$(( $(date +%s) - LAST_ACTIVITY_TIME ))
  if [[ $IDLE_TIME -ge $STUCK_THRESHOLD ]]; then
    echo "  WARNING: No activity for ${IDLE_TIME}s (threshold: ${STUCK_THRESHOLD}s)"
    # If ALL agents have exited without closing mission, it's a failure
    ALL_AGENTS=$(echo "$BOTTY_JSON" | jq '.agents | length' 2>/dev/null || echo "0")
    if [[ "$ALL_AGENTS" -eq 0 ]]; then
      echo "  All agents exited without closing mission — marking as agent-exited"
      FINAL_STATUS_DEV="agent-exited"
      break
    fi
  fi
done

echo ""
echo "--- Final status: futil-dev=$FINAL_STATUS_DEV ($(date +%H:%M:%S)) ---"
echo ""

# --- Capture artifacts ---
echo "--- Capturing artifacts ---"

# Dev agent log
botty tail "$FUTIL_DEV" -n 500 > "$ARTIFACTS/agent-${FUTIL_DEV}.log" 2>/dev/null || \
  echo "(agent already exited, no tail available)" > "$ARTIFACTS/agent-${FUTIL_DEV}.log"
echo "  log: $ARTIFACTS/agent-${FUTIL_DEV}.log"

# Respond agent logs
for RESP_NAME in $(botty list --format json 2>/dev/null | jq -r '.agents[]? | select(.id | test("respond")) | .id' 2>/dev/null || true); do
  botty tail "$RESP_NAME" -n 500 > "$ARTIFACTS/agent-${RESP_NAME}.log" 2>/dev/null || true
  echo "  respond log: $ARTIFACTS/agent-${RESP_NAME}.log"
done
# Try common respond names that may have exited
for RNAME in "futil-respond" "respond"; do
  if [[ ! -f "$ARTIFACTS/agent-${RNAME}.log" ]]; then
    botty tail "$RNAME" -n 500 > "$ARTIFACTS/agent-${RNAME}.log" 2>/dev/null || true
  fi
done

# Worker logs (capture any remaining)
for wid in "${!KNOWN_WORKERS[@]}"; do
  SAFE_NAME="${wid//\//_}"
  if [[ ! -f "$ARTIFACTS/agent-${SAFE_NAME}.log" ]] || [[ "${WORKER_LOG_CAPTURED[$wid]}" -eq 0 ]]; then
    botty tail "$wid" -n 500 > "$ARTIFACTS/agent-${SAFE_NAME}.log" 2>/dev/null || true
    echo "  worker log: $ARTIFACTS/agent-${SAFE_NAME}.log"
  fi
done

# Any other agents we missed
for AGENT_NAME in $(botty list --format json 2>/dev/null | jq -r '.agents[]?.id // empty' 2>/dev/null || true); do
  SAFE_NAME="${AGENT_NAME//\//_}"
  if [[ ! -f "$ARTIFACTS/agent-${SAFE_NAME}.log" ]]; then
    botty tail "$AGENT_NAME" -n 500 > "$ARTIFACTS/agent-${SAFE_NAME}.log" 2>/dev/null || true
    echo "  extra log: $ARTIFACTS/agent-${SAFE_NAME}.log"
  fi
done

# Channel history (text + JSON)
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history futil -n 200 > "$ARTIFACTS/channel-futil-history.log" 2>/dev/null || \
  echo "(no history)" > "$ARTIFACTS/channel-futil-history.log"
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history futil -n 200 --format json > "$ARTIFACTS/channel-futil-history.json" 2>/dev/null || \
  echo '{"messages":[]}' > "$ARTIFACTS/channel-futil-history.json"
echo "  channel: $ARTIFACTS/channel-futil-history.log"

# Mission bead state
cd "$PROJECT_DIR"
if [[ -n "$MISSION_BEAD" ]]; then
  BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br show "$MISSION_BEAD" --format json > "$ARTIFACTS/mission-bead-state.json" 2>/dev/null || \
    echo "[]" > "$ARTIFACTS/mission-bead-state.json"
  echo "  mission bead: $ARTIFACTS/mission-bead-state.json"
fi

# All beads state
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br list --format json > "$ARTIFACTS/all-beads-state.json" 2>/dev/null || \
  echo '[]' > "$ARTIFACTS/all-beads-state.json"
echo "  all beads: $ARTIFACTS/all-beads-state.json"

# Workspace state
maw ws list --format json > "$ARTIFACTS/workspace-state.json" 2>/dev/null || \
  echo "{}" > "$ARTIFACTS/workspace-state.json"

# Claims state
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus claims list > "$ARTIFACTS/claims-state.txt" 2>/dev/null || \
  echo "(no claims)" > "$ARTIFACTS/claims-state.txt"

# Final status file
WORKER_NAMES=$(printf '%s\n' "${!KNOWN_WORKERS[@]}" | sort)
cat > "$ARTIFACTS/final-status.txt" << EOF
FUTIL_DEV_STATUS=$FINAL_STATUS_DEV
MISSION_BEAD=${MISSION_BEAD:-none}
CHILD_COUNT=$CHILD_COUNT
CHILDREN_CLOSED=$CHILDREN_CLOSED
WORKER_NAMES=$WORKER_NAMES
EOF

echo -e "$PHASE_TIMES" > "$ARTIFACTS/phase-times.log" 2>/dev/null || true

echo ""

# --- Kill remaining agents ---
echo "--- Cleaning up agents ---"
botty kill "$FUTIL_DEV" 2>/dev/null || true
for AGENT_NAME in $(botty list --format json 2>/dev/null | jq -r '.agents[]?.id // empty' 2>/dev/null || true); do
  botty kill "$AGENT_NAME" 2>/dev/null || true
done
echo "  All agents stopped."
echo ""

# --- Verification ---
echo "--- Running verify ($(date +%H:%M:%S)) ---"
"$SCRIPT_DIR/e11-l4-verify.sh" "$EVAL_DIR/.eval-env" || true

# --- Summary ---
echo ""
echo "========================================="
echo "=== E11-L4 Complete ($(date +%H:%M:%S)) ==="
echo "========================================="
echo ""
echo "Final status:"
echo "  futil-dev: $FINAL_STATUS_DEV"
echo "  Mission bead: ${MISSION_BEAD:-none}"
echo "  Children: $CHILDREN_CLOSED/$CHILD_COUNT closed"
echo "  Workers discovered: ${#KNOWN_WORKERS[@]}"
echo "Elapsed: $(( $(date +%s) - START_TIME ))s"
echo ""
echo "Phase timing:"
[[ -n "$DEV_SPAWN_TIME" ]] && echo "  dev spawn: ${DEV_SPAWN_TIME}s"
[[ -n "$MISSION_FOUND_TIME" ]] && echo "  mission found: ${MISSION_FOUND_TIME}s"
[[ -n "$FIRST_CHILD_TIME" ]] && echo "  first child: ${FIRST_CHILD_TIME}s"
[[ -n "$FIRST_WORKER_TIME" ]] && echo "  first worker: ${FIRST_WORKER_TIME}s"
[[ -n "$MISSION_CLOSED_TIME" ]] && echo "  mission closed: ${MISSION_CLOSED_TIME}s"
echo ""
echo "Artifacts: $ARTIFACTS/"
echo "EVAL_DIR=$EVAL_DIR"
echo ""
echo "To inspect results:"
echo "  source $EVAL_DIR/.eval-env"
echo "  ls $ARTIFACTS/"
echo "  cat $ARTIFACTS/agent-${FUTIL_DEV}.log"
echo "  cat $ARTIFACTS/channel-futil-history.log"
echo ""
