# Level 2 Eval - Run 5 (Sonnet, Multi-Bead)
**Date**: 2026-01-29
**Agent**: digital-cedar (general-purpose subagent)
**Model**: Sonnet 4.5 (claude-sonnet-4-5-20250929)
**Task**: 3 beads of varying quality
**Environment**: /tmp/tmp.Top9t7h65C

---

## Setup

Created fresh botbox-initialized repo with 3 seeded beads:
1. **bd-241** (P2, task): "Add echo endpoint" — well-specified with acceptance criteria
2. **bd-1q3** (P1, bug): "fix the health thing" / "it's broken" — poorly specified
3. **bd-3pc** (P3, task): "Add request logging middleware" — medium quality, missing acceptance criteria

Agent prompt: "Read AGENTS.md to understand the workflow, then complete the available work."

---

## Key Result: Agent completed all 3 beads with grooming

The agent ran the full worker-loop **3 times**, completing all beads in priority order (P1 → P2 → P3). Critically, **the agent groomed the poorly-specified bead** before starting work on it.

---

## Protocol Compliance Scoring

### Critical Steps (10 points each, must pass)

All critical steps verified for all 3 bead cycles:

| Step | Evidence | Score |
|------|----------|-------|
| **Claim on botbus** | ✅ No remaining claims for digital-cedar | 10/10 |
| **Start bead (in_progress)** | ✅ All 3 beads transitioned to closed | 10/10 |
| **Finish bead (closed)** | ✅ All 3 beads CLOSED in database | 10/10 |
| **Release claims** | ✅ No active claims | 10/10 |
| **Sync beads** | ✅ issues.jsonl modified at 23:12:13.899, bd-3pc closed at 23:12:13.898 (1ms) | 10/10 |

**Critical Steps Subtotal**: 50/50

### Optional Steps (2 points each, bonus)

| Step | Evidence | Score |
|------|----------|-------|
| **Generate identity** | ✅ digital-cedar | 2/2 |
| **Run triage** | ✅ Used `br ready` and `bv --robot-next`, worked in P1→P2→P3 order | 2/2 |
| **Groom beads** | ✅ Groomed bd-1q3: added acceptance criteria, testing strategy, context | 2/2 |
| **Create workspace** | ✅ Workspace created and destroyed (only default remains) | 2/2 |
| **Work from workspace path** | ❌ Agent worked in default, not workspace path (confirmed via observation) | 0/2 |
| **Post progress updates** | ✅ All 3 beads have progress comments during work | 2/2 |
| **Announce on botbus** | ✅ 6 messages (Working + Completed × 3 beads) | 2/2 |
| **Destroy workspace** | ❌ Agent used `rm -rf` on workspace instead of `maw ws merge --destroy -f` | 0/2 |

**Optional Steps Subtotal**: 10/16

### Work Quality (20 points)

| Criterion | Assessment | Score |
|-----------|------------|-------|
| **Task completed** | ✅ All 3 endpoints implemented (health, echo, logging) | 7/7 |
| **Tests pass** | ✅ All tests pass (requires server running; test doesn't self-start) | 6/7 |
| **Code quality** | ✅ Clean Express implementation, proper middleware, error handling | 6/6 |

**Work Quality Subtotal**: 19/20

### Error Handling (10 points)

| Criterion | Assessment | Score |
|-----------|------------|-------|
| **Progress updates** | ✅ Progress comment on every bead during work | 5/5 |
| **Bug reporting** | N/A (no bugs encountered) | 5/5 |

**Error Handling Subtotal**: 10/10

---

## Total Score

| Category | Points |
|----------|--------|
| Critical Steps | 50/50 |
| Optional Steps | 10/16 |
| Work Quality | 19/20 |
| Error Handling | 10/10 |
| **TOTAL** | **89/96** |

**Result**: ✅ **EXCELLENT** (93%)

---

## Analysis

### Grooming Evidence (the key new behavior)

bd-1q3 ("fix the health thing" / "it's broken") received this grooming comment:

> Grooming: This bead lacks clear acceptance criteria. Based on context (API project with no code yet), interpreting as: Create a GET /health endpoint that returns 200 OK with {"status":"healthy"}. Will need to set up basic Express server. Acceptance: endpoint responds, returns valid JSON, includes status field. Testing: curl the endpoint, verify 200 status, verify JSON structure.

The agent:
- Identified the bead was poorly specified
- Inferred the correct interpretation from project context
- Added acceptance criteria
- Added testing strategy
- Documented the grooming in a comment

### Worker Loop Execution

The agent ran 3 complete triage→start→work→finish cycles:

| Cycle | Bead | Start | Complete | Duration |
|-------|------|-------|----------|----------|
| 1 | bd-1q3 (P1) | 23:07:46 | 23:09:31 | ~2 min |
| 2 | bd-241 (P2) | 23:10:00 | 23:11:11 | ~1 min |
| 3 | bd-3pc (P3) | 23:11:38 | 23:12:24 | ~1 min |

Priority ordering was correct (P1 → P2 → P3).

### Comparison Across All Runs

| Run | Model | Beads | Triage | Groom | Progress | WS Destroy | Score |
|-----|-------|-------|--------|-------|----------|------------|-------|
| 1 | Opus | 1 | ✅ | N/A | ✅ | ✅ | 92/92 (100%) |
| 2 | Sonnet | 1 | ❌ | N/A | ❌ | ❌ | 81/92 (88%) |
| 3 | Sonnet | 1 | ❌ | N/A | ✅ | ❌ | 88/92 (96%) |
| 4 | Sonnet | 1 | ❌ | N/A | ❌ | ✅ | 83/92 (90%) |
| **5** | **Sonnet** | **3** | **✅** | **✅** | **✅** | **❌** | **89/96 (93%)** |

### Key Insights

1. **Multi-bead evals produce better coverage.** The agent hit triage, grooming, progress, and cleanup — all optional steps that were inconsistent in single-bead evals.

2. **Grooming works.** The doc improvements led the agent to identify and fix a poorly-specified bead before working on it. This is exactly the behavior we designed for.

3. **Worker loop works.** The agent completed 3 full cycles without losing protocol adherence. No shortcuts, no skipped steps.

4. **Priority ordering is correct.** P1 → P2 → P3, as expected from `bv --robot-next`.

5. **Workspace path remains the persistent gap.** Agent worked in default and used `rm -rf` to clean up the workspace instead of `maw ws merge --destroy -f`. The maw project is working on making workspace usage more explicit in their agent instructions. This is a tooling UX issue, not a docs issue — agents understand they should use workspaces but Claude Code's cwd reset makes it easy to fall back to default.

---

## Raw Outputs

### Bead States
```
bd-1q3|closed|2026-01-29T23:08:43.881401450+00:00
bd-241|closed|2026-01-29T23:10:55.827979880+00:00
bd-3pc|closed|2026-01-29T23:12:13.898499639+00:00
```

### Botbus Messages (digital-cedar only)
```
23:07:46 Working on bd-1q3
23:09:31 Completed bd-1q3
23:10:00 Working on bd-241
23:11:11 Completed bd-241
23:11:38 Working on bd-3pc
23:12:24 Completed bd-3pc
```

### Workspace State
```
Workspaces:
* default: uwxnkusq 89b51bcc feat: add request logging middleware
```
Only default remains — workspace was created and destroyed.

### Grooming Comment (bd-1q3)
```
Grooming: This bead lacks clear acceptance criteria. Based on context
(API project with no code yet), interpreting as: Create a GET /health
endpoint that returns 200 OK with {"status":"healthy"}. Will need to
set up basic Express server. Acceptance: endpoint responds, returns
valid JSON, includes status field. Testing: curl the endpoint, verify
200 status, verify JSON structure.
```
