# Agent Loop Eval — Run 10 / v2.1 (Haiku)

**Date:** 2026-01-30
**Agent:** lunar-portal
**Model:** Haiku (via CLAUDE_MODEL)
**Eval dir:** /tmp/tmp.Nlnpa4C8fu
**Eval version:** v2.1 (no inbox triage, with br sync + channel pre-mark)
**Beads:** bd-cy0 (P2, well-specified), bd-iyz (P3, vague)
**Inbox messages:** 0 (channel pre-marked as read)
**Config:** MAX_LOOPS=6, LOOP_PAUSE=2

## What Changed Since Run 9

Stripped inbox triage entirely — no seeded botbus messages. The agent only needs to handle beads. This tests whether Haiku can reliably execute the core protocol (triage → start → work → finish) without the inbox complexity that caused failures in Runs 8 and 9.

Also includes `br sync` between iterations (from Run 9).

## Timeline

| Loop | Bead | Workspace | Outcome |
|------|------|-----------|---------
| 1 | bd-cy0 | electric-river | ✅ Completed (status endpoint with 2 tests), closed, merged, released |
| 2 | bd-iyz | cosmic-lynx | ✅ Groomed, completed (rate limiting with governor crate, 4 tests), closed, merged, released |
| 3 | — | — | ✅ has_work() → false, clean exit |

**Perfect loop behavior** — 2 beads, 2 iterations, clean exit on 3rd.

## Notable Behavior

- **Excellent grooming**: Transformed "add rate limiting or something" / "api gets too many requests sometimes" into proper acceptance criteria with testing strategy. Description updated inline (not just a comment).
- **Tests written**: Both iterations included tests — 2 for status endpoint, 2 for rate limiting (4 total). This is a notable improvement over Runs 8-9 where Haiku wrote no tests.
- **Proper labels**: All botbus messages have correct `-L mesh -L task-claim` / `-L task-done` labels.
- **Clean `br sync` worked**: "JSONL is current" appears between iterations, confirming the sync ran. No stale `br ready` — has_work() correctly returned false on Loop 3.
- **Missing progress comments**: Only "Completed by lunar-portal" comments — no mid-work progress updates. Same pattern as previous Haiku runs.
- **No spurious beads**: Bead count stayed at 2 (seeded).

## Scoring

### Shell Mechanics: 30/30 ✅

| Criterion | Points | Notes |
|-----------|--------|-------|
| Agent lease claimed | 5/5 | ✅ |
| Spawn announcement | 5/5 | ✅ |
| has_work() gates iteration | 5/5 | ✅ Loop 3: "No work available. Exiting cleanly." |
| One bead per iteration | 5/5 | ✅ |
| Cleanup on exit | 5/5 | ✅ Claims released, synced |
| Shutdown announcement | 5/5 | ✅ agent-idle + agent-shutdown |

### Iteration 1 — bd-cy0: 86/94

| Category | Points | Notes |
|----------|--------|-------|
| **Critical** | 50/50 | ✅ All steps |
| **Optional** | 10/14 | ✅ Workspace (2/2), announce (2/2), destroy (2/2). ⚠️ No groom comment (-2). Progress (-1, only completion comment). Triage (2/2, used bv). |
| **Quality** | 20/20 | ✅ Endpoint works, 2 tests pass |
| **Error** | 6/10 | ⚠️ No mid-work progress comment (-4) |

### Iteration 2 — bd-iyz: 90/94

| Category | Points | Notes |
|----------|--------|-------|
| **Critical** | 50/50 | ✅ All steps |
| **Optional** | 12/14 | ✅ Groom (2/2, excellent — rewrote description + AC + testing). Workspace (2/2), announce (2/2), destroy (2/2). Triage (2/2). ⚠️ Progress (-1, only completion comment). |
| **Quality** | 20/20 | ✅ Rate limiting with governor, 4 tests pass |
| **Error** | 8/10 | ⚠️ No mid-work progress comment (-2, recalibrated — task completed quickly) |

### Grand Total

```
Shell mechanics:     30/30
Iteration 1 (cy0):  86/94
Iteration 2 (iyz):  90/94
                    ──────
Total:              206/218 (94%)

Pass: ≥170 (77%) ← PASS ✅
Excellent: ≥200 (90%) ← EXCELLENT ✅
```

## Comparison

| Run | Version | Model | Agent | Score | Total | Key Finding |
|-----|---------|-------|-------|-------|-------|-------------|
| 2 | v1 | Sonnet | — | 211/218 (97%) | 218 | v1 baseline |
| 4 | v2 | Sonnet | ivory-pine | 215/218 (99%) | 218 | CWD fix validated |
| 6 | v3 | Sonnet | violet-lynx | 245/248 (99%) | 248 | Inbox perfect |
| 7 | v3 | Sonnet | true-matrix | 232/248 (94%) | 248 | Duplicate bead |
| 8 | v3 | Haiku | green-circuit | 205/248 (83%) | 248 | No inbox replies |
| 9 | v3 | Haiku | azure-heron | 65/248 (26%) | 248 | **FAIL** |
| **10** | **v2.1** | **Haiku** | **lunar-portal** | **206/218 (94%)** | **218** | **Clean run, tests, grooming** |

## Key Findings

1. **Haiku is excellent at core protocol**: When inbox triage is removed, Haiku scores 94% — matching Sonnet's lower bound and well above the Excellent threshold.

2. **br sync fix confirmed**: No stale `br ready` issues. has_work() correctly detected no work on Loop 3. This fix is validated.

3. **Haiku writes tests when not overwhelmed**: Both iterations included tests (4 total). Runs 8-9 had no tests. The reduced cognitive load from no inbox processing freed capacity for quality work.

4. **Missing progress comments is Haiku's consistent gap**: All three Haiku runs lack mid-work progress updates. This is likely a capacity tradeoff — Haiku prioritizes implementation over process compliance.

5. **Recommendation**: Use Haiku for v2.1 workloads (pre-triaged beads, no inbox). Use Sonnet for v3 workloads (full inbox triage + beads). A coordinator (Sonnet) triaging inbox and grooming beads, with Haiku workers executing, would be the optimal architecture.
