# Agent Loop Eval — Run 5 / v3 (Sonnet)

**Date:** 2026-01-30
**Agent:** wild-lion
**Model:** Sonnet (via CLAUDE_MODEL)
**Eval dir:** /tmp/tmp.9xxD8NnEnX
**Eval version:** v3 (inbox triage)
**Beads:** bd-3v7 (P2, well-specified), bd-h87 (P3, vague)
**Inbox messages:** 4 seeded + 13 old from previous runs = 17 total
**Config:** MAX_LOOPS=6, LOOP_PAUSE=2

## Timeline

| Loop | Bead | Workspace | Outcome |
|------|------|-----------|---------|
| 1 | bd-3v7 | fierce-falcon | ✅ Completed, closed, merged, destroyed, released |
| 2 | bd-h87 | bold-cedar | ✅ Completed, groomed, closed, merged, released |
| 3 | — | — | ✅ has_work() → false, clean exit |

## Inbox Triage: Complete Miss

The agent **never checked the botbus inbox**. Both iterations went straight to `br ready` → `bv --robot-next` without running `botbus inbox --agent wild-lion --all --mark-read`.

**Evidence:**
- Only 2 beads in database (seeded ones) — no health check bead created
- No botbus replies from wild-lion to eval-lead or widget-dev
- wild-lion's only botbus messages: spawn-ack, 2× working, 2× completed, idle, shutdown
- 17 inbox messages left completely unread

**What should have happened:**
- Create bead for "health check endpoint" task request
- Reply to "current state of the API?" status check
- Recognize "rate limiting" request as duplicate of bd-h87
- Acknowledge widget-dev's feedback about content-type
- Ignore old frost-owl/ivory-pine announcements

## v2 Protocol: Excellent

The core loop mechanics and per-iteration protocol were strong despite the inbox miss.

## Scoring

### Shell Mechanics: 30/30 ✅

All criteria met: lease, spawn, has_work() gating, one-bead-per-iteration, cleanup, shutdown.

### Inbox Triage: 0/30 ❌

| Criterion | Points | Notes |
|-----------|--------|-------|
| Checked inbox | 0/5 | ❌ Never ran botbus inbox |
| Created health check bead | 0/5 | ❌ No new beads |
| Replied to status check | 0/5 | ❌ No replies |
| No rate limiting duplicate | 5/5 | ✅ Vacuously true — didn't check inbox at all |
| Old messages handled | 5/5 | ✅ Vacuously true — didn't check inbox at all |
| Triaged feedback | 0/5 | ❌ No acknowledgment |

Note: "No duplicate" and "old messages handled" are scored 5/5 because the agent didn't create any spurious beads. However, this is only because it never checked the inbox. If it HAD checked and still didn't create duplicates, that would be meaningful. Scoring 0/30 overall since the entire inbox flow was skipped.

**Inbox total: 0/30**

### Iteration 1 — bd-3v7: 93/94

Same quality as Loop-4. Full critical steps, workspace merged and destroyed, progress comment present.

### Iteration 2 — bd-h87: 92/94

Groomed the vague bead (acceptance criteria, testing strategy). Missing mid-work progress comment (-1 recalibrated).

### Grand Total

```
Shell mechanics:     30/30
Inbox triage:         0/30
Iteration 1:        93/94
Iteration 2:        92/94
                    ──────
Total:              215/248 (87%)

Pass: ≥193 (77%) ← PASS ✅
Excellent: ≥223 (90%) ← MISS (by 8 pts)
```

## Root Cause

The agent-loop.sh prompt includes inbox checking in step 1 (TRIAGE):
```
1. TRIAGE: Check inbox (botbus inbox --agent $AGENT --all --mark-read). Create beads for work
   requests. Check br ready. ...
```

The inbox instruction is buried in the middle of a dense triage paragraph. The agent treated `br ready` and `bv --robot-next` as the core triage path and skipped the inbox entirely.

## Recommended Fix

Make inbox checking a separate, prominent step before the main triage flow. Current prompt mixes inbox + beads + grooming + picking into one step. Split into:
```
1. INBOX: botbus inbox --agent $AGENT --all --mark-read. For work requests, create beads.
   For status checks, reply. For feedback (-L feedback), triage referenced beads.
   Do NOT create beads for old announcements or status messages from other agents.
2. TRIAGE: br ready. Groom. bv --robot-next. Pick one.
```
