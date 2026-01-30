# Agent Loop Eval

End-to-end evaluation of `scripts/agent-loop.sh`. Tests both the shell script mechanics and the agent's per-iteration protocol compliance.

## Versions

| Version | Focus | Runs |
|---------|-------|------|
| v1 | Basic agent-loop mechanics | Loop-1, Loop-2 |
| v2 | Fixed CWD guidance (absolute paths) | Loop-3, Loop-4 |
| v3 | Inbox triage + noisy channel handling | — |

## What's Different from Level 2 Evals

Level 2 evals spawn a single agent session and let it run freely. The agent-loop eval tests the **shell script** that drives iteration:

| Concern | Level 2 | Agent Loop |
|---------|---------|------------|
| Who controls iteration? | Agent (internal loop) | Shell script (`for` loop) |
| Beads per invocation | All (agent decides) | Exactly 1 (script enforces) |
| Work check | Agent runs `br ready` | `has_work()` bash function |
| Cleanup on failure | Agent's responsibility | `trap cleanup EXIT` |
| Agent lease | Not tested | `botbus claim agent://$AGENT` |

---

## Setup (v2 — baseline)

```bash
EVAL_DIR=$(mktemp -d)
cd "$EVAL_DIR" && jj git init
botbox init --name botbox-eval --type api --tools beads,maw,crit,botbus,botty --init-beads --no-interactive

# Scaffold the project so agents don't waste time on boilerplate.
# Pick ONE based on the language you want to test:
cargo init --name botbox-eval   # Rust — also adds /target to .gitignore
# npm init -y                   # Node — also add node_modules to .gitignore
# uv init                      # Python

# Seed 2 beads of varying quality
br create --title="Add status endpoint" \
  --description="Create GET /status that returns {\"status\": \"ok\", \"version\": \"1.0.0\"}. Tests: returns 200, valid JSON, has status field." \
  --type=task --priority=2

br create --title="add rate limiting or something" \
  --description="api gets too many requests sometimes" \
  --type=task --priority=3
```

## Setup (v3 — inbox triage)

Extends v2 setup with seeded botbus messages. The agent must triage these during its first iteration.

```bash
# ... v2 setup above ...

# Generate the agent name upfront so we can pre-mark the channel.
AGENT=$(botbus generate-name)

# Mark all existing channel messages as read for this agent.
# This prevents old seeded messages and replies from previous runs
# from bleeding into the new eval. Without this, the agent sees
# duplicate work requests and previous agents' replies, which
# causes false failures (e.g., Loop-7 created a duplicate bead
# because it saw Run 6's identical "rate limiting" request).
botbus mark-read --agent "$AGENT" botbox-eval

# Optionally seed fake channel noise (announcements from old agents).
# These test that the agent ignores informational messages.
botbus send --agent old-fox botbox-eval "Agent old-fox online, starting worker loop" -L mesh -L spawn-ack
botbus send --agent old-fox botbox-eval "Working on bd-abc" -L mesh -L task-claim
botbus send --agent old-fox botbox-eval "Completed bd-abc" -L mesh -L task-done
botbus send --agent old-fox botbox-eval "No work remaining. Agent old-fox signing off." -L mesh -L agent-idle

# Seed botbus messages from a different agent identity.
# These simulate a lead/coordinator giving the agent work and asking questions.

# Task request — agent should create a bead for this
botbus send --agent eval-lead botbox-eval \
  "Please add a health check endpoint that returns uptime and memory usage" \
  -L mesh -L task-request

# Status check — agent should reply, NOT create a bead
botbus send --agent eval-lead botbox-eval \
  "What's the current state of the API? Any endpoints implemented yet?" \
  -L mesh -L status-check

# Feedback from another project — agent should triage the referenced bead
botbus send --agent widget-dev botbox-eval \
  "Filed bd-xxx in widget project: your /status endpoint returns wrong content-type. @botbox-eval" \
  -L feedback

# Duplicate of an existing bead — agent should recognize this and NOT create another
botbus send --agent eval-lead botbox-eval \
  "We need rate limiting on the API, requests are getting out of hand" \
  -L mesh -L task-request
```

### Channel Isolation

The `#botbox-eval` channel accumulates messages across runs. Previous eval runs seed identical work requests and agents reply to them, so a new agent sees duplicate "Please add health check" messages and previous agents' "bd-aik covers this" replies. This caused false failures in Loop-7 (duplicate bead created because the agent couldn't distinguish new requests from old ones).

**Solution:** Pre-mark the channel as read for the new agent before seeding messages. The agent only sees messages sent after the mark-read call. Fake noise (old-fox announcements) is seeded explicitly for controlled testing.

## Execution

```bash
cd "$EVAL_DIR"
MAX_LOOPS=6 LOOP_PAUSE=2 CLAUDE_MODEL=sonnet \
  bash /path/to/botbox/scripts/agent-loop.sh botbox-eval "$AGENT"
```

Observe:
- Does `has_work()` correctly detect the 2 beads?
- Does the agent complete exactly 1 bead per iteration?
- Does the loop iterate again for the second bead?
- Does `has_work()` return false after both beads are closed?
- Does the cleanup trap fire on exit?

v3 additions:
- Does the agent check inbox during triage?
- Does it create a bead for the task request (health check)?
- Does it reply to the status check without creating a bead?
- Does it recognize the rate limiting message as a duplicate of the existing bead?
- Does it handle old messages from previous agents without creating spurious beads?

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

**Optional Steps (2 points each, 14 total per iteration):**
- ~~Generate identity~~ (N/A — provided by script)
- Run triage (`br ready`, `bv --robot-next`)
- Groom beads (fix titles, descriptions, acceptance criteria)
- Create workspace (`maw ws create --random`)
- Work from workspace path (absolute path)
- Post progress updates (at least one; -1 if missing on fast tasks)
- Announce on botbus (`-L mesh`)
- Destroy workspace (`maw ws merge --destroy`)

**Work Quality (20 points per iteration):**
- Task completed (7)
- Tests pass (7)
- Code quality (6)

**Error Handling (10 points per iteration):**
- Progress updates during work (5)
- Bug reporting if applicable (5)

### Inbox Triage (v3 only, 30 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Checked inbox during triage | 5 | Agent ran `botbus inbox --agent $AGENT --all --mark-read` |
| Created bead from task request | 5 | New bead exists for "health check endpoint" |
| Replied to status check | 5 | botbus message replying to eval-lead, no bead created |
| Did not duplicate rate limiting bead | 5 | No new bead for rate limiting (existing bead covers it) |
| Handled old messages gracefully | 5 | No beads created for "Working on" / "Completed" announcements |
| Triaged feedback message | 5 | Agent acknowledged the cross-project feedback (comment or reply) |

### Total Score

**v2 (baseline):**
```
Shell mechanics:           30 points
Iteration 1 protocol:     94 points  (identity N/A)
Iteration 2 protocol:     94 points
                          ───────────
Total:                    218 points possible

Pass threshold:           ≥170 points (77%)
Excellent:                ≥200 points (90%)
```

**v3 (inbox triage):**
```
Shell mechanics:           30 points
Inbox triage:              30 points
Iteration 1 protocol:     94 points
Iteration 2 protocol:     94 points
                          ───────────
Total:                    248 points possible

Pass threshold:           ≥193 points (77%)
Excellent:                ≥223 points (90%)
```

## Verification Methods

### Shell-level checks

```bash
# During run — agent lease exists (filter to recent claims)
botbus claims --agent $AGENT --since 1h | grep "agent://"

# After run — lease released
botbus claims --agent $AGENT --since 1h  # should be empty

# Botbus announcements
botbus inbox --agent eval-checker --channels botbox-eval --all | grep -E "online|signing off|shutting down"

# Beads synced
stat -c "%Y" .beads/issues.jsonl  # should be recent
```

### Per-iteration checks

```bash
br show <bead-id>                     # status, comments
botbus inbox --channels botbox-eval   # Working/Completed messages
maw ws list                           # workspace cleanup
sqlite3 .beads/beads.db "SELECT id, status, closed_at FROM issues;"
```

### Inbox triage checks (v3)

```bash
# New bead created for health check?
br ready | grep -i "health"

# No duplicate bead for rate limiting?
sqlite3 .beads/beads.db "SELECT COUNT(*) FROM issues WHERE title LIKE '%rate%';"
# Expected: 1 (the original, not 2)

# Reply to status check?
botbus inbox --agent eval-lead --channels botbox-eval --all | grep -i "status\|endpoint\|state"

# No beads created for old announcements?
sqlite3 .beads/beads.db "SELECT COUNT(*) FROM issues;"
# Expected: 3 (2 seeded + 1 health check), not 10+
```

### One-bead-per-iteration check

After iteration 1:
```bash
sqlite3 .beads/beads.db "SELECT COUNT(*) FROM issues WHERE status='closed';"
# Expected: 1

br ready
# Expected: 2 remaining (1 seeded + 1 from inbox) or 1 if agent picks inbox bead
```

## Expected Behavior

### v2 happy path (2 beads)

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

### v3 happy path (2 seeded beads + inbox messages)

```
--- Loop 1/5 ---
  has_work() → true (2 ready beads + inbox messages)
  claude -p "..." →
    Triage: reads inbox, creates health check bead, replies to status check,
    recognizes rate limiting duplicate, ignores old announcements.
    Grooms all 3 ready beads. Picks one via bv --robot-next. Completes it, stops.
--- Loop 2/5 ---
  has_work() → true (2 remaining beads)
  claude -p "..." → picks next bead, completes it, stops
--- Loop 3/5 ---
  has_work() → true (1 remaining bead)
  claude -p "..." → picks last bead, completes it, stops
--- Loop 4/5 ---
  has_work() → false
  agent-idle announcement
Cleanup + agent-shutdown
```

## Failure Modes

1. **Agent completes both beads in iteration 1** — "stop after one" instruction didn't work.
2. **Agent doesn't exit after finish** — claude -p hangs, blocking the loop.
3. **has_work() false positive** — Inbox has messages but no actionable beads.
4. **has_work() false negative** — Beads exist but JSON parsing fails silently.
5. **Cleanup doesn't fire** — Agent lease leaked after crash or error.
6. **Workspace left behind** — maw ws merge didn't clean up.
7. **(v3) Bead spam from inbox** — Agent creates beads for every old message in the channel.
8. **(v3) Duplicate bead** — Agent creates a rate limiting bead despite one already existing.
9. **(v3) No inbox check** — Agent skips inbox entirely and goes straight to `br ready`.
10. **(v3) Creates bead for status check** — Agent misclassifies a question as a task request.
