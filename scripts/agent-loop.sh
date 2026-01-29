#!/usr/bin/env bash
set -euo pipefail

# --- Configuration ---
MAX_LOOPS=${MAX_LOOPS:-20}
LOOP_PAUSE=${LOOP_PAUSE:-5}

# --- Arguments ---
PROJECT="${1:?Usage: agent-loop.sh <project> [agent-name]}"
AGENT="${2:-$(botbus generate-name)}"

echo "Agent:     $AGENT"
echo "Project:   $PROJECT"
echo "Max loops: $MAX_LOOPS"

# --- Claim the agent lease ---
if ! botbus claim --agent "$AGENT" "agent://$AGENT" -m "worker-loop for $PROJECT"; then
	echo "Claim denied. Agent $AGENT is already running."
	exit 0
fi

# --- Cleanup on exit ---
cleanup() {
	botbus release --agent "$AGENT" "agent://$AGENT" >/dev/null 2>&1 || true
	botbus release --agent "$AGENT" --all >/dev/null 2>&1 || true
	br sync --flush-only >/dev/null 2>&1 || true
	echo "Cleanup complete for $AGENT."
}

trap cleanup EXIT

# --- Announce ---
botbus send --agent "$AGENT" "$PROJECT" "Agent $AGENT online, starting worker loop" \
	-L mesh -L spawn-ack

# --- Python check ---
PYTHON_BIN=${PYTHON_BIN:-python3}
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
	PYTHON_BIN=python
fi
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
	echo "python is required for parsing JSON output."
	exit 1
fi

# --- Helper: check if there is work ---
has_work() {
	local inbox_count ready_count

	inbox_count=$(botbus inbox --agent "$AGENT" --all --count-only --format json 2>/dev/null \
		| "$PYTHON_BIN" -c \
			'import json,sys; d=json.load(sys.stdin); print(sum(c.get("unread",0) for c in d.get("channels",[])))' \
		2>/dev/null || echo "0")

	ready_count=$(br ready --json 2>/dev/null \
		| "$PYTHON_BIN" -c \
			'import json,sys; d=json.load(sys.stdin); print(len(d.get("issues",d.get("beads",[]))))' \
		2>/dev/null || echo "0")

	if [[ "$inbox_count" -gt 0 ]] || [[ "$ready_count" -gt 0 ]]; then
		return 0
	fi
	return 1
}

# --- Main loop ---
for ((i = 1; i <= MAX_LOOPS; i++)); do
	echo "--- Loop $i/$MAX_LOOPS ---"

	if ! has_work; then
		echo "No work available. Exiting cleanly."
		botbus send --agent "$AGENT" "$PROJECT" \
			"No work remaining. Agent $AGENT signing off." \
			-L mesh -L agent-idle
		break
	fi

	claude -p "$(
		cat <<EOF
You are worker agent "$AGENT" for project "$PROJECT".

IMPORTANT: Use --agent $AGENT on ALL botbus and crit commands. Set BOTBOX_PROJECT=$PROJECT.

Execute ONE cycle of the worker loop:

1. TRIAGE: Check inbox (botbus inbox --agent $AGENT --all --mark-read). Create beads for work
   requests. Check br ready. If nothing, say "NO_WORK_AVAILABLE" and stop.
   GROOM each ready bead (br show <id>): ensure clear title, description with acceptance criteria
   and testing strategy, appropriate priority. Fix anything missing, comment what you changed.
   Use bv --robot-next to pick exactly one small task. If the task is large, break it down with
   br create + br dep add, then bv --robot-next again. If a bead is claimed
   (botbus check-claim --agent $AGENT "bead://$PROJECT/<id>"), skip it.

2. START: br update <id> --status=in_progress.
   botbus claim --agent $AGENT "bead://$PROJECT/<id>" -m "<id>".
   Create workspace: WS=\$(maw ws create --random) — capture the workspace name.
   IMPORTANT: All files you create or edit must be under .workspaces/\$WS/.
   For bash commands: cd .workspaces/\$WS && <command>.
   botbus claim --agent $AGENT "workspace://$PROJECT/\$WS" -m "<id>".
   Announce: botbus send --agent $AGENT $PROJECT "Working on <id>" -L mesh -L task-claim.

3. WORK: br show <id>, then implement the task in the workspace.
   Add at least one progress comment: br comments add <id> "Progress: ...".

4. STUCK CHECK: If same approach tried twice, info missing, or tool fails repeatedly — you are
   stuck. br comments add <id> "Blocked: <details>".
   botbus send --agent $AGENT $PROJECT "Stuck on <id>: <reason>" -L mesh -L task-blocked.
   br update <id> --status=blocked.
   Release: botbus release --agent $AGENT "bead://$PROJECT/<id>".
   Stop this cycle.

5. FINISH (mandatory, never skip):
   br comments add <id> "Completed by $AGENT".
   br close <id> --reason="Completed" --suggest-next.
   maw ws merge \$WS --destroy -f (if conflict, preserve and announce).
   botbus release --agent $AGENT --all.
   br sync --flush-only.
   botbus send --agent $AGENT $PROJECT "Completed <id>" -L mesh -L task-done.

Key rules:
- Exactly one small task per cycle.
- Always finish or release before stopping.
- If claim denied, pick something else.
- All botbus and crit commands use --agent $AGENT.
- All file operations in .workspaces/\$WS/, never in the project root.
EOF
	)"

	sleep "$LOOP_PAUSE"
done

# --- Final sync and shutdown ---
br sync --flush-only 2>/dev/null || true
botbus send --agent "$AGENT" "$PROJECT" \
	"Agent $AGENT shutting down after $i loops." \
	-L mesh -L agent-shutdown
echo "Agent $AGENT finished."
