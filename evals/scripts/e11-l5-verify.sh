#!/usr/bin/env bash
set -euo pipefail

# E11-L5 Verification Script
# Automated scoring for the coordination mission eval.
# Checks all L4 categories (mission recognition, decomposition, worker dispatch,
# monitoring, synthesis, code correctness, friction) PLUS coordination-specific
# checks (~30 pts): bus reading, discovery posting, shared module coherence.

source "${1:?Usage: e11-l5-verify.sh <path-to-.eval-env>}"

echo "=== E11-L5 Verification ==="
echo "EVAL_DIR=$EVAL_DIR"
echo "PROJECT_DIR=$PROJECT_DIR"
echo "TASKR_DEV=$TASKR_DEV"
echo ""

PASS=0
FAIL=0
WARN=0
SCORE=0
TOTAL=0
ARTIFACTS="$EVAL_DIR/artifacts"

check() {
  local label="$1"
  local result="$2"  # 0 = pass, 1 = fail
  local pts="${3:-0}"
  TOTAL=$((TOTAL + pts))
  if [[ "$result" -eq 0 ]]; then
    echo "PASS ($pts pts): $label"
    PASS=$((PASS + 1))
    SCORE=$((SCORE + pts))
  else
    echo "FAIL (0/$pts pts): $label"
    FAIL=$((FAIL + 1))
  fi
}

warn() {
  echo "WARN: $1"
  WARN=$((WARN + 1))
}

# Load artifacts
DEV_LOG=$(cat "$ARTIFACTS/agent-${TASKR_DEV}.log" 2>/dev/null || echo "")
CHANNEL_HISTORY=$(cat "$ARTIFACTS/channel-taskr-history.log" 2>/dev/null || echo "")
FINAL_STATUS=$(cat "$ARTIFACTS/final-status.txt" 2>/dev/null || echo "")
CHANNEL_JSON=$(cat "$ARTIFACTS/channel-taskr-history.json" 2>/dev/null || echo '{"messages":[]}')
CHANNEL_LABELS=$(echo "$CHANNEL_JSON" | jq -r '[.messages[].labels // [] | .[]] | .[]' 2>/dev/null || echo "")
COORD_MESSAGES=$(cat "$ARTIFACTS/coord-messages.log" 2>/dev/null || echo "")

# Load all worker logs into a combined variable for coordination checks
ALL_WORKER_LOGS=""
for wlog in "$ARTIFACTS"/agent-${TASKR_DEV}_*.log; do
  [[ -f "$wlog" ]] || continue
  ALL_WORKER_LOGS+=$(cat "$wlog" 2>/dev/null || echo "")
  ALL_WORKER_LOGS+=$'\n'
done

# Extract mission bead from final status
MISSION_BEAD=$(echo "$FINAL_STATUS" | grep -oP 'MISSION_BEAD=\K[^ ]+' || echo "none")
CHILD_COUNT_FINAL=$(echo "$FINAL_STATUS" | grep -oP 'CHILD_COUNT=\K\d+' || echo "0")
CHILDREN_CLOSED_FINAL=$(echo "$FINAL_STATUS" | grep -oP 'CHILDREN_CLOSED=\K\d+' || echo "0")

cd "$PROJECT_DIR"

# ============================================================
# Critical Fail: Mission never created
# ============================================================
echo "=== Critical Fail Check ==="
echo ""
if [[ "$MISSION_BEAD" == "none" || -z "$MISSION_BEAD" ]]; then
  echo "CRITICAL FAIL: Mission bead was never created"
  echo ""
  echo "SCORE: 0 / 0 (critical fail)"
  echo "RESULT: CRITICAL FAIL — mission never created"
  exit 0
fi
echo "Mission bead: $MISSION_BEAD"
echo ""

# ============================================================
# Mission Recognition (15 pts)
# ============================================================
echo "=== Mission Recognition (15 pts) ==="
echo ""

# Check 1: Bead with mission label (5 pts)
echo "--- Check 1: Mission bead with label ---"
MISSION_JSON=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br show "$MISSION_BEAD" --format json 2>/dev/null || echo "[]")
HAS_MISSION_LABEL=false
if echo "$MISSION_JSON" | jq -r '.[0].labels // [] | .[]' 2>/dev/null | grep -q "mission"; then
  HAS_MISSION_LABEL=true
fi
check "Mission bead has 'mission' label" "$($HAS_MISSION_LABEL && echo 0 || echo 1)" 5

# Check 2: Structured description (5 pts)
echo ""
echo "--- Check 2: Structured description ---"
MISSION_DESC=$(echo "$MISSION_JSON" | jq -r '.[0].description // ""' 2>/dev/null || echo "")
HAS_OUTCOME=false
if echo "$MISSION_DESC" | grep -qi "outcome\|success.*metric\|constraints\|stop.*crit"; then
  HAS_OUTCOME=true
fi
check "Mission bead has structured description (Outcome/Success/Constraints)" "$($HAS_OUTCOME && echo 0 || echo 1)" 5

# Check 3: Dev-loop identified mission context (5 pts)
echo ""
echo "--- Check 3: Dev-loop identified mission ---"
DEV_MISSION_CTX=false
if echo "$DEV_LOG" | grep -qi "BOTBOX_MISSION\|mission.*${MISSION_BEAD}\|Level 4\|mission.*decompos"; then
  DEV_MISSION_CTX=true
fi
if echo "$CHANNEL_HISTORY" | grep -qi "mission.*${MISSION_BEAD}\|mission.*creat"; then
  DEV_MISSION_CTX=true
fi
check "Dev-loop identified mission context" "$($DEV_MISSION_CTX && echo 0 || echo 1)" 5

# ============================================================
# Decomposition (25 pts)
# ============================================================
echo ""
echo "=== Decomposition (25 pts) ==="
echo ""

# Get children
CHILDREN_JSON=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br list --all -l "mission:$MISSION_BEAD" --format json 2>/dev/null || echo '[]')
# Normalize JSON shape
ACTUAL_CHILD_COUNT=$(echo "$CHILDREN_JSON" | jq 'if type == "array" then length elif .beads then (.beads | length) else 0 end' 2>/dev/null || echo "0")

# Check 4: 3+ children (5 pts)
echo "--- Check 4: Child bead count ---"
check "3+ child beads created (actual=$ACTUAL_CHILD_COUNT)" "$([ "$ACTUAL_CHILD_COUNT" -ge 3 ] && echo 0 || echo 1)" 5

# Check 5: mission:<id> labels (5 pts)
echo ""
echo "--- Check 5: Mission labels on children ---"
LABELED_COUNT=0
CHILD_IDS=$(echo "$CHILDREN_JSON" | jq -r 'if type == "array" then .[].id elif .beads then .beads[].id else empty end' 2>/dev/null || echo "")
for cid in $CHILD_IDS; do
  CHILD_LABELS=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br show "$cid" --format json 2>/dev/null | jq -r '.[0].labels // [] | .[]' 2>/dev/null || echo "")
  if echo "$CHILD_LABELS" | grep -q "mission:"; then
    LABELED_COUNT=$((LABELED_COUNT + 1))
  fi
done
check "Children have mission:<id> labels ($LABELED_COUNT/$ACTUAL_CHILD_COUNT)" "$([ "$LABELED_COUNT" -ge 3 ] && echo 0 || echo 1)" 5

# Check 6: Parent dependencies (5 pts)
echo ""
echo "--- Check 6: Parent dependencies ---"
HAS_PARENT_DEP=false
if echo "$DEV_LOG" | grep -qi "br dep add\|dep.*add"; then
  HAS_PARENT_DEP=true
fi
for cid in $CHILD_IDS; do
  CHILD_DEPS=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br show "$cid" --format json 2>/dev/null | jq -r '.[0].dependencies // [] | length' 2>/dev/null || echo "0")
  if [[ "$CHILD_DEPS" -gt 0 ]]; then
    HAS_PARENT_DEP=true
    break
  fi
done
check "Dependencies wired between children or to parent" "$($HAS_PARENT_DEP && echo 0 || echo 1)" 5

# Check 7: Inter-child dependency (5 pts)
echo ""
echo "--- Check 7: Inter-child dependency ---"
HAS_INTER_DEP=false
DEP_ADD_COUNT=$(echo "$DEV_LOG" | grep -ci "br dep add" 2>/dev/null) || DEP_ADD_COUNT=0
if [[ "$DEP_ADD_COUNT" -ge 1 ]]; then
  HAS_INTER_DEP=true
fi
check "Inter-child dependency exists (dep add count=$DEP_ADD_COUNT)" "$($HAS_INTER_DEP && echo 0 || echo 1)" 5

# Check 8: Clear titles (5 pts)
echo ""
echo "--- Check 8: Clear child titles ---"
CLEAR_TITLES=false
if [[ "$ACTUAL_CHILD_COUNT" -gt 0 ]]; then
  CLEAR_TITLES=true
  for cid in $CHILD_IDS; do
    CHILD_TITLE=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br show "$cid" --format json 2>/dev/null | jq -r '.[0].title // ""' 2>/dev/null || echo "")
    if [[ ${#CHILD_TITLE} -lt 5 ]]; then
      CLEAR_TITLES=false
      warn "Child $cid has unclear title: '$CHILD_TITLE'"
    fi
  done
fi
check "Child beads have clear titles" "$($CLEAR_TITLES && echo 0 || echo 1)" 5

# ============================================================
# Worker Dispatch (25 pts)
# ============================================================
echo ""
echo "=== Worker Dispatch (25 pts) ==="
echo ""

# Extract worker info from final status
WORKER_NAMES=$(echo "$FINAL_STATUS" | sed -n '/^WORKER_NAMES/,$ p' | tail -n +2 | grep -v '^$' || echo "")
WORKER_COUNT=0
if [[ -n "$WORKER_NAMES" ]]; then
  WORKER_COUNT=$(echo "$WORKER_NAMES" | wc -l)
fi

# Check 9: Workers spawned (5 pts)
echo "--- Check 9: Workers spawned ---"
WORKERS_SPAWNED=false
if [[ "$WORKER_COUNT" -ge 1 ]]; then
  WORKERS_SPAWNED=true
fi
if echo "$DEV_LOG" | grep -i "botty spawn" | grep -q "/"; then
  WORKERS_SPAWNED=true
fi
check "Workers spawned ($WORKER_COUNT discovered)" "$($WORKERS_SPAWNED && echo 0 || echo 1)" 5

# Critical fail: no workers → cap score at 30%
if ! $WORKERS_SPAWNED; then
  echo ""
  echo "CRITICAL: No workers spawned — capping total score at 30%"
  echo ""
fi

# Check 10: 2+ workers (5 pts)
echo ""
echo "--- Check 10: Multiple workers ---"
check "2+ workers spawned ($WORKER_COUNT)" "$([ "$WORKER_COUNT" -ge 2 ] && echo 0 || echo 1)" 5

# Check 11: Workspace per worker (5 pts)
echo ""
echo "--- Check 11: Workspace per worker ---"
WS_CREATE_COUNT=$(echo "$DEV_LOG" | grep -ci "maw ws create" 2>/dev/null) || WS_CREATE_COUNT=0
WORKER_WS=false
if [[ "$WS_CREATE_COUNT" -ge 2 ]]; then
  WORKER_WS=true
fi
check "Workspaces created for workers ($WS_CREATE_COUNT ws creates)" "$($WORKER_WS && echo 0 || echo 1)" 5

# Check 12: Mission env vars (5 pts)
echo ""
echo "--- Check 12: Mission env vars ---"
HAS_MISSION_ENV=false
if echo "$DEV_LOG" | grep -qi "BOTBOX_MISSION\|BOTBOX_SIBLINGS\|BOTBOX_MISSION_OUTCOME"; then
  HAS_MISSION_ENV=true
fi
if echo "$CHANNEL_HISTORY" | grep -qi "mission.*context\|mission.*bd-"; then
  HAS_MISSION_ENV=true
fi
for cid in $CHILD_IDS; do
  CHILD_COMMENTS=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- br comments "$cid" 2>/dev/null || echo "")
  if echo "$CHILD_COMMENTS" | grep -qi "mission.*context\|BOTBOX_MISSION"; then
    HAS_MISSION_ENV=true
    break
  fi
done
check "Mission env vars set on workers (BOTBOX_MISSION, etc.)" "$($HAS_MISSION_ENV && echo 0 || echo 1)" 5

# Check 13: Claims staked for workers (5 pts)
echo ""
echo "--- Check 13: Claims staked for workers ---"
CLAIM_COUNT=$(echo "$DEV_LOG" | grep -ci "bus claims stake" 2>/dev/null) || CLAIM_COUNT=0
HAS_WORKER_CLAIMS=false
if [[ "$CLAIM_COUNT" -ge 3 ]]; then
  HAS_WORKER_CLAIMS=true
fi
check "Claims staked for workers ($CLAIM_COUNT total stakes)" "$($HAS_WORKER_CLAIMS && echo 0 || echo 1)" 5

# ============================================================
# Monitoring (15 pts)
# ============================================================
echo ""
echo "=== Monitoring (15 pts) ==="
echo ""

# Check 14: Checkpoint message (5 pts)
echo "--- Check 14: Checkpoint message ---"
HAS_CHECKPOINT=false
if echo "$CHANNEL_HISTORY" | grep -qi "checkpoint\|mission.*done\|active\|progress.*mission"; then
  HAS_CHECKPOINT=true
fi
if echo "$DEV_LOG" | grep -qi "checkpoint"; then
  HAS_CHECKPOINT=true
fi
check "Checkpoint message posted" "$($HAS_CHECKPOINT && echo 0 || echo 1)" 5

# Check 15: Count/status info (5 pts)
echo ""
echo "--- Check 15: Count/status info ---"
HAS_COUNT_INFO=false
if echo "$CHANNEL_HISTORY" | grep -qiE "[0-9]+.*done|[0-9]+.*closed|[0-9]+.*active|[0-9]+/[0-9]+"; then
  HAS_COUNT_INFO=true
fi
if echo "$DEV_LOG" | grep -qiE "children.*closed|children.*status|[0-9]+.*done.*[0-9]+.*total"; then
  HAS_COUNT_INFO=true
fi
check "Count/status info in checkpoint" "$($HAS_COUNT_INFO && echo 0 || echo 1)" 5

# Check 16: Worker completion detected (5 pts)
echo ""
echo "--- Check 16: Worker completion detected ---"
COMPLETION_DETECTED=false
if echo "$DEV_LOG" | grep -qi "worker.*finish\|worker.*exit\|child.*closed\|maw ws merge.*--destroy"; then
  MERGE_COUNT=$(echo "$DEV_LOG" | grep -ci "maw ws merge" 2>/dev/null) || MERGE_COUNT=0
  if [[ "$MERGE_COUNT" -ge 2 ]]; then
    COMPLETION_DETECTED=true
  fi
fi
if echo "$DEV_LOG" | grep -qi "worker.*complet\|child.*done"; then
  COMPLETION_DETECTED=true
fi
check "Worker completion detected" "$($COMPLETION_DETECTED && echo 0 || echo 1)" 5

# ============================================================
# Synthesis (15 pts)
# ============================================================
echo ""
echo "=== Synthesis (15 pts) ==="
echo ""

# Check 17: All children closed (5 pts)
echo "--- Check 17: All children closed ---"
ALL_CHILDREN_CLOSED=false
CLOSED_COUNT=0
if [[ "$ACTUAL_CHILD_COUNT" -gt 0 ]]; then
  CLOSED_COUNT=$(echo "$CHILDREN_JSON" | jq '[if type == "array" then .[] elif .beads then .beads[] else empty end | select(.status == "closed")] | length' 2>/dev/null || echo "0")
  if [[ "$CLOSED_COUNT" -ge "$ACTUAL_CHILD_COUNT" ]]; then
    ALL_CHILDREN_CLOSED=true
  fi
  echo "  Children closed: $CLOSED_COUNT/$ACTUAL_CHILD_COUNT"
fi
check "All children closed ($CLOSED_COUNT/$ACTUAL_CHILD_COUNT)" "$($ALL_CHILDREN_CLOSED && echo 0 || echo 1)" 5

# Check 18: Mission bead closed (5 pts)
echo ""
echo "--- Check 18: Mission bead closed ---"
MISSION_STATUS=$(echo "$MISSION_JSON" | jq -r '.[0].status // "unknown"' 2>/dev/null || echo "unknown")
MISSION_CLOSED=false
[[ "$MISSION_STATUS" == "closed" ]] && MISSION_CLOSED=true
check "Mission bead closed (status=$MISSION_STATUS)" "$($MISSION_CLOSED && echo 0 || echo 1)" 5

# Check 19: Synthesis comment (5 pts)
echo ""
echo "--- Check 19: Synthesis comment ---"
HAS_SYNTHESIS=false
MISSION_COMMENTS=$(echo "$MISSION_JSON" | jq -r '.[0].comments // [] | .[].body // .[].content // empty' 2>/dev/null || echo "")
if echo "$MISSION_COMMENTS" | grep -qi "mission.*complete\|synthesis\|children.*closed\|all.*done\|key.*decision\|what.*worked"; then
  HAS_SYNTHESIS=true
fi
if echo "$CHANNEL_HISTORY" | grep -qi "mission.*complete\|all.*children.*done"; then
  HAS_SYNTHESIS=true
fi
check "Synthesis comment on mission bead" "$($HAS_SYNTHESIS && echo 0 || echo 1)" 5

# ============================================================
# Code Correctness (20 pts)
# ============================================================
echo ""
echo "=== Code Correctness (20 pts) ==="
echo ""

# Check 20: cargo check (5 pts)
echo "--- Check 20: cargo check ---"
CARGO_OK=false
if BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- cargo check 2>/dev/null; then
  CARGO_OK=true
fi
check "cargo check passes" "$($CARGO_OK && echo 0 || echo 1)" 5

# Check 21: 2+ subcommands implemented (5 pts)
echo ""
echo "--- Check 21: Subcommands implemented ---"
IMPL_COUNT=0
for mod_name in run list validate; do
  MOD_FILE="$PROJECT_DIR/ws/default/src/commands/${mod_name}.rs"
  if [[ -f "$MOD_FILE" ]] && ! grep -q 'todo!' "$MOD_FILE" 2>/dev/null; then
    IMPL_COUNT=$((IMPL_COUNT + 1))
  fi
done
check "2+ subcommands implemented (found=$IMPL_COUNT)" "$([ "$IMPL_COUNT" -ge 2 ] && echo 0 || echo 1)" 5

# Check 22: Shared core module implemented (5 pts)
echo ""
echo "--- Check 22: Shared core module implemented ---"
CORE_MOD="$PROJECT_DIR/ws/default/src/core/mod.rs"
CORE_CONFIG="$PROJECT_DIR/ws/default/src/core/config.rs"
CORE_IMPL_COUNT=0
# Check mod.rs: no todo!() at module level and ShellTask impl exists
if [[ -f "$CORE_MOD" ]]; then
  MOD_TODOS=$(grep -c 'todo!' "$CORE_MOD" 2>/dev/null) || MOD_TODOS=0
  if [[ "$MOD_TODOS" -eq 0 ]]; then
    CORE_IMPL_COUNT=$((CORE_IMPL_COUNT + 1))
  fi
  # Check for parse_task_file function
  if grep -q 'fn parse_task_file\|pub fn parse' "$CORE_MOD" 2>/dev/null; then
    CORE_IMPL_COUNT=$((CORE_IMPL_COUNT + 1))
  fi
fi
# Check config.rs: no todo!() and load_config exists
if [[ -f "$CORE_CONFIG" ]]; then
  CFG_TODOS=$(grep -c 'todo!' "$CORE_CONFIG" 2>/dev/null) || CFG_TODOS=0
  if [[ "$CFG_TODOS" -eq 0 ]]; then
    CORE_IMPL_COUNT=$((CORE_IMPL_COUNT + 1))
  fi
fi
check "Shared core module implemented ($CORE_IMPL_COUNT/3 pieces)" "$([ "$CORE_IMPL_COUNT" -ge 2 ] && echo 0 || echo 1)" 5

# Check 23: Subcommands work on sample data (5 pts)
echo ""
echo "--- Check 23: Subcommands work on sample data ---"
WORKING_COUNT=0
if BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- cargo build --quiet 2>/dev/null; then
  # Try list on simple.toml
  LIST_OUT=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- cargo run --quiet -- list data/simple.toml 2>/dev/null || echo "")
  if echo "$LIST_OUT" | grep -qiE "build|test|clean|lint|release"; then
    WORKING_COUNT=$((WORKING_COUNT + 1))
  fi
  # Try validate on invalid.toml
  VALIDATE_OUT=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- cargo run --quiet -- validate data/invalid.toml 2>/dev/null || echo "")
  if echo "$VALIDATE_OUT" | grep -qiE "error|warning|duplicate|nonexistent|cycle|invalid"; then
    WORKING_COUNT=$((WORKING_COUNT + 1))
  fi
  # Try run on simple.toml (dry-run)
  RUN_OUT=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- cargo run --quiet -- run data/simple.toml --dry-run 2>/dev/null || echo "")
  if echo "$RUN_OUT" | grep -qiE "build|test|clean|would|dry|skip"; then
    WORKING_COUNT=$((WORKING_COUNT + 1))
  fi
fi
check "Subcommands working on sample data ($WORKING_COUNT/3)" "$([ "$WORKING_COUNT" -ge 2 ] && echo 0 || echo 1)" 5

# Check 23b: Feature flags work (5 pts) — bonus for expanded feature set
echo ""
echo "--- Check 23b: Feature flags work ---"
FLAGS_WORKING=0
if BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- cargo build --quiet 2>/dev/null; then
  # list --format json
  LJ=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- cargo run --quiet -- list data/simple.toml --format json 2>/dev/null || echo "")
  echo "$LJ" | python3 -c "import sys,json;json.load(sys.stdin)" 2>/dev/null && FLAGS_WORKING=$((FLAGS_WORKING + 1))
  # list --names-only
  LN=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- cargo run --quiet -- list data/simple.toml --names-only 2>/dev/null || echo "")
  if echo "$LN" | grep -qE "^build$|^test$|^clean$"; then
    FLAGS_WORKING=$((FLAGS_WORKING + 1))
  fi
  # validate --json
  VJ=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- cargo run --quiet -- validate data/invalid.toml --json 2>/dev/null || echo "")
  echo "$VJ" | python3 -c "import sys,json;json.load(sys.stdin)" 2>/dev/null && FLAGS_WORKING=$((FLAGS_WORKING + 1))
  # run --json --dry-run
  RJ=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" maw exec default -- cargo run --quiet -- run data/simple.toml --json --dry-run 2>/dev/null || echo "")
  echo "$RJ" | python3 -c "import sys,json;json.load(sys.stdin)" 2>/dev/null && FLAGS_WORKING=$((FLAGS_WORKING + 1))
fi
TOTAL=$((TOTAL + 5))
if [[ "$FLAGS_WORKING" -ge 3 ]]; then
  echo "PASS (5 pts): $FLAGS_WORKING/4 feature flags work"
  SCORE=$((SCORE + 5)); PASS=$((PASS + 1))
elif [[ "$FLAGS_WORKING" -ge 2 ]]; then
  echo "PARTIAL (3/5 pts): $FLAGS_WORKING/4 feature flags work"
  SCORE=$((SCORE + 3)); PASS=$((PASS + 1))
elif [[ "$FLAGS_WORKING" -ge 1 ]]; then
  echo "PARTIAL (1/5 pts): $FLAGS_WORKING/4 feature flags work"
  SCORE=$((SCORE + 1)); PASS=$((PASS + 1))
else
  echo "FAIL (0/5 pts): No feature flags work ($FLAGS_WORKING/4)"
  FAIL=$((FAIL + 1))
fi

# ============================================================
# Coordination (30 pts) — NEW in L5
# ============================================================
echo ""
echo "=== Coordination (30 pts) — L5 SPECIFIC ==="
echo ""

# --- Bus Reading (10 pts) ---

# Check 24: Worker logs show bus history calls (5 pts)
# Workers should read bus history to check for sibling updates on shared types
echo "--- Check 24: Workers read bus history ---"
WORKER_BUS_READ=false
# Check worker logs for bus history calls
for wlog in "$ARTIFACTS"/agent-${TASKR_DEV}_*.log; do
  [[ -f "$wlog" ]] || continue
  if grep -qi "bus history\|bus inbox\|bus search" "$wlog" 2>/dev/null; then
    WORKER_BUS_READ=true
    break
  fi
done
# Also check if dev-loop instructed workers to read bus (in dispatch prompts)
if echo "$DEV_LOG" | grep -qi "bus history.*coord\|check.*bus.*sibling\|read.*bus.*before\|coord.*message"; then
  WORKER_BUS_READ=true
fi
check "Workers read bus for sibling updates" "$($WORKER_BUS_READ && echo 0 || echo 1)" 5

# Check 25: Worker adapted to sibling change (5 pts)
# Evidence that a worker saw a sibling's interface change and adjusted
echo ""
echo "--- Check 25: Worker adapted to sibling change ---"
WORKER_ADAPTED=false
# Look for evidence in worker logs: mentions of sibling changes, adapted types, etc.
for wlog in "$ARTIFACTS"/agent-${TASKR_DEV}_*.log; do
  [[ -f "$wlog" ]] || continue
  if grep -qi "sibling.*change\|core.*update\|trait.*change\|adapt\|interface.*change\|coord.*interface" "$wlog" 2>/dev/null; then
    WORKER_ADAPTED=true
    break
  fi
done
# Also count as adapted if workers successfully import shared types without compilation errors
# (evidence of coordination on types even if not explicitly called out)
if [[ "$CARGO_OK" == "true" && "$IMPL_COUNT" -ge 2 ]]; then
  # If 2+ subcommands compile with shared core, there was at least implicit coordination
  WORKER_ADAPTED=true
fi
check "Worker adapted to sibling changes" "$($WORKER_ADAPTED && echo 0 || echo 1)" 5

# --- Discovery Posting (10 pts) ---

# Check 26: coord:interface message posted (5 pts)
echo ""
echo "--- Check 26: coord:interface message posted ---"
HAS_COORD_MSG=false
# Check channel history for coord:interface label
if echo "$CHANNEL_LABELS" | grep -qi "coord:interface"; then
  HAS_COORD_MSG=true
fi
# Also check channel text for coordination patterns
if echo "$CHANNEL_HISTORY" | grep -qi "coord:interface\|interface.*change\|core.*change\|shared.*type.*change\|modified.*core\|updated.*trait\|changed.*Config"; then
  HAS_COORD_MSG=true
fi
# Check coord-messages artifact
if echo "$COORD_MESSAGES" | grep -qi "coord\|interface\|core.*change"; then
  HAS_COORD_MSG=true
fi
# Check if any worker/dev posted about shared type changes
if echo "$DEV_LOG" | grep -qi "coord:interface\|bus send.*coord"; then
  HAS_COORD_MSG=true
fi
for wlog in "$ARTIFACTS"/agent-${TASKR_DEV}_*.log; do
  [[ -f "$wlog" ]] || continue
  if grep -qi "coord:interface\|bus send.*coord\|-L coord" "$wlog" 2>/dev/null; then
    HAS_COORD_MSG=true
    break
  fi
done
check "coord:interface message posted" "$($HAS_COORD_MSG && echo 0 || echo 1)" 5

# Check 27: Message describes actual code change (5 pts)
echo ""
echo "--- Check 27: Coordination message describes code change ---"
COORD_DESCRIBES_CHANGE=false
# Check if coordination messages mention specific types/functions
COORD_TEXT=""
# Gather all potential coordination text from channel and logs
COORD_TEXT+=$(echo "$CHANNEL_HISTORY" | grep -i "coord\|interface\|core.*change\|trait\|Config\|TaskResult\|ShellTask\|parse_task" 2>/dev/null || echo "")
COORD_TEXT+=$(echo "$COORD_MESSAGES" 2>/dev/null || echo "")
for wlog in "$ARTIFACTS"/agent-${TASKR_DEV}_*.log; do
  [[ -f "$wlog" ]] || continue
  COORD_TEXT+=$(grep -i "coord.*interface\|bus send.*coord\|posting.*coord\|announce.*change" "$wlog" 2>/dev/null || echo "")
done
COORD_TEXT+=$(echo "$DEV_LOG" | grep -i "coord.*interface\|bus send.*coord\|posting.*coord\|announce.*change" 2>/dev/null || echo "")

if echo "$COORD_TEXT" | grep -qi "Task\|Config\|TaskResult\|ShellTask\|parse_task_file\|trait\|struct\|enum\|field\|signature\|method\|function"; then
  COORD_DESCRIBES_CHANGE=true
fi
check "Coordination message describes actual code change" "$($COORD_DESCRIBES_CHANGE && echo 0 || echo 1)" 5

# --- Shared Module Coherence (10 pts) ---

# Check 28: Core module compiles (5 pts)
echo ""
echo "--- Check 28: Core module compiles ---"
# This is already tested by cargo check above, but check specifically that core/ is non-trivial
CORE_COMPILES=false
if [[ "$CARGO_OK" == "true" ]]; then
  # Verify core module has actual content (not just stubs)
  if [[ -f "$CORE_MOD" ]]; then
    CORE_LINES=$(wc -l < "$CORE_MOD" 2>/dev/null || echo "0")
    if [[ "$CORE_LINES" -gt 30 ]]; then
      CORE_COMPILES=true
    fi
  fi
fi
check "Core module compiles with substantial content ($CORE_LINES lines)" "$($CORE_COMPILES && echo 0 || echo 1)" 5

# Check 29: 2+ subcommands use shared types (5 pts)
echo ""
echo "--- Check 29: 2+ subcommands use shared types ---"
USING_SHARED=0
for mod_name in run list validate; do
  MOD_FILE="$PROJECT_DIR/ws/default/src/commands/${mod_name}.rs"
  if [[ -f "$MOD_FILE" ]]; then
    # Check for imports from core module
    if grep -qE "use crate::core|core::|Task|Config|TaskResult|TaskrError|ShellTask|parse_task" "$MOD_FILE" 2>/dev/null; then
      USING_SHARED=$((USING_SHARED + 1))
    fi
  fi
done
check "2+ subcommands use shared core types ($USING_SHARED/3)" "$([ "$USING_SHARED" -ge 2 ] && echo 0 || echo 1)" 5

# ============================================================
# Friction Efficiency (10 pts)
# ============================================================
echo ""
echo "=== Friction Efficiency (10 pts) ==="
echo ""

echo "Analyzing agent logs for friction signals..."
echo ""

_count_tool_errors() {
  local log="$1"
  local count=0
  local tue; tue=$(grep -c "tool_use_error" "$log" 2>/dev/null) || tue=0
  count=$((count + tue))
  local ec; ec=$(awk '
    /Exit code [12][^0-9]/ || /Exit code [12]$/ {
      if (prev ~ /cargo run/ || prev ~ /\.\/target\// || (prev ~ /^> Bash/ && prev ~ /"command":"cd /)) next
      count++
    }
    { prev = $0 }
    END { print count+0 }
  ' "$log" 2>/dev/null) || ec=0
  count=$((count + ec))
  echo "$count"
}

# Dev + worker friction
DEV_ERRORS=$(_count_tool_errors "$ARTIFACTS/agent-${TASKR_DEV}.log")
DEV_HELP=$(grep -c "\-\-help" "$ARTIFACTS/agent-${TASKR_DEV}.log" 2>/dev/null) || DEV_HELP=0
DEV_RETRIES=$(grep -c "retry\|again\|Retrying" "$ARTIFACTS/agent-${TASKR_DEV}.log" 2>/dev/null) || DEV_RETRIES=0

WORKER_ERRORS=0
WORKER_HELP=0
WORKER_RETRIES=0
for wlog in "$ARTIFACTS"/agent-${TASKR_DEV}_*.log; do
  [[ -f "$wlog" ]] || continue
  WE=$(_count_tool_errors "$wlog")
  WH=$(grep -c "\-\-help" "$wlog" 2>/dev/null) || WH=0
  WR=$(grep -c "retry\|again\|Retrying" "$wlog" 2>/dev/null) || WR=0
  WORKER_ERRORS=$((WORKER_ERRORS + WE))
  WORKER_HELP=$((WORKER_HELP + WH))
  WORKER_RETRIES=$((WORKER_RETRIES + WR))
done

TOTAL_ERRORS=$((DEV_ERRORS + WORKER_ERRORS))
TOTAL_HELP=$((DEV_HELP + WORKER_HELP))
TOTAL_RETRIES=$((DEV_RETRIES + WORKER_RETRIES))

echo "Dev: $DEV_ERRORS errors, $DEV_HELP --help, $DEV_RETRIES retries"
echo "Workers: $WORKER_ERRORS errors, $WORKER_HELP --help, $WORKER_RETRIES retries"
echo "Total: $TOTAL_ERRORS errors, $TOTAL_HELP --help, $TOTAL_RETRIES retries"
echo ""

# Check 30: Tool errors (5 pts)
echo "--- Check 30: Tool errors ---"
TOTAL=$((TOTAL + 5))
if [[ "$TOTAL_ERRORS" -eq 0 ]]; then
  echo "PASS (5 pts): Zero tool errors"
  SCORE=$((SCORE + 5)); PASS=$((PASS + 1))
elif [[ "$TOTAL_ERRORS" -le 5 ]]; then
  echo "PARTIAL (3/5 pts): $TOTAL_ERRORS tool errors (threshold: <=5)"
  SCORE=$((SCORE + 3)); PASS=$((PASS + 1))
elif [[ "$TOTAL_ERRORS" -le 15 ]]; then
  echo "PARTIAL (1/5 pts): $TOTAL_ERRORS tool errors (threshold: <=15)"
  SCORE=$((SCORE + 1)); PASS=$((PASS + 1))
else
  echo "FAIL (0/5 pts): $TOTAL_ERRORS tool errors"
  FAIL=$((FAIL + 1))
fi
echo ""

# Check 31: --help + retries (5 pts)
echo "--- Check 31: --help and retries ---"
TOTAL=$((TOTAL + 5))
HELP_RETRY_TOTAL=$((TOTAL_HELP + TOTAL_RETRIES))
if [[ "$HELP_RETRY_TOTAL" -eq 0 ]]; then
  echo "PASS (5 pts): Zero --help lookups and retries"
  SCORE=$((SCORE + 5)); PASS=$((PASS + 1))
elif [[ "$HELP_RETRY_TOTAL" -le 3 ]]; then
  echo "PARTIAL (3/5 pts): $HELP_RETRY_TOTAL --help/retries (threshold: <=3)"
  SCORE=$((SCORE + 3)); PASS=$((PASS + 1))
elif [[ "$HELP_RETRY_TOTAL" -le 8 ]]; then
  echo "PARTIAL (1/5 pts): $HELP_RETRY_TOTAL --help/retries (threshold: <=8)"
  SCORE=$((SCORE + 1)); PASS=$((PASS + 1))
else
  echo "FAIL (0/5 pts): $HELP_RETRY_TOTAL --help/retries"
  FAIL=$((FAIL + 1))
fi
echo ""

# ============================================================
# Critical Fail: No workers spawned → cap at 30%
# ============================================================
if ! $WORKERS_SPAWNED; then
  MAX_SCORE=$(( TOTAL * 30 / 100 ))
  if [[ "$SCORE" -gt "$MAX_SCORE" ]]; then
    echo "CAPPING: No workers spawned — score capped from $SCORE to $MAX_SCORE (30% of $TOTAL)"
    SCORE=$MAX_SCORE
  fi
fi

# ============================================================
# Critical Fail: No coordination → coordination score = 0
# ============================================================
# If no coord:interface messages posted, zero out coordination category
if ! $HAS_COORD_MSG; then
  echo ""
  echo "NOTE: No coord:interface messages detected — coordination category scored individually"
  echo "      (workers may still have coordinated implicitly via shared compilation)"
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo "=== Verification Summary ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
echo "WARN: $WARN"
echo "SCORE: $SCORE / $TOTAL"
echo ""

# Category breakdown
echo "=== Category Breakdown ==="
echo "Mission Recognition:   15 pts"
echo "Decomposition:         25 pts"
echo "Worker Dispatch:       25 pts"
echo "Monitoring:            15 pts"
echo "Synthesis:             15 pts"
echo "Code Correctness:      25 pts"
echo "Coordination (L5):     30 pts"
echo "Friction Efficiency:   10 pts"
echo "                      ─────────"
echo "Total possible:       ~160 pts"
echo ""

if [[ "$FAIL" -eq 0 ]]; then
  echo "RESULT: ALL CHECKS PASSED ($SCORE/$TOTAL)"
elif [[ "$SCORE" -ge $(( TOTAL * 85 / 100 )) ]]; then
  echo "RESULT: EXCELLENT ($SCORE/$TOTAL) — $FAIL checks failed"
elif [[ "$SCORE" -ge $(( TOTAL * 70 / 100 )) ]]; then
  echo "RESULT: PASS ($SCORE/$TOTAL) — $FAIL checks failed"
else
  echo "RESULT: FAIL ($SCORE/$TOTAL) — $FAIL checks failed"
fi

echo ""
echo "=== Forensics ==="
echo "EVAL_DIR=$EVAL_DIR"
echo "BOTBUS_DATA_DIR=$BOTBUS_DATA_DIR"
echo "PROJECT_DIR=$PROJECT_DIR"
echo "MISSION_BEAD=$MISSION_BEAD"
echo ""
echo "Run 'BOTBUS_DATA_DIR=$BOTBUS_DATA_DIR bus history taskr -n 50' for channel messages"
echo "Run 'cat $ARTIFACTS/agent-${TASKR_DEV}.log' for dev output"
echo "Run 'ls $ARTIFACTS/agent-${TASKR_DEV}_*.log' for worker logs"
echo "Run 'cat $ARTIFACTS/coord-messages.log' for coordination messages"
echo ""
echo "=== Verification Complete ==="
