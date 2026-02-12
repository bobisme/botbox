#!/usr/bin/env bash
set -euo pipefail

# E11-L5 Coordination Eval — Orchestrator
# Sends !mission message to taskr channel, polls mission lifecycle
# (decomposition → worker dispatch → checkpoint → synthesis), captures artifacts.
# Additionally captures coordination-specific artifacts (coord:interface messages,
# bus history calls in worker logs).
#
# Key difference from L4: the mission spec explicitly mentions shared core module
# and coordination requirement. Workers MUST coordinate on shared types.
#
# Expected flow:
# 1. Router hook fires → respond.mjs → routes !mission
# 2. respond.mjs creates mission bead → execs into dev-loop with BOTBOX_MISSION
# 3. Dev-loop decomposes mission into child beads
# 4. Dev-loop dispatches workers (taskr-dev/<random>) for independent children
# 5. Workers implement subcommands, coordinating on shared core module
# 6. Dev-loop monitors via checkpoints
# 7. Dev-loop synthesizes and closes mission

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OVERALL_TIMEOUT=${E11_TIMEOUT:-1800}  # 30 minutes default
POLL_INTERVAL=30                       # seconds between status checks
STUCK_THRESHOLD=300                    # 5 minutes without progress = stuck

echo "=== E11-L5 Coordination Eval ==="
echo "Starting at $(date)"
echo "Overall timeout: ${OVERALL_TIMEOUT}s"
echo ""

# --- Phase 0: Setup ---
echo "--- Running setup ---"
SETUP_OUTPUT=$("$SCRIPT_DIR/e11-l5-setup.sh" 2>&1) || {
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

TASKR_ROUTER_OK=false
if echo "$HOOKS" | grep -qi "taskr.*claim\|claim.*taskr"; then
  TASKR_ROUTER_OK=true
  echo "  Taskr router hook: OK"
fi

if ! $TASKR_ROUTER_OK; then echo "WARNING: No taskr router hook found"; fi
echo "--- hooks: OK ---"
echo ""

# --- Build mission spec ---
# Key difference from L4: explicitly mentions shared core module and coordination requirement.
MISSION_SPEC='!mission Implement all taskr subcommands and shared core module
Outcome: A working taskr CLI where all three subcommands (run, list, validate) produce correct output with all flags working, the shared core module fully implemented, and tasks parseable from TOML files.

## Architecture — SHARED CORE MODULE (CRITICAL)

The project has a shared core module that ALL subcommands depend on:

- src/core/mod.rs — Task trait, TaskResult enum, ValidationIssue, Config struct, ShellTask, parse_task_file(), TaskrError (SHARED by ALL subcommands)
- src/core/config.rs — TOML config parser: load_config(), default_config() (SHARED by ALL subcommands)
- src/commands/run.rs — taskr run: parse tasks, toposort deps, execute, report
- src/commands/list.rs — taskr list: discover tasks, filter, format output
- src/commands/validate.rs — taskr validate: parse, check, report issues
- src/main.rs — clap dispatch (already wired, do NOT modify)

**COORDINATION REQUIREMENT**: All three subcommands import from core. If a worker changes the Task trait signature, adds fields to Config, or modifies TaskResult, the other workers MUST adapt. Workers MUST:
1. Post bus messages with -L coord:interface when they modify shared types in core/
2. Check bus history for sibling coord:interface messages BEFORE implementing against core types
3. Coordinate on the shared module to avoid compilation failures

## Component specs

### 1. src/core/mod.rs + src/core/config.rs — Shared types and config (implement FIRST)

The type skeletons exist but have todo!() stubs. Implement:
- Task trait (already declared, just needs ShellTask impl)
- ShellTask: implement Task trait — execute() runs shell commands via std::process::Command
- parse_task_file(path) → Result<Vec<ShellTask>, TaskrError>: read TOML, deserialize [[task]] array
- TaskrError enum with thiserror: FileNotFound, ParseError, ExecutionError, CycleDetected, TaskNotFound
- config.rs: load_config(path) and default_config() functions

The existing type declarations (Task trait, TaskResult, ValidationIssue, IssueSeverity, Config, ShellTask struct) are already in mod.rs — implement the missing pieces (trait impl, functions, error type).

All subcommands depend on these types. **Post a coord:interface bus message after implementing core changes.**

### 2. src/commands/run.rs — taskr run [OPTIONS] <task-file>
Task execution with dependency resolution. Requirements:
  - Parse task file via core::parse_task_file()
  - Load config from taskr.toml (or default)
  - --tag filter: only run tasks matching tag
  - Topological sort on dependencies (detect cycles → TaskrError::CycleDetected)
  - Execute tasks in order, skip dependents if a task fails
  - --dry-run: validate and report without executing
  - --json output: [{"name","status","output","duration_ms"}, ...]
  - Plain output: checkmark/cross + name + duration, summary line
  - Uses core::Task::execute(), core::Config, core::TaskResult

### 3. src/commands/list.rs — taskr list [OPTIONS] [path]
Task discovery and listing. Requirements:
  - File path: parse as task file; directory path: find *.toml files
  - --format table: aligned columns (Name | Tags | Deps | Status)
  - --format json: [{"name","tags","dependencies","status"}, ...]
  - --names-only: one name per line
  - --tag filter: only show matching tasks
  - Status: "ready" (deps exist) or "blocked" (missing deps)
  - Sort alphabetically by name
  - Uses core::parse_task_file(), core::Task

### 4. src/commands/validate.rs — taskr validate [OPTIONS] <task-file>
Validation without execution. Requirements:
  - Per-task: call task.validate() for ValidationIssues
  - Cross-task: duplicate names (Error), missing deps (Error), cycles with --check-deps (Error), empty commands (Warning), unused tasks (Info)
  - Plain output: severity icon + message, summary line
  - --json: {"valid":false,"issues":[...],"task_count":5}
  - Exit error if any Error-severity issues
  - Uses core::parse_task_file(), core::Task, core::ValidationIssue

## Dependencies between components
- core/ (mod.rs + config.rs) BLOCKS run.rs, list.rs, and validate.rs
- run.rs, list.rs, and validate.rs are INDEPENDENT of each other (can be done in parallel)
- BUT they all share core types — changes to core by one worker affect siblings

## Test data
Sample task files in data/: simple.toml (5 tasks, linear+diamond deps), complex.toml (9 tasks, DB→build→test→deploy), invalid.toml (dupes, missing deps, cycles, empty command), taskr.toml (config file).

Success metric: cargo test passes, all subcommands produce correct output on sample data, all flags work, shared core module is coherent.
Constraints: Use existing dependencies only (clap, serde, serde_json, toml, thiserror). Do not modify src/main.rs.
Stop criteria: All three subcommands fully working with all flags, core module complete and used by all commands.'

# --- Send !mission message (triggers router hook → respond.mjs → dev-loop) ---
echo "--- Sending !mission to taskr channel ($(date +%H:%M:%S)) ---"
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus send --agent setup taskr \
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
declare -A KNOWN_WORKERS=()
declare -A WORKER_LOG_CAPTURED=()
KNOWN_WORKER_COUNT=0

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

  DEV_RUNNING=$(echo "$BOTTY_JSON" | jq -r ".agents[] | select(.id == \"$TASKR_DEV\") | .id" 2>/dev/null || echo "")
  RESPOND_RUNNING=$(echo "$BOTTY_JSON" | jq -r '.agents[] | select(.id | test("respond")) | .id' 2>/dev/null || echo "")

  if [[ -n "$DEV_RUNNING" ]]; then
    echo "  taskr-dev: RUNNING"
    if [[ -z "$DEV_SPAWN_TIME" ]]; then
      DEV_SPAWN_TIME=$ELAPSED
      PHASE_TIMES+="dev_spawn=${DEV_SPAWN_TIME}s\n"
    fi
  else
    echo "  taskr-dev: not running"
  fi

  if [[ -n "$RESPOND_RUNNING" ]]; then
    echo "  respond: RUNNING ($RESPOND_RUNNING)"
  fi

  # Discover workers (hierarchical names: taskr-dev/<random>)
  WORKER_LIST=$(echo "$BOTTY_JSON" | jq -r '.agents[] | select(.id | test("/")) | .id' 2>/dev/null || echo "")
  if [[ -n "$WORKER_LIST" ]]; then
    while IFS= read -r worker_id; do
      [[ -z "$worker_id" ]] && continue
      wkey="${worker_id//\//_}"
      if [[ -z "${KNOWN_WORKERS[$wkey]+_}" ]]; then
        KNOWN_WORKERS["$wkey"]="$worker_id"
        WORKER_LOG_CAPTURED["$wkey"]=0
        KNOWN_WORKER_COUNT=$((KNOWN_WORKER_COUNT + 1))
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
  if [[ ${#KNOWN_WORKERS[@]} -gt 0 ]]; then
    for wkey in "${!KNOWN_WORKERS[@]}"; do
      orig_id="${KNOWN_WORKERS[$wkey]}"
      if ! echo "$WORKER_LIST" | grep -qF "$orig_id" 2>/dev/null; then
        if [[ "${WORKER_LOG_CAPTURED[$wkey]}" -eq 0 ]]; then
          botty tail "$orig_id" -n 500 > "$ARTIFACTS/agent-${wkey}.log" 2>/dev/null || true
          WORKER_LOG_CAPTURED["$wkey"]=1
          echo "  worker EXITED: $orig_id (log captured)"
          LAST_ACTIVITY_TIME=$(date +%s)
        fi
      fi
    done
  fi

  # Discover mission bead
  cd "$PROJECT_DIR"
  if [[ -z "$MISSION_BEAD" ]]; then
    MISSION_BEADS=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br list --all -l mission --format json 2>/dev/null || echo '[]')
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
    CHILDREN_JSON=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br list --all -l "mission:$MISSION_BEAD" --format json 2>/dev/null || echo '[]')
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
        AD_RUNNING=$(echo "$BOTTY_FINAL" | jq -r ".agents[] | select(.id == \"$TASKR_DEV\") | .id" 2>/dev/null || echo "")
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
  MSG_COUNT=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history taskr -n 200 2>/dev/null | wc -l || echo "0")
  echo "  Channel messages: $MSG_COUNT"

  if [[ "$MSG_COUNT" -gt "$LAST_MSG_COUNT" ]]; then
    LAST_ACTIVITY_TIME=$(date +%s)
    LAST_MSG_COUNT=$MSG_COUNT
  fi

  # Check for coordination messages (L5-specific)
  COORD_MSGS=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history taskr -n 200 2>/dev/null | grep -ci "coord:interface\|coord:blocker\|shared.*type\|core.*change" || echo "0")
  if [[ "$COORD_MSGS" -gt 0 ]]; then
    echo "  Coordination messages detected: $COORD_MSGS"
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
echo "--- Final status: taskr-dev=$FINAL_STATUS_DEV ($(date +%H:%M:%S)) ---"
echo ""

# --- Capture artifacts ---
echo "--- Capturing artifacts ---"

# Dev agent log
botty tail "$TASKR_DEV" -n 500 > "$ARTIFACTS/agent-${TASKR_DEV}.log" 2>/dev/null || \
  echo "(agent already exited, no tail available)" > "$ARTIFACTS/agent-${TASKR_DEV}.log"
echo "  log: $ARTIFACTS/agent-${TASKR_DEV}.log"

# Respond agent logs
for RESP_NAME in $(botty list --format json 2>/dev/null | jq -r '.agents[]? | select(.id | test("respond")) | .id' 2>/dev/null || true); do
  botty tail "$RESP_NAME" -n 500 > "$ARTIFACTS/agent-${RESP_NAME}.log" 2>/dev/null || true
  echo "  respond log: $ARTIFACTS/agent-${RESP_NAME}.log"
done
# Try common respond names that may have exited
for RNAME in "taskr-respond" "respond"; do
  if [[ ! -f "$ARTIFACTS/agent-${RNAME}.log" ]]; then
    botty tail "$RNAME" -n 500 > "$ARTIFACTS/agent-${RNAME}.log" 2>/dev/null || true
  fi
done

# Worker logs (capture any remaining)
if [[ ${#KNOWN_WORKERS[@]} -gt 0 ]]; then
  for wkey in "${!KNOWN_WORKERS[@]}"; do
    orig_id="${KNOWN_WORKERS[$wkey]}"
    if [[ ! -f "$ARTIFACTS/agent-${wkey}.log" ]] || [[ "${WORKER_LOG_CAPTURED[$wkey]}" -eq 0 ]]; then
      botty tail "$orig_id" -n 500 > "$ARTIFACTS/agent-${wkey}.log" 2>/dev/null || true
      echo "  worker log: $ARTIFACTS/agent-${wkey}.log"
    fi
  done
fi

# Any other agents we missed
for AGENT_NAME in $(botty list --format json 2>/dev/null | jq -r '.agents[]?.id // empty' 2>/dev/null || true); do
  SAFE_NAME="${AGENT_NAME//\//_}"
  if [[ ! -f "$ARTIFACTS/agent-${SAFE_NAME}.log" ]]; then
    botty tail "$AGENT_NAME" -n 500 > "$ARTIFACTS/agent-${SAFE_NAME}.log" 2>/dev/null || true
    echo "  extra log: $ARTIFACTS/agent-${SAFE_NAME}.log"
  fi
done

# Channel history (text + JSON)
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history taskr -n 200 > "$ARTIFACTS/channel-taskr-history.log" 2>/dev/null || \
  echo "(no history)" > "$ARTIFACTS/channel-taskr-history.log"
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history taskr -n 200 --format json > "$ARTIFACTS/channel-taskr-history.json" 2>/dev/null || \
  echo '{"messages":[]}' > "$ARTIFACTS/channel-taskr-history.json"
echo "  channel: $ARTIFACTS/channel-taskr-history.log"

# L5-specific: extract coordination messages
BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus search "coord" -c taskr > "$ARTIFACTS/coord-messages.log" 2>/dev/null || \
  echo "(no coord messages)" > "$ARTIFACTS/coord-messages.log"
echo "  coord messages: $ARTIFACTS/coord-messages.log"

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
WORKER_NAMES=""
if [[ $KNOWN_WORKER_COUNT -gt 0 ]]; then
  WORKER_NAMES=$(for wkey in "${!KNOWN_WORKERS[@]}"; do echo "${KNOWN_WORKERS[$wkey]}"; done | sort)
fi
cat > "$ARTIFACTS/final-status.txt" << EOF
TASKR_DEV_STATUS=$FINAL_STATUS_DEV
MISSION_BEAD=${MISSION_BEAD:-none}
CHILD_COUNT=$CHILD_COUNT
CHILDREN_CLOSED=$CHILDREN_CLOSED
WORKER_NAMES=$WORKER_NAMES
EOF

echo -e "$PHASE_TIMES" > "$ARTIFACTS/phase-times.log" 2>/dev/null || true

echo ""

# --- Kill remaining agents ---
echo "--- Cleaning up agents ---"
botty kill "$TASKR_DEV" 2>/dev/null || true
for AGENT_NAME in $(botty list --format json 2>/dev/null | jq -r '.agents[]?.id // empty' 2>/dev/null || true); do
  botty kill "$AGENT_NAME" 2>/dev/null || true
done
echo "  All agents stopped."
echo ""

# --- Verification ---
echo "--- Running verify ($(date +%H:%M:%S)) ---"
"$SCRIPT_DIR/e11-l5-verify.sh" "$EVAL_DIR/.eval-env" || true

# --- Summary ---
echo ""
echo "========================================="
echo "=== E11-L5 Complete ($(date +%H:%M:%S)) ==="
echo "========================================="
echo ""
echo "Final status:"
echo "  taskr-dev: $FINAL_STATUS_DEV"
echo "  Mission bead: ${MISSION_BEAD:-none}"
echo "  Children: $CHILDREN_CLOSED/$CHILD_COUNT closed"
echo "  Workers discovered: $KNOWN_WORKER_COUNT"
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
echo "  cat $ARTIFACTS/agent-${TASKR_DEV}.log"
echo "  cat $ARTIFACTS/channel-taskr-history.log"
echo "  cat $ARTIFACTS/coord-messages.log"
echo ""
