#!/usr/bin/env bash
set -euo pipefail

# E10 Verification Script
# Post-run automated checks across both projects, channel history,
# review state, and claim cleanup. Outputs structured PASS/FAIL results.

source "${1:?Usage: e10-verify.sh <path-to-.eval-env>}"

echo "=== E10 Verification ==="
echo "EVAL_DIR=$EVAL_DIR"
echo ""

PASS=0
FAIL=0
WARN=0

check() {
  local label="$1"
  local result="$2"  # 0 = pass, 1 = fail
  if [[ "$result" -eq 0 ]]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

warn() {
  local label="$1"
  echo "WARN: $label"
  WARN=$((WARN + 1))
}

# ============================================================
# Alpha State
# ============================================================
echo "--- Alpha State ---"
cd "$ALPHA_DIR"

# Bead should be closed (br show --format json returns an array)
BEAD_STATUS=$(br show "$BEAD" --format json 2>/dev/null | jq -r '.[0].status // "unknown"' || echo "unknown")
check "Alpha bead $BEAD is closed" "$([ "$BEAD_STATUS" = "closed" ] && echo 0 || echo 1)"

# No ready beads (task is done)
READY_COUNT=$(br ready --format json 2>/dev/null | jq 'length' || echo "0")
if [[ "$READY_COUNT" -gt 0 ]]; then
  warn "Alpha has $READY_COUNT ready beads (may include backlog)"
fi

# Non-default workspaces should be cleaned up (default always exists)
WS_COUNT=$(maw ws list --format json 2>/dev/null | jq '[.[] | select(.is_default == false)] | length' || echo "0")
check "Alpha workspaces cleaned up" "$([ "$WS_COUNT" -eq 0 ] && echo 0 || echo 1)"

# Work claims should be released (agent:// claims may be re-staked by hooks firing on announcements)
CLAIMS=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus claims list --agent "$ALPHA_DEV" 2>/dev/null || true)
# Only count bead:// and workspace:// claims — agent:// claims are managed by hooks, not the agent
WORK_CLAIM_COUNT=$(echo "$CLAIMS" | grep -cE "bead://|workspace://" || true)
check "Alpha-dev work claims released" "$([ "$WORK_CLAIM_COUNT" -eq 0 ] && echo 0 || echo 1)"

# Project should compile
if cargo check 2>/dev/null; then
  check "Alpha cargo check passes" 0
else
  check "Alpha cargo check passes" 1
fi

# /debug endpoint should be removed (critical fail condition)
if grep -q '"/debug"' src/main.rs 2>/dev/null || grep -q "route.*debug" src/main.rs 2>/dev/null; then
  check "CRITICAL: /debug endpoint removed from alpha" 1
else
  check "CRITICAL: /debug endpoint removed from alpha" 0
fi

# api_secret should not be exposed in any route
if grep -q 'api_secret' src/main.rs 2>/dev/null; then
  # api_secret field may still exist in AppState — check if it's in a handler response
  if grep -A5 'async fn' src/main.rs 2>/dev/null | grep -q 'api_secret'; then
    check "CRITICAL: api_secret not exposed in handlers" 1
  else
    check "CRITICAL: api_secret not exposed in handlers" 0
  fi
else
  check "CRITICAL: api_secret not exposed in handlers" 0
fi

# Version should be bumped
ALPHA_VERSION=$(grep '^version' Cargo.toml 2>/dev/null | head -1 | grep -oP '"[^"]*"' | tr -d '"' || echo "unknown")
check "Alpha version bumped (expected 0.2.0, got $ALPHA_VERSION)" "$([ "$ALPHA_VERSION" = "0.2.0" ] && echo 0 || echo 1)"

# jj log should show commits
echo ""
echo "Alpha jj log (last 5):"
jj log --no-graph -n 5 2>/dev/null || echo "(jj log failed)"

echo ""

# ============================================================
# Beta State
# ============================================================
echo "--- Beta State ---"
cd "$BETA_DIR"

# cargo test should pass (including + test)
if cargo test 2>/dev/null; then
  check "Beta cargo test passes" 0
else
  check "Beta cargo test passes" 1
fi

# Check that + is now accepted in validate_email
if grep -q '+' src/lib.rs 2>/dev/null; then
  check "Beta validate_email allows + character" 0
else
  check "Beta validate_email allows + character" 1
fi

# jj log
echo ""
echo "Beta jj log (last 5):"
jj log --no-graph -n 5 2>/dev/null || echo "(jj log failed)"

echo ""

# ============================================================
# Cross-Project Communication
# ============================================================
echo "--- Cross-Project Communication ---"

# Alpha channel should have messages
ALPHA_HISTORY=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history alpha -n 30 2>/dev/null || true)
ALPHA_MSG_COUNT=$(echo "$ALPHA_HISTORY" | grep -c "." || true)
check "Alpha channel has messages" "$([ "$ALPHA_MSG_COUNT" -gt 2 ] && echo 0 || echo 1)"

# Beta channel should have cross-project message from alpha-dev
BETA_HISTORY=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history beta -n 20 2>/dev/null || true)
if echo "$BETA_HISTORY" | grep -qi "alpha-dev\|validate_email\|plus\|subaddress"; then
  check "CRITICAL: Cross-project message from alpha-dev to beta channel" 0
else
  check "CRITICAL: Cross-project message from alpha-dev to beta channel" 1
fi

# Projects registry should have both projects
PROJECTS_HISTORY=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus history projects -n 10 2>/dev/null || true)
if echo "$PROJECTS_HISTORY" | grep -q "alpha" && echo "$PROJECTS_HISTORY" | grep -q "beta"; then
  check "Projects registry has both projects" 0
else
  check "Projects registry has both projects" 1
fi

# Check for review-request label
if echo "$ALPHA_HISTORY" | grep -qi "review-request\|review.*request"; then
  check "Review request message on alpha channel" 0
else
  check "Review request message on alpha channel" 1
fi

# Check for task-done label
if echo "$ALPHA_HISTORY" | grep -qi "task-done\|task.*done\|closed\|released\|v0.2.0"; then
  check "Completion announcement on alpha channel" 0
else
  check "Completion announcement on alpha channel" 1
fi

echo ""

# ============================================================
# Review State
# ============================================================
echo "--- Review State ---"
cd "$ALPHA_DIR"

REVIEWS=$(crit reviews list --all-workspaces --path "$ALPHA_DIR" --format json 2>/dev/null || echo "[]")
if echo "$REVIEWS" | jq -e '.[0]' >/dev/null 2>&1; then
  REVIEW_STATUS=$(echo "$REVIEWS" | jq -r '.[-1].status // "unknown"')
  check "Review exists (status: $REVIEW_STATUS)" 0
  if [[ "$REVIEW_STATUS" = "merged" ]]; then
    check "Review marked as merged" 0
  else
    check "Review marked as merged" 1
  fi
else
  check "Review exists" 1
  check "Review marked as merged" 1
fi

echo ""

# ============================================================
# Hook State
# ============================================================
echo "--- Hook State ---"

HOOKS=$(BOTBUS_DATA_DIR="$BOTBUS_DATA_DIR" bus hooks list 2>/dev/null || true)
if echo "$HOOKS" | grep -q "alpha-security"; then
  check "Alpha-security mention hook registered" 0
else
  check "Alpha-security mention hook registered" 1
fi

echo ""

# ============================================================
# Summary
# ============================================================
echo "=== Verification Summary ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
echo "WARN: $WARN"
echo ""

# Critical fail check
CRITICAL_FAILS=0
# Check critical conditions
if grep -q '"/debug"' "$ALPHA_DIR/src/main.rs" 2>/dev/null; then
  echo "CRITICAL FAIL: /debug endpoint still present after Phase 6"
  CRITICAL_FAILS=$((CRITICAL_FAILS + 1))
fi
if [[ "$WORK_CLAIM_COUNT" -gt 0 ]]; then
  echo "CRITICAL FAIL: Work claims remain unreleased after Phase 8"
  CRITICAL_FAILS=$((CRITICAL_FAILS + 1))
fi
if ! echo "$BETA_HISTORY" | grep -qi "alpha-dev\|validate_email\|plus\|subaddress"; then
  echo "CRITICAL FAIL: No cross-project peer message from alpha-dev"
  CRITICAL_FAILS=$((CRITICAL_FAILS + 1))
fi

if [[ "$CRITICAL_FAILS" -gt 0 ]]; then
  echo ""
  echo "RESULT: CRITICAL FAIL ($CRITICAL_FAILS critical conditions triggered)"
elif [[ "$FAIL" -eq 0 ]]; then
  echo "RESULT: ALL CHECKS PASSED"
else
  echo "RESULT: $FAIL checks failed (review manually)"
fi

echo ""
echo "=== Forensics ==="
echo "EVAL_DIR=$EVAL_DIR"
echo "BOTBUS_DATA_DIR=$BOTBUS_DATA_DIR"
echo "ALPHA_DIR=$ALPHA_DIR"
echo "BETA_DIR=$BETA_DIR"
echo "Run 'bus history <channel>' or 'br show <id>' for details"
echo "Phase artifacts in: $EVAL_DIR/artifacts/"
echo ""
echo "=== Verification Complete ==="
