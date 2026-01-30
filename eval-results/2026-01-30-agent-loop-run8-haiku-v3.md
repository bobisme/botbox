# Agent Loop Eval — Run 8 / v3 (Haiku)

**Date:** 2026-01-30
**Agent:** green-circuit
**Model:** Haiku (via CLAUDE_MODEL)
**Eval dir:** /tmp/tmp.a4bLn0ocev
**Eval version:** v3 (inbox triage, with channel pre-mark fix)
**Beads:** bd-1m0 (P2, well-specified), bd-1ct (P3, vague)
**Inbox messages:** 4 noise (old-fox) + 4 seeded work requests = 8 total
**Config:** MAX_LOOPS=6, LOOP_PAUSE=2

## What Changed Since Run 7

Pre-marked the channel as read before seeding messages. The agent only sees 8 messages (4 fake noise + 4 work requests) instead of 50+ accumulated from previous runs. This eliminates confusion from duplicate work requests and previous agents' replies.

## Timeline

| Loop | Bead | Workspace | Outcome |
|------|------|-----------|---------
| 1 | bd-1m0 | frozen-phoenix | ✅ Completed (status endpoint), closed, merged, released |
| 2 | bd-la7 (new) | cosmic-crane | ✅ Created from inbox, completed (health check), closed, merged |
| 3 | bd-dc4 (new) | ? | ⚠️ Created duplicate rate limiting bead from inbox, completed it |
| 4 | bd-1ct | mystic-raven | ⚠️ Found rate limiting already implemented, closed as resolved |
| 5 | bd-1ct | mystic-oracle | ⚠️ Re-found bd-1ct, re-implemented with per-IP rate limiting |
| 6 | bd-1m0 | — | ⚠️ Re-found bd-1m0 as open, verified and closed |

**No clean exit** — used all 6 loops. No `has_work() → false` triggered.

## Inbox Triage: Partial (15/30)

| Message | Type | Expected Action | Actual | Score |
|---------|------|-----------------|--------|-------|
| "Please add health check endpoint with uptime and memory" | task-request | Create bead or merge into existing | ✅ Created bd-la7 | 5/5 |
| "What's the current state of the API?" | status-check | Reply, no bead | ❌ No reply sent on botbus | 0/5 |
| "Filed bd-xxx: wrong content-type" | feedback | Acknowledge, note for implementation | ❌ No reply or acknowledgment visible | 0/5 |
| "We need rate limiting" | task-request (dup) | Recognize as duplicate of bd-1ct | ❌ Created bd-dc4 (duplicate bead) | 0/5 |
| 4 old-fox announcements | announcements | Ignore, no beads | ✅ No spurious beads | 5/5 |
| Checked inbox at all | — | Run botbus inbox | ✅ "Reviewed inbox messages" | 5/5 |

**Inbox total: 15/30**

## Notable Behavior

- **Duplicate rate limiting bead**: Created bd-dc4 from inbox despite bd-1ct already covering rate limiting. Same failure as Sonnet Run 7.
- **bd-1ct worked 3 times**: Loop 4 closed it as "already implemented", Loop 5 re-found it and added per-IP rate limiting. Stale `br ready` is a persistent issue.
- **bd-1m0 re-appeared in Loop 6**: Despite being closed in Loop 1, it showed up as a ready bead in Loop 6. Agent verified and re-closed it. This is the stale state issue again.
- **No inbox replies**: Unlike Sonnet which replied to status checks and acknowledged feedback, Haiku sent zero inbox replies. It only created beads and processed tasks.
- **No has_work() exit**: All 6 loops ran. Stale `br ready` kept returning beads that were already closed, preventing clean termination.
- **Missing -L labels on some announcements**: Some botbus messages lacked `-L mesh -L task-claim` labels (e.g., "Working on bd-dc4" had no labels).
- **Good grooming**: bd-1ct got a detailed grooming comment explaining what rate limiting means and what the acceptance criteria should be.

## Scoring

### Shell Mechanics: 20/30

| Criterion | Points | Notes |
|-----------|--------|-------|
| Agent lease claimed | 5/5 | ✅ |
| Spawn announcement | 5/5 | ✅ |
| has_work() gates iteration | 0/5 | ❌ Never triggered — all 6 loops ran |
| One bead per iteration | 5/5 | ✅ One bead per loop |
| Cleanup on exit | 5/5 | ✅ Claims released, synced |
| Shutdown announcement | 0/5 | ⚠️ Got agent-shutdown but no agent-idle (never detected no work) |

### Inbox Triage: 15/30

See table above.

### Iteration 1 — bd-1m0: 82/94

| Category | Points | Notes |
|----------|--------|-------|
| **Critical** | 50/50 | ✅ All steps |
| **Optional** | 8/14 | ⚠️ No explicit groom comment for bd-1m0. Progress comment present but out-of-order (appears after "Verified" comment in DB). Workspace and announce OK. |
| **Quality** | 17/20 | ✅ Status endpoint works, compiles. No tests written (-3). |
| **Error** | 7/10 | ⚠️ No test verification |

### Iteration 2 — bd-la7: 88/94

| Category | Points | Notes |
|----------|--------|-------|
| **Critical** | 50/50 | ✅ All steps |
| **Optional** | 12/14 | ✅ Progress (2/2), workspace (2/2), announce (2/2), groom (2/2). Triage (2/2). ⚠️ Progress recalibrated (-1). |
| **Quality** | 18/20 | ✅ Health check with uptime + memory. No tests (-2). |
| **Error** | 8/10 | ⚠️ No test suite |

### Grand Total

Scoring best 2 iterations (1 and 2) against v3 framework:

```
Shell mechanics:     20/30
Inbox triage:        15/30
Iteration 1 (1m0):  82/94
Iteration 2 (la7):  88/94
                    ──────
Total:              205/248 (83%)

Pass: ≥193 (77%) ← PASS ✅
Excellent: ≥223 (90%) ← NOT MET
```

## Comparison

| Run | Version | Model | Agent | Score | Total | Key Finding |
|-----|---------|-------|-------|-------|-------|-------------|
| 6 | v3 | Sonnet | violet-lynx | 245/248 (99%) | 248 | Inbox perfect after prompt split |
| 7 | v3 | Sonnet | true-matrix | 232/248 (94%) | 248 | Duplicate bead, 4 iterations |
| 8 | v3 | Haiku | green-circuit | 205/248 (83%) | 248 | Duplicate bead, no inbox replies, stale br ready, 6 iterations |

## Key Findings

1. **Haiku passes but doesn't reach Excellent**: 83% vs Sonnet's 94-99%. The gap is in inbox handling (no replies, duplicate beads) and stale state recovery.

2. **No inbox replies at all**: Haiku processed inbox and created beads, but never sent a single reply to status checks or feedback. Sonnet consistently replies. This may be a capacity issue — Haiku focuses on the primary task and skips "optional" social responses.

3. **Stale `br ready` is worse with Haiku**: Both bd-1m0 and bd-1ct appeared as open beads in later loops despite being closed. This caused 6 loops instead of 3-4. The stale state issue may need a tool-level fix (e.g., `br ready --refresh` or explicit cache invalidation after merge).

4. **No tests written**: Neither iteration included tests, whereas Sonnet consistently adds tests. This affects quality scores.

5. **Missing botbus labels**: Some messages lacked the required `-L mesh -L task-claim` labels, suggesting Haiku doesn't follow the label convention as consistently.

6. **Duplicate detection remains the hardest v3 criterion**: Both Sonnet and Haiku fail to consistently recognize that an inbox work request duplicates an existing bead. This may need stronger prompt language or a different approach (e.g., requiring the agent to `br ready` before creating beads from inbox).
