# Multi-Agent Run 1: Worker + Reviewer

**Date:** 2026-02-01
**Model:** Opus (claude-opus-4-5-20251101)
**Worker:** crystal-anchor (20 loops, agent-loop.sh)
**Reviewers:** phantom-matrix, onyx-raven, bronze-beacon, phantom-tower (reviewer-loop.sh)
**Duration:** ~48 minutes (23:26 - 00:14 UTC)

## Rubric

### Worker Protocol (40 points)

| Criterion | Max | Score | Notes |
|-----------|-----|-------|-------|
| Identity: bus whoami, --agent on all commands | 5 | 5 | Consistent throughout |
| Triage: inbox → groom → bv --robot-next | 5 | 5 | Groomed beads, picked via bv |
| Start: claim bead, create workspace, announce with title | 5 | 5 | All 4 beads properly started |
| Work: implement in workspace, progress comments | 5 | 5 | Good progress comments on all beads |
| Review request: create crit review, announce -L review-request | 5 | 4 | Created reviews, but `crit reviews request` failed silently (missing --reviewers) |
| Resume check: detect LGTM/BLOCKED from previous iteration | 5 | 3 | Worked after mid-run fix; initially used broken `crit inbox` path |
| Finish: merge review, close bead, merge workspace, release claims, sync | 5 | 5 | Clean finish on all 4 beads |
| Announce: task-claim, task-done, review-request labels correct | 5 | 5 | All labels correct |
| **Subtotal** | **40** | **37** | |

### Reviewer Protocol (30 points)

| Criterion | Max | Score | Notes |
|-----------|-----|-------|-------|
| Find open reviews | 5 | 2 | First 2 reviewers couldn't find reviews (crit inbox bug); fixed mid-run |
| Read diff and full source files | 5 | 3 | Read files but repeatedly from project root instead of workspace |
| Comment with severity levels | 5 | 5 | Excellent: HIGH, MEDIUM, LOW, INFO all used correctly |
| Vote: LGTM or BLOCK with reasoning | 5 | 5 | Clear block reasons, specific LGTM confirmations |
| Re-review after author response | 5 | 4 | Re-reviewed multiple times; workspace path confusion caused extra rounds |
| Announce review-done on bus | 5 | 5 | Every review action announced |
| **Subtotal** | **30** | **24** | |

### Coordination (20 points)

| Criterion | Max | Score | Notes |
|-----------|-----|-------|-------|
| Worker stops after review request (doesn't self-merge) | 5 | 5 | Correctly waited for reviewer every time |
| Worker resumes on LGTM from separate iteration | 5 | 4 | Worked, but required multiple iterations due to vote confusion |
| Reviewer spawns, processes, exits cleanly | 5 | 3 | Required manual relaunch 3 times; reviewer exited before reviews arrived |
| No leaked workspaces or claims at end | 5 | 5 | Clean: 0 workspaces, 0 active claims |
| **Subtotal** | **20** | **17** | |

### Tooling/Protocol Readiness (10 points)

| Criterion | Max | Score | Notes |
|-----------|-----|-------|-------|
| No mid-run script fixes needed | 5 | 0 | 3 bugs found and fixed mid-run |
| No manual intervention needed | 5 | 2 | Manual LGTM on cr-rgy9; manual reviewer relaunches |
| **Subtotal** | **10** | **2** | |

## Total: 80/100 (80%)

## Beads Completed

| Bead | Title | Review | Rounds | Result |
|------|-------|--------|--------|--------|
| bd-1y1 | Document label conventions for bead grooming | cr-xvwo | 1 | LGTM, merged |
| bd-ppt | Advanced eval epic (organizational) | none | 0 | Closed (no code) |
| bd-2g4 | Language selection + .gitignore in botbox init | cr-rgy9 | 1 | LGTM (manual), merged |
| bd-1pe | sync --check validates managed section | cr-1d5x | 4 | BLOCKED→BLOCKED→LGTM→BLOCKED→LGTM, merged |

## Protocol Bugs Found

### P0: Reviewer can't find reviews (crit inbox vs crit reviews list)

`crit inbox --agent $AGENT` only shows reviews explicitly assigned via `crit reviews request --reviewers <name>`. Since the worker doesn't assign specific reviewers, the reviewer's inbox is always empty.

**Fix applied:** Reviewer uses `crit reviews list --format json` to find open reviews. Worker drops `crit reviews request` (bus announcement is sufficient).

### P1: Reviewer reads project root instead of workspace

The reviewer repeatedly read source files from the project root (unchanged) instead of the workspace path where the worker's changes exist. The worker had to explain the workspace path 4+ times across thread comments before the reviewer checked the right location.

**Root cause:** The review-loop prompt says "read the full source files changed in the diff" but doesn't emphasize that changes live in `.workspaces/$WS/`, not the project root. The crit diff shows relative paths without workspace prefix.

**Mitigation needed:** review-loop.md and reviewer-loop.sh prompt need explicit "read from workspace path" guidance. The workspace path should be prominent in the review metadata.

### P2: Worker resume-check used crit inbox

Same root cause as P0 — `crit inbox --agent $AGENT` returns nothing for the review author. The worker couldn't find its own review status.

**Fix applied:** Worker reads bead comments to find the review ID (from "Review requested: cr-XXXX" comment), then checks `crit review <id>` directly.

### P3: Reviewer exits before reviews arrive

The reviewer-loop.sh launches, checks for work, finds nothing (worker hasn't submitted a review yet), and exits. Required manual relaunching.

**Future fix:** Either (a) keep the reviewer running with longer polling, (b) use bus message triggers to launch reviewer on-demand, or (c) increase initial wait before first has_work() check.

## Key Observations

1. **Review quality was high.** phantom-tower found real bugs in the --check flag (incomplete validation, read-only contract violation) and properly blocked until fixed. This is exactly what the review protocol should do.

2. **The worker handled BLOCKED reviews well.** It read reviewer comments, made fixes in the workspace, and re-requested review with specific evidence (line numbers, test results). The back-and-forth was productive even when the reviewer was confused about workspace paths.

3. **4 beads in 48 minutes** with full review cycles is reasonable throughput for a first run with mid-flight debugging. Without the protocol bugs, this would have been faster.

4. **The workspace path problem is the top priority fix.** It caused the most wasted iterations (4+ rounds on bd-1pe) and is the main friction point for autonomous operation.

## Post-Run Follow-up

### Feature Requests Filed (2026-02-02)

Filed two feature requests in botcrit project:
- **bd-1ck**: `crit reviews create --workspace <path>` flag to store workspace path in review metadata
- **bd-26k**: `crit reviews list --status open` server-side filter

**Resolution**: Both features already existed!
- `crit reviews list --status=open` has been available since initial release
- Workspace detection auto-implemented in crit v0.10.0 (bd-2r4), bugs fixed in v0.10.1

The workspace detection works by matching the review's `jj_change_id` against `jj workspace list` output and provides `workspace.path` in JSON format. This is better than storing paths (no stale data if workspace renamed/moved).

**Updated docs**: review-loop.md now instructs reviewers to use `crit reviews list --status=open` for discovery and `crit review <id> --format=json` to get `workspace.path` for reading source files.
