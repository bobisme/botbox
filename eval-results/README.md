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
| Loop-10 | agent-loop.sh v2.1 | Haiku | 2 | 206/218 (94%) | Clean run — excellent grooming, tests, br sync fix confirmed |
| R1-1 | Review (Fixture A) | Sonnet | — | 51/65 (78%) | Found path traversal; 3 false positives (Axum route syntax, static mut) |
| R1-2 | Review (Fixture A) | Sonnet | — | 61/65 (94%) | v2 prompt: clippy + web search eliminated Axum FP, grounded static mut |
| R1-3 | Review (Fixture A v2) | Sonnet | — | 65/65 (100%) | Fixed fixture: static mut was genuinely problematic, not clean code |
| R2-1 | Author Response | Sonnet | — | 65/65 (100%) | All 3 threads fixed correctly; canonicalize+starts_with for path traversal |

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
- **Reviewer prompt: clippy + web search + severity levels** dramatically reduce false positives (R1-1 → R1-2: 3 FPs → 1). Instruction to "ground findings in evidence" is key.
- **Eval fixtures must be genuinely correct** — original R1 fixture used `static mut` as "clean code" but it was actually problematic (clippy warns, deprecated, unsound under tokio). Reviewer was right to flag it. Fixed in Fixture A v2.
- **`claude -p` via shell script is more reliable than inline** — long prompts with escaped quotes in direct bash invocation caused sessions to hang. Writing a launcher script with a `$PROMPT` variable resolved the issue.
- **Reviewer severity levels provide sufficient signal for author triage** — R2 agent correctly prioritized CRITICAL > MEDIUM > INFO without explicit "if CRITICAL then fix" logic. The review comments themselves communicated required action.
- **All comments treated as "fix"** — R2 Run 1 fixed all 3 threads. Doesn't exercise "address" (won't-fix) or "defer" (create bead) paths. Future R2 runs should include a comment the author should push back on.

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

### Author Response (65 points)

- CRITICAL fix: 25 pts (identifies as must-fix, secure code fix, compiles, thread reply, no regressions)
- MEDIUM fix: 15 pts (identifies as should-fix, correct fix, thread reply, no breakage)
- INFO handling: 10 pts (identifies as non-blocking, appropriate action, thread reply)
- Protocol compliance: 15 pts (jj commit, re-request review, botbus announcement)
- Pass: ≥45 pts (69%) | Excellent: ≥55 pts (85%)

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
- [Loop-10](2026-01-30-agent-loop-run10-haiku-v2.1.md)
- [R1-1](2026-01-31-review-run1-sonnet.md)
- [R1-2](2026-01-31-review-run2-sonnet.md)
- [R1-3](2026-01-31-review-run3-sonnet.md)
- [R2-1](2026-01-31-review-r2-run1-sonnet.md)
