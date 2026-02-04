#!/bin/bash
# botbox PostToolUse hook: check for unread bus messages and inject reminder

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi

BASEDIR=$(basename "$REPO_ROOT")

COUNT=$(bus inbox --count-only --mentions --channels "$BASEDIR" 2>/dev/null)
if [ $? -ne 0 ]; then
  exit 0
fi

if [ "$COUNT" = "0" ]; then
  exit 0
fi

if [ "$COUNT" -gt 0 ]; then
  # Fetch message previews (limit 5, text format for easy parsing)
  MESSAGES=$(bus inbox --mentions --channels "$BASEDIR" --limit-per-channel 5 --format text 2>/dev/null | \
    grep -E '^\[' | \
    sed 's/\[Today [0-9:]*\] //' | \
    sed 's/\[Yesterday [0-9:]*\] //' | \
    sed 's/\[[0-9-]* [0-9:]*\] //' | \
    head -5 | \
    while IFS= read -r line; do
      # Truncate to ~80 chars
      if [ ${#line} -gt 80 ]; then
        echo "  - ${line:0:77}..."
      else
        echo "  - $line"
      fi
    done)

  cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "STOP: You have $COUNT unread botbus message(s) in #$BASEDIR. Check if any need a response:\n$MESSAGES\n\nTo read and respond: \`bus inbox --mentions --channels $BASEDIR --mark-read\`"
  }
}
EOF
fi

exit 0
