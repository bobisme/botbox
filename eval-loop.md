# Agent Loop Eval

End-to-end evaluation of `scripts/agent-loop.sh`. Tests both the shell script mechanics and the agent's per-iteration protocol compliance.

## What's Different from Level 2 Evals

Level 2 evals spawn a single agent session and let it run freely. The agent-loop eval tests the **shell script** that drives iteration:

| Concern | Level 2 | Agent Loop |
|---------|---------|------------|
| Who controls iteration? | Agent (internal loop) | Shell script (`for` loop) |
| Beads per invocation | All (agent decides) | Exactly 1 (script enforces) |
| Work check | Agent runs `br ready` | `has_work()` bash function |
| Cleanup on failure | Agent's responsibility | `trap cleanup EXIT` |
| Agent lease | Not tested | `botbus claim agent://$AGENT` |

## Setup

```bash
EVAL_DIR=$(mktemp -d)
cd "$EVAL_DIR" && jj git init
botbox init --name eval-project --type api --tools beads,maw,crit,botbus,botty --init-beads --no-interactive

# Seed 2 beads of varying quality
br create --title="Add status endpoint" \
  --description="Create GET /status that returns {\"status\": \"ok\", \"version\": \"1.0.0\"}. Tests: returns 200, valid JSON, has status field." \
  --type=task --priority=2

br create --title="add rate limiting or something" \
  --description="api gets too many requests sometimes" \
  --type=task --priority=3
```

## Execution

### Option A: Run the actual script

```bash
cd "$EVAL_DIR"
MAX_LOOPS=5 LOOP_PAUSE=2 bash /path/to/botbox/scripts/agent-loop.sh eval-project
```

Observe:
- Does `has_work()` correctly detect the 2 beads?
- Does the agent complete exactly 1 bead per iteration?
- Does the loop iterate again for the second bead?
- Does `has_work()` return false after both beads are closed?
- Does the cleanup trap fire on exit?

### Option B: Simulate per-iteration behavior

If running the full script is impractical (cost, time), simulate its behavior by spawning the agent with the same prompt agent-loop.sh uses, once per bead:

```bash
# Iteration 1
claude -p "<agent-loop prompt with AGENT=test-agent PROJECT=eval-project>"

# Verify: exactly 1 bead closed, agent exited
br ready  # should show 1 remaining

# Iteration 2
claude -p "<same prompt>"

# Verify: second bead closed, agent exited
br ready  # should show 0 remaining
```

## Scoring

### Shell Script Mechanics (30 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Agent lease claimed | 5 | `botbus claims --agent $AGENT` shows `agent://$AGENT` during run |
| Spawn announcement | 5 | botbus message with `-L spawn-ack` |
| `has_work()` gates iteration | 5 | Script doesn't spawn claude when no beads remain |
| One bead per iteration | 5 | Agent stops after completing one task |
| Cleanup on exit | 5 | Agent lease released, claims released, beads synced |
| Shutdown announcement | 5 | botbus message with `-L agent-shutdown` or `-L agent-idle` |

### Per-Iteration Protocol (scored per bead, using Level 2 rubric)

**Critical Steps (10 points each, 50 total per iteration):**
- Claim on botbus
- Start bead (in_progress)
- Finish bead (closed)
- Release claims
- Sync beads

**Optional Steps (2 points each, 16 total per iteration):**
- Generate identity (N/A — provided by script)
- Run triage (`br ready`, `bv --robot-next`)
- Groom beads (fix titles, descriptions, acceptance criteria)
- Create workspace (`maw ws create --random`)
- Work from workspace path (`.workspaces/$WS/`)
- Post progress updates (at least one)
- Announce on botbus (`-L mesh`)
- Destroy workspace (`maw ws merge --destroy`)

**Work Quality (20 points per iteration):**
- Task completed (7)
- Tests pass (7)
- Code quality (6)

**Error Handling (10 points per iteration):**
- Progress updates during work (5)
- Bug reporting if applicable (5)

### Total Score

```
Shell mechanics:           30 points
Iteration 1 protocol:     96 points  (50 critical + 16 optional + 20 quality + 10 error)
Iteration 2 protocol:     96 points
                          ───────────
Total:                    222 points possible

Pass threshold:           ≥170 points (77%)
Excellent:                ≥200 points (90%)
```

Note: Identity generation is scored as N/A (2 points removed per iteration) since agent-loop.sh provides the agent name. Adjusted totals: 218 points possible.

## Verification Methods

### Shell-level checks

```bash
# During run — agent lease exists (filter to recent claims)
botbus claims --agent $AGENT --since 1h | grep "agent://"

# After run — lease released
botbus claims --agent $AGENT --since 1h  # should be empty

# Botbus announcements
botbus inbox --agent eval-checker --channels eval-project --all | grep -E "online|signing off|shutting down"

# Beads synced
stat -c "%Y" .beads/issues.jsonl  # should be recent
```

### Per-iteration checks

Same as Level 2 eval verification:
```bash
br show <bead-id>                     # status, comments
botbus inbox --channels eval-project  # Working/Completed messages
maw ws list                           # workspace cleanup
sqlite3 .beads/beads.db "SELECT id, status, closed_at FROM issues;"
```

### One-bead-per-iteration check

After iteration 1:
```bash
# Exactly 1 bead should be closed
sqlite3 .beads/beads.db "SELECT COUNT(*) FROM issues WHERE status='closed';"
# Expected: 1

# Exactly 1 bead should still be open
br ready
# Expected: 1 remaining bead
```

## Expected Behavior

### Happy path (2 beads)

```
--- Loop 1/5 ---
  has_work() → true (2 ready beads)
  claude -p "..." → agent triages, grooms, picks bead 1, completes it, stops
--- Loop 2/5 ---
  has_work() → true (1 ready bead)
  claude -p "..." → agent triages, grooms, picks bead 2, completes it, stops
--- Loop 3/5 ---
  has_work() → false
  "No work available. Exiting cleanly."
  agent-idle announcement
Cleanup: lease released, claims released, beads synced
agent-shutdown announcement
```

### Failure modes to watch for

1. **Agent completes both beads in iteration 1** — Means the "stop after one" instruction didn't work. Shell loop becomes a no-op.
2. **Agent doesn't exit after finish** — claude -p hangs, blocking the loop.
3. **has_work() false positive** — Inbox has messages but no actionable beads.
4. **has_work() false negative** — Beads exist but JSON parsing fails silently.
5. **Cleanup doesn't fire** — Agent lease leaked after crash or error.
6. **Workspace left behind** — maw ws merge didn't clean up.

## Open Questions

1. **Cost**: Each iteration spawns a fresh claude session. 2 iterations minimum. Consider using Haiku for cost-efficient loop testing.
2. **Timing**: `LOOP_PAUSE=2` between iterations. Enough for beads to sync?
3. **Model flag**: agent-loop.sh doesn't pass `--model` to claude. Should it? Default model may not be ideal for all deployments.
