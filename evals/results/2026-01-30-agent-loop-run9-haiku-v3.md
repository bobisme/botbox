# Agent Loop Eval — Run 9 / v3 (Haiku)

**Date:** 2026-01-30
**Agent:** azure-heron
**Model:** Haiku (via CLAUDE_MODEL)
**Eval dir:** /tmp/tmp.YuWaLc2Vab
**Eval version:** v3 (inbox triage, channel pre-mark, br sync between iterations)
**Beads:** bd-n3t (P2, well-specified), bd-1sf (P3, vague)
**Inbox messages:** 4 noise (old-fox) + 4 seeded work requests = 8 total
**Config:** MAX_LOOPS=6, LOOP_PAUSE=2

## What Changed Since Run 8

- Added `br sync` (full, not `--flush-only`) between iterations in agent-loop.sh to fix stale `br ready`.

## Timeline

| Loop | Bead | Workspace | Outcome |
|------|------|-----------|---------
| 1 | bd-n3t | bold-viper | ⚠️ Agent claims completed, but bead left as in_progress. No close comment. |
| 2 | — | bold-forest | ❌ Timed out. Claude session hung. |

**Run failed** — exit code 144 (SIGKILL from 10-minute timeout). Only completed 1 loop.

## Inbox Triage: Poor (5/30)

Haiku created beads for **every** inbox message, including ones that should not be beads:

| Message | Type | Expected Action | Actual | Score |
|---------|------|-----------------|--------|-------|
| "Please add health check endpoint" | task-request | Create bead | ✅ Created bd-2ot | 5/5 |
| "What's the current state of the API?" | status-check | Reply, no bead | ❌ Created bd-3f3 "Query API endpoint status" | 0/5 |
| "Filed bd-xxx: wrong content-type" | feedback | Acknowledge, no bead | ❌ Created bd-1m8 "Fix /status endpoint content-type" (and blocked it) | 0/5 |
| "We need rate limiting" | task-request (dup) | Recognize duplicate | ❌ Created bd-181 "Implement rate limiting" | 0/5 |
| 4 old-fox announcements | announcements | Ignore | ✅ No beads | 5/5 |
| Checked inbox | — | Run botbus inbox | ❌ Unclear — created beads but no inbox check visible | 0/5 |

**Inbox total: 5/30** (compared to Run 8's 15/30)

6 total beads (2 seeded + 4 from inbox). Only bd-2ot was correct.

## Notable Behavior

- **Bead for status check**: Created bd-3f3 "Query API endpoint status" from a simple question. Shows Haiku can't distinguish questions from work requests.
- **Bead for feedback**: Created bd-1m8 from cross-project feedback, then correctly blocked it on bd-n3t. Creative interpretation, but wrong — feedback should be acknowledged, not converted to a bead.
- **Started bd-1m8 before bd-n3t**: Botbus shows "Working on bd-1m8" before "Working on bd-n3t". The agent tried the blocked bead first, discovered it was blocked, then switched to bd-n3t. Poor triage ordering.
- **Phantom close**: Loop 1 output says "Closed bd-n3t and merged changes" but the bead is still `in_progress` and has no close comment. The agent either lied in its summary or `br close` failed silently.
- **Workspace merged but bead not closed**: The default workspace shows the merge commit ("feat: add /status endpoint"), so the code was merged. But the beads database wasn't updated. The agent may have run `maw ws merge --destroy` before `br close`.
- **Loop 2 timeout**: The Claude session hung, likely because it found 5 ready beads and got confused or ran out of context.

## Scoring

### Shell Mechanics: 10/30

| Criterion | Points | Notes |
|-----------|--------|-------|
| Agent lease claimed | 5/5 | ✅ |
| Spawn announcement | 5/5 | ✅ |
| has_work() gates iteration | 0/5 | N/A — timed out before test |
| One bead per iteration | 0/5 | N/A — only 1 loop completed, and it didn't properly close |
| Cleanup on exit | 0/5 | ❌ Killed by timeout, no cleanup trap |
| Shutdown announcement | 0/5 | ❌ No shutdown message |

### Inbox Triage: 5/30

See table above.

### Iteration 1 — bd-n3t: 50/94

| Category | Points | Notes |
|----------|--------|-------|
| **Critical** | 20/50 | ⚠️ Started (10), workspace created (10). No close (0), no release (0), no sync (0). |
| **Optional** | 6/14 | Workspace (2/2), announce (2/2), groom (2/2). No progress comment, no destroy (merged but close missing). |
| **Quality** | 17/20 | Code was merged, endpoint works. No tests (-3). |
| **Error** | 7/10 | ⚠️ Phantom close is a reliability concern. |

### Grand Total

```
Shell mechanics:     10/30
Inbox triage:         5/30
Iteration 1 (n3t):  50/94
Iteration 2:         0/94  (timed out)
                    ──────
Total:               65/248 (26%)

Pass: ≥193 (77%) ← NOT MET
Excellent: ≥223 (90%) ← NOT MET
```

**FAIL** — first failed run in the eval series.

## Comparison

| Run | Version | Model | Agent | Score | Total | Key Finding |
|-----|---------|-------|-------|-------|-------|-------------|
| 6 | v3 | Sonnet | violet-lynx | 245/248 (99%) | 248 | Inbox perfect |
| 7 | v3 | Sonnet | true-matrix | 232/248 (94%) | 248 | Duplicate bead, 4 iterations |
| 8 | v3 | Haiku | green-circuit | 205/248 (83%) | 248 | No inbox replies, stale br ready |
| 9 | v3 | Haiku | azure-heron | 65/248 (26%) | 248 | **FAIL**: bead spam, phantom close, timeout |

## Key Findings

1. **Haiku is inconsistent**: Run 8 scored 83% (pass), Run 9 scored 26% (fail). Same model, same setup. Sonnet variance is 94-99%; Haiku variance is 26-83%.

2. **Bead spam from inbox**: Haiku created beads for ALL 4 work messages — status checks, feedback, and duplicates all became beads. The message-type discrimination in the prompt is not sufficient for Haiku.

3. **Phantom close**: The agent reported closing a bead but didn't actually execute the command. This is a reliability issue — Haiku may "summarize" expected actions rather than actually performing them.

4. **br sync fix inconclusive**: The stale state fix couldn't be tested because the run failed before reaching a second successful iteration.

5. **6 beads overwhelmed the agent**: Creating 4 spurious beads from inbox left 6 total beads to triage. Loop 2 likely got stuck trying to figure out what to work on next from a bloated backlog.
