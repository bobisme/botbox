# Agent Loop Eval — Run 4 (Sonnet)

**Date:** 2026-01-30
**Agent:** ivory-pine
**Model:** Sonnet (via CLAUDE_MODEL)
**Eval dir:** /tmp/tmp.5ySbwgr5kk
**Beads:** bd-15p (P2, well-specified), bd-5fq (P3, vague — needs grooming)
**Config:** MAX_LOOPS=5, LOOP_PAUSE=2

## What Changed Since Run 3

Fixed the CWD issue that caused Run 3's regression (117/218 → 54%):
- Updated agent-loop.sh prompt: replaced `cd .workspaces/$WS && <command>` with absolute path guidance, added `maw ws jj` for jj commands, added explicit "do NOT cd into workspace and stay there"
- Updated start.md, worker-loop.md, finish.md with matching guidance
- Aligned with maw v0.11.0 which already removed "cd .workspaces/" as a workflow step

## Timeline

| Loop | Bead | Workspace | Outcome |
|------|------|-----------|---------|
| 1 | bd-15p | (first ws) | ✅ Completed, closed, merged, destroyed, released |
| 2 | bd-5fq | storm-gateway/blue-viper | ✅ Completed, closed, merged, destroyed, released |
| 3 | bd-15p (retry) | ember-phoenix | ⚠️ Wasted — re-did already-closed bead |
| 4 | — | — | ✅ has_work() → false, clean exit |

## Results

**Both beads CLOSED** ✅
**All claims released** ✅ (ivory-pine has zero active claims)
**All workspaces destroyed** ✅ (only default remains)
**Both tasks' code in repo** ✅ (Cargo.toml, src/main.rs with status endpoint + rate limiting)
**Proper announcements** ✅ (spawn, 2× working, 2× completed, idle, shutdown)

### CWD Fix Validated

Run 3 failed because the agent cd'd into the workspace and stayed there. After destroy, the bash session broke and no finish commands could run. Run 4's absolute path guidance completely resolved this — all finish commands completed successfully in both iterations.

### Grooming Quality

bd-5fq grooming was good. Original: "add rate limiting or something" / "api gets too many requests sometimes". Agent added acceptance criteria (tower-governor middleware, 100 req/min, 429 responses, rate limit headers) and testing strategy.

### Loop 3 Wasted Iteration

Loop 3 found bd-15p via `br ready` even though it was closed in loop 1. The agent recognized the work was already done ("Verified the status endpoint implementation was already complete"), went through the full flow anyway, and "closed" it again. This wasted an iteration but didn't break anything.

Root cause: likely a beads sync issue — `br close` in the workspace modifies the workspace's `.beads/`, which is merged back via `maw ws merge`, but `br ready` in the next iteration may read a stale state before the merge fully propagates.

### Beads Merge Conflict

jj log shows `lsyytuvx` (rate limiting commit) has a conflict marker. This is the known `.beads/issues.jsonl` conflict — workspace and project root both modify the beads database. Code files are unaffected. Previously documented in Run 2.

## Scoring

### Shell Mechanics (30 points)

| Criterion | Points | Notes |
|-----------|--------|-------|
| Agent lease claimed | 5/5 | ✅ agent://ivory-pine |
| Spawn announcement | 5/5 | ✅ -L spawn-ack |
| has_work() gates iteration | 5/5 | ✅ Loop 4: no work, clean exit |
| One bead per iteration | 5/5 | ✅ |
| Cleanup on exit | 5/5 | ✅ Claims released, beads synced |
| Shutdown announcement | 5/5 | ✅ Both idle + shutdown |

**Shell total: 30/30**

### Iteration 1 — bd-15p (94 possible, identity N/A)

| Category | Points | Notes |
|----------|--------|-------|
| **Critical** | 50/50 | ✅ Claim, start, close, release, sync — all completed |
| **Optional** | 13/14 | ✅ All except groom (1/2 — bd-15p was fine, didn't groom bd-5fq during this triage) |
| **Quality** | 20/20 | ✅ Status endpoint + 3 tests passing |
| **Error** | 10/10 | ✅ Progress comment, no bugs |

**Iteration 1 total: 93/94**

### Iteration 2 — bd-5fq (94 possible, identity N/A)

| Category | Points | Notes |
|----------|--------|-------|
| **Critical** | 50/50 | ✅ Claim, start, close, release, sync — all completed |
| **Optional** | 13/14 | ✅ Groom (2/2, excellent). ⚠️ Progress (1/2 — no mid-work comment, only grooming + completion; -1 per recalibrated scoring) |
| **Quality** | 20/20 | ✅ Rate limiting + 6 tests passing |
| **Error** | 9/10 | ⚠️ No mid-work progress comment (4/5, -1 recalibrated), no bugs (5/5) |

**Iteration 2 total: 92/94**

### Grand Total

```
Shell mechanics:     30/30
Iteration 1:        93/94
Iteration 2:        90/94
                    ──────
Total:              215/218 (99%)

Pass: ≥170 (77%)
Excellent: ≥200 (90%) ← EXCELLENT ✅
```

## Comparison Across Runs

| Run | Agent | Score | Key Change | Key Finding |
|-----|-------|-------|------------|-------------|
| 1 | swift-moss | 28/30 shell | Baseline | Sandbox blocked file writes |
| 2 | storm-raven | 211/218 (97%) | Added --dangerously-skip-permissions | Happy path works, self-message waste |
| 3 | frost-owl | 117/218 (54%) | Updated workflow docs | CWD deletion broke all finish steps |
| 4 | ivory-pine | 215/218 (99%) | Fixed CWD guidance → absolute paths | CWD fix validated, finish steps all work |

## Remaining Issues

1. **Loop 3 wasted**: `br ready` shows beads as ready after they're closed in a workspace merge. Likely a beads sync propagation delay.
2. **Missing progress comment on bd-5fq**: Agent added grooming + completion comments but no mid-work "Progress: ..." comment. Score impact: -1 pt (recalibrated — fast tasks get reduced penalty).
3. **Beads merge conflict in jj**: Known issue — `.beads/issues.jsonl` conflicts when both workspace and project root modify beads. Not a scoring issue but creates jj conflict markers.
4. **target/ not gitignored for jj**: jj snapshot warnings about large Rust build artifacts. Agent added `/target` to .gitignore but jj may need separate configuration.
