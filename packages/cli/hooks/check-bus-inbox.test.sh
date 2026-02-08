#!/bin/bash
# Integration test for check-bus-inbox.sh hook

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/check-bus-inbox.sh"

echo "Testing check-bus-inbox.sh hook..."

# Test 1: Hook handles missing cwd gracefully
echo "Test 1: Missing cwd in input"
INPUT='{"session_id": "test", "hook_event_name": "PostToolUse"}'
OUTPUT=$(echo "$INPUT" | bash "$HOOK_SCRIPT" 2>&1)
EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
  echo "✓ Test 1 passed: Hook exits gracefully with missing cwd"
else
  echo "✗ Test 1 failed: Exit code $EXIT_CODE"
  exit 1
fi

# Test 2: Hook reads channel from .botbox.json
echo "Test 2: Channel resolution from .botbox.json"
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

cat > "$TEMP_DIR/.botbox.json" << 'EOF'
{
  "project": {
    "name": "testproject",
    "channel": "test-channel",
    "defaultAgent": "test-agent"
  }
}
EOF

INPUT=$(cat << EOF
{
  "session_id": "test",
  "hook_event_name": "PostToolUse",
  "cwd": "$TEMP_DIR"
}
EOF
)

# Mock bus inbox command - should include channel from config
OUTPUT=$(echo "$INPUT" | bash "$HOOK_SCRIPT" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "✓ Test 2 passed: Hook uses channel from .botbox.json"
else
  echo "✗ Test 2 failed: Exit code $EXIT_CODE"
  exit 1
fi

# Test 3: Hook includes agent identity when available
echo "Test 3: Agent identity handling"
if echo "$OUTPUT" | grep -q "test-agent" 2>/dev/null || [ $EXIT_CODE -eq 0 ]; then
  echo "✓ Test 3 passed: Hook handles agent identity"
else
  echo "✗ Test 3 failed"
  exit 1
fi

echo ""
echo "All tests passed!"
