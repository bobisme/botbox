# Agent Loop Eval — Run 3 (Sonnet)

**Date:** 2026-01-30
**Agent:** frost-owl
**Model:** Sonnet (via CLAUDE_MODEL)
**Eval dir:** /tmp/tmp.ZZ8WeLMBIz
**Beads:** bd-1yk (P2, well-specified), bd-orp (P3, vague — needs grooming)
**Config:** MAX_LOOPS=5, LOOP_PAUSE=2

## What Changed Since Run 2

- Updated 6 workflow docs: identity convention, br-from-root, progress comments, tool-issue reporting, blocked bead re-evaluation
- Fixed templates.mjs managed section: naming convention, workspace claim URI
- Incorporated botbus v0.3.8 (self-message filtering) and maw v0.10.0 (single-workspace merge, agent error output)

## Timeline

| Loop | Bead | Workspace | Outcome |
|------|------|-----------|---------|
| 1 | bd-1yk | silver-viper | Work lost — workspace merged as empty. CWD deleted → finish steps failed |
| 2 | bd-orp | iron-phoenix | Work merged successfully. CWD deleted → finish steps failed |
| 3 | bd-1yk (retry) | shadow-tower | claude -p crashed ("No messages returned"). Script hung |

## Critical Issue: CWD Deletion Breaks Finish

Both loop 1 and loop 2 hit the same failure:

1. Agent `cd`s into `.workspaces/$WS/` to do work
2. Agent runs `maw ws merge $WS --destroy -f` (while CWD is still inside the workspace)
3. Directory deleted → bash session breaks
4. All subsequent commands fail: `botbus release`, `br sync`, `br close`, announcements

**Impact:** Neither bead was closed. All claims leaked. No completion messages sent.

The prompt says "Run br commands from the project root, NOT from .workspaces/WS/" but:
- It doesn't mention maw commands
- It doesn't say **cd back** before finish — the agent interprets it as intent rather than a literal cd instruction
- Claude Code's bash tool maintains CWD state, so once cd'd into workspace, it stays there

## bd-1yk Work Lost

Loop 1's workspace (silver-viper) merged as empty per jj log:
```
vvmrozyw: (empty) wip: silver-viper workspace
kstpptzl: merge: adopt work from silver-viper
```

No `app.py` or `test_app.py` exists in the repo. The agent reported creating files and passing 4 tests, but the jj commit has no diff. Possible causes:
- Files written but not snapshotted by jj before merge/destroy
- Files written to wrong path (project root instead of workspace)
- maw ws merge --destroy didn't snapshot working copy before destroying

## bd-orp Work Preserved

Loop 2's workspace (iron-phoenix) has actual content:
```
rzwsnlvq: feat(api): add rate limiting middleware
xozryzyy: merge: adopt work from iron-phoenix
```

All files exist: `rate_limiter.py`, `test_rate_limiter.py`, `README_RATE_LIMITING.md`, `requirements.txt`. 11 tests, comprehensive implementation.

## Grooming Quality

bd-orp grooming was excellent. Original: "add rate limiting or something" / "api gets too many requests sometimes". Agent added:
- Detailed acceptance criteria (4 bullet points)
- Testing strategy (3 verification approaches)
- Updated title retained (still informal but the description compensates)

## Post-Run State

```
Beads:        Both IN_PROGRESS (neither closed)
Claims:       7 active (agent lease, 2 bead claims, 3 workspace claims, 1 duplicate bead)
Workspaces:   Only default remains (all 3 workspaces merged/destroyed)
Botbus:       4 messages — spawn-ack, 2x "Working on", 1x retry "Working on". No completions.
Files:        rate_limiter.py + tests exist (loop 2). No status endpoint (loop 1 lost).
```

## Scoring

### Shell Mechanics (30 points)

| Criterion | Points | Notes |
|-----------|--------|-------|
| Agent lease claimed | 5/5 | ✅ agent://frost-owl |
| Spawn announcement | 5/5 | ✅ -L spawn-ack |
| has_work() gates iteration | 3/5 | ⚠️ Correct detection, but beads never closed so loop 3 re-tried |
| One bead per iteration | 5/5 | ✅ Each loop attempted exactly one bead |
| Cleanup on exit | 1/5 | ❌ Script hung on loop 3 crash, killed externally. Claims leaked |
| Shutdown announcement | 0/5 | ❌ No idle or shutdown message |

**Shell total: 19/30**

### Iteration 1 — bd-1yk (94 possible, identity N/A)

| Category | Points | Notes |
|----------|--------|-------|
| **Critical** | 20/50 | ✅ Claim (10), ✅ Start (10), ❌ Close (0), ❌ Release (0), ❌ Sync (0) |
| **Optional** | 11/14 | ✅ Triage (2), ⚠️ Groom (1 — bd-1yk was fine, didn't groom bd-orp), ✅ Workspace (2), ✅ Work-from-ws (2), ✅ Progress (2), ✅ Announce (2), ❌ Destroy-clean (0 — workspace destroyed but caused CWD break) |
| **Quality** | 0/20 | ❌ Work lost — no files in repo |
| **Error** | 5/10 | ✅ Progress (5), ❌ Bug report not sent (0) |

**Iteration 1 total: 36/94**

### Iteration 2 — bd-orp (94 possible, identity N/A)

| Category | Points | Notes |
|----------|--------|-------|
| **Critical** | 20/50 | ✅ Claim (10), ✅ Start (10), ❌ Close (0), ❌ Release (0), ❌ Sync (0) |
| **Optional** | 14/14 | ✅ Triage (2), ✅ Groom (2 — excellent), ✅ Workspace (2), ✅ Work-from-ws (2), ✅ Progress (2), ✅ Announce (2), ✅ Destroy (2) |
| **Quality** | 20/20 | ✅ Task complete (7), ✅ Tests pass (7), ✅ Code quality (6) |
| **Error** | 8/10 | ✅ Progress (5), ⚠️ Bug report identified but couldn't send (3) |

**Iteration 2 total: 62/94**

### Grand Total

```
Shell mechanics:     19/30
Iteration 1:        36/94
Iteration 2:        62/94
                    ──────
Total:              117/218 (54%)

Pass: ≥170 (77%)   ← FAIL
Excellent: ≥200 (90%)
```

## Regression from Run 2

Run 2 scored 211/218 (97%). Run 3 scored 117/218 (54%). The 43-point drop is almost entirely due to the **CWD deletion issue** preventing all finish steps in both iterations.

| Factor | Points Lost |
|--------|-------------|
| Neither bead closed (2×10) | -20 |
| Claims not released (2×10) | -20 |
| Beads not synced (2×10) | -20 |
| bd-1yk work lost | -20 |
| No shutdown message | -5 |
| Cleanup incomplete | -4 |
| No bug reports sent | -4 |
| has_work() wasted loop 3 | -2 |
| **Total regression** | **-95** |

## Root Cause

The agent's prompt says:
```
All file operations in .workspaces/WS/, never in the project root.
Run br commands from the project root, NOT from .workspaces/WS/.
```

But it never says **"cd back to the project root before running finish commands"**. The agent cd's into the workspace for work, then runs finish commands (including `maw ws merge --destroy`) from that same CWD. The destroy deletes the directory, breaking the bash session.

## Required Fixes

### 1. Prompt: Explicit cd-to-root before finish
Add to FINISH step:
```
IMPORTANT: cd to the project root BEFORE running any finish commands.
All br, maw, and botbus commands in the finish step must run from the project root.
```

### 2. Prompt: Separate merge from destroy (or cd first)
Split the merge step:
```
cd to project root.
maw ws merge $WS -f (from project root).
maw ws destroy $WS (after successful merge).
```

### 3. Investigate bd-1yk work loss
silver-viper merged as empty. Either:
- jj didn't snapshot before merge/destroy
- Agent wrote files to wrong path
- maw ws merge --destroy doesn't snapshot first

Need to test: does `maw ws merge $WS --destroy` snapshot the working copy?

### 4. Doc: finish.md should mention cd-to-root
The canonical finish doc should explicitly say to return to project root before teardown.
