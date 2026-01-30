# Eval Results

Behavioral evaluation of agents following the botbox protocol. See `eval-proposal.md` for the framework and `eval-loop.md` for agent-loop.sh specifics.

## Runs

| Run | Type | Model | Beads | Score | Key Finding |
|-----|------|-------|-------|-------|-------------|
| L2-1 | Single session | Opus | 1 | 92/92 (100%) | Baseline: perfect protocol compliance |
| L2-2 | Single session | Sonnet | 1 | 81/92 (88%) | Missing optional steps (triage, progress, cleanup) |
| L2-3 | Single session | Sonnet | 1 | 88/92 (96%) | Progress comment docs helped (+7) |
| L2-4 | Single session | Sonnet | 1 | 83/92 (90%) | Workspace destroy docs helped (+2) |
| L2-5 | Single session | Sonnet | 3 | 89/96 (93%) | Multi-bead unlocked triage + grooming |
| L2-6 | Single session | Sonnet | 2 | 92/96 (96%) | maw output fix confirmed workspace path usage |
| Loop-1 | agent-loop.sh v1 | Sonnet | 2 | 28/30 shell | Sandbox blocked file writes; found has_work() bugs |
| Loop-2 | agent-loop.sh v1 | Sonnet | 2 | 211/218 (97%) | Happy path works! Both beads completed across iterations |
| Loop-3 | agent-loop.sh v2 | Sonnet | 2 | 117/218 (54%) | CWD deletion broke all finish steps |
| Loop-4 | agent-loop.sh v2 | Sonnet | 2 | 215/218 (99%) | CWD fix validated — absolute paths resolve finish breakage |
| Loop-5 | agent-loop.sh v3 | Sonnet | 2 | 215/248 (87%) | Inbox triage completely skipped (0/30) — prompt too dense |
| Loop-6 | agent-loop.sh v3 | Sonnet | 2 | 245/248 (99%) | Inbox perfect (30/30) after splitting INBOX as separate step |
| Loop-7 | agent-loop.sh v3 | Sonnet | 2 | 232/248 (94%) | Duplicate bead from inbox; 4 iterations instead of 3 |
| Loop-8 | agent-loop.sh v3 | Haiku | 2 | 205/248 (83%) | First haiku run: no inbox replies, duplicate bead, stale br ready |
| Loop-9 | agent-loop.sh v3 | Haiku | 2 | 65/248 (26%) | **FAIL**: bead spam from inbox, phantom close, timeout |

## Key Learnings

- Multi-bead evals are strictly better (force observable triage/grooming)
- Every doc/tooling improvement produced measurable score gains
- Workspace path usage requires maw's "IMPORTANT" output line (fixed in maw v0.6.0+)
- Merge issue fixed in maw v0.8.0
- `workspace://<project>/<workspace>` is the claim URI format for workspaces
- `claude -p` needs `--dangerously-skip-permissions` for autonomous file operations
- `has_work()` had two JSON parser bugs (br ready returns array, botbus inbox --count-only returns int)
- Agent's own botbus messages fixed upstream: botbus v0.3.8 filters self-messages from inbox
- Single-workspace merge fixed: maw v0.9.0 supports merging when only 1 workspace exists
- Run `br` commands from project root, not inside `.workspaces/$WS/` (prevents beads merge conflicts)
- Agent naming convention: `<project>-dev` for interactive, random names for agent-loop.sh
- **Do not `cd` into workspace and stay there** — use absolute paths for file ops, `maw ws jj` for jj commands. Workspace destroy deletes the directory and breaks the shell session (Loop-3 regression, Loop-4 fix)
- `br ready` may show stale state after workspace merge — agent can waste an iteration re-doing closed work (Loop-4, Loop-7 observation)
- **Duplicate bead detection from inbox is inconsistent** — agent sometimes creates a new bead from inbox task-request instead of recognizing an existing bead covers it (Loop-7). Prompt says "do NOT create another bead" but this isn't always followed.

## Upstream Tool Versions (as of 2026-01-30)

- botbus v0.3.8: self-message filtering, `claims --since`, `#channel` syntax
- maw v0.12.0: single-workspace merge, agent-oriented error output, absolute path guidance in help text, jj concept explanations
- All workflow docs updated with eval learnings (identity, br-from-root, tool-issue reporting, progress comments, blocked bead re-evaluation, absolute workspace paths)

## Scoring Rubric

### Single Session (96 points, multi-bead)

- Critical steps: 50 pts (claim, start, finish, release, sync)
- Optional steps: 16 pts (identity, triage, groom, workspace create/path/destroy, progress, announce)
- Work quality: 20 pts (task complete, tests pass, code quality)
- Error handling: 10 pts (progress updates, bug reporting)
- Pass: ≥70 pts (73%) | Excellent: ≥85 pts (89%)

### Agent Loop (218 points = 30 shell + 2×94 per-iteration)

- Shell mechanics: 30 pts (lease, spawn announce, has_work() gating, one-bead-per-iteration, cleanup, shutdown)
- Per-iteration: 94 pts (50 critical + 14 optional + 20 quality + 10 error handling; identity N/A = -2)
- Pass: ≥170 pts (77%) | Excellent: ≥200 pts (90%)

### Scoring Notes

- **Progress comments**: Required by docs (cheap insurance for crash recovery), but only -1 pt if missing on a task completed quickly. The requirement exists for failure-case visibility, not ceremony.

## Individual Reports

- [Loop-1](2026-01-30-agent-loop-run1-sonnet.md)
- [Loop-2](2026-01-30-agent-loop-run2-sonnet.md)
- [Loop-3](2026-01-30-agent-loop-run3-sonnet.md)
- [Loop-4](2026-01-30-agent-loop-run4-sonnet.md)
- [Loop-5](2026-01-30-agent-loop-run5-sonnet-v3.md)
- [Loop-6](2026-01-30-agent-loop-run6-sonnet-v3.md)
- [Loop-7](2026-01-30-agent-loop-run7-sonnet-v3.md)
- [Loop-8](2026-01-30-agent-loop-run8-haiku-v3.md)
- [Loop-9](2026-01-30-agent-loop-run9-haiku-v3.md)
