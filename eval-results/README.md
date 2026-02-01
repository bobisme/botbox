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
| R3-1 | Full Review Loop | Sonnet | — | 60/65 (92%) | Re-review LGTM + merge; first merge attempt timed out (wrong crit command) |
| R4-1 | Integration (Full Lifecycle) | Sonnet | 1 | 89/95 (94%) | End-to-end triage→merge works; re-review needed prompt fix for workspace visibility |
| R4-2 | Integration (Full Lifecycle) | Sonnet | 1 | 95/95 (100%) | crit v0.9.1 vote override fix confirmed; perfect score with workspace path hint |
| R8-1 | Adversarial Review (v1) | Sonnet | — | 54/65 (83%) | v1 single-file: found all 3 bugs; 1 FP on permission check; over-severity on quality |

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
- **Workspace visibility is critical for re-review** — When the reviewer re-reviews after author fixes, they must read code from the workspace (`.workspaces/$WS/`), not the main branch. The main branch still has the pre-fix code until merge. Re-review prompts must include the workspace path explicitly.
- **Crit index doesn't update votes on override** — When a reviewer casts LGTM after previously blocking, the SQLite index retains the old block vote. The event log is correct. Workaround: `rm .crit/index.db` to force rebuild.
- **Full dev-agent lifecycle works end-to-end** — R4 validates triage→start→work→review→feedback→merge with 5 sequential `claude -p` invocations, 2 agents, coordinated via crit+botbus+beads. Score: 89/95 (94%).
- **Full review loop works with sequential `claude -p` invocations** — each agent reads shared state (crit + botbus), acts, updates state for next agent. No explicit agent-to-agent communication needed.
- **`crit reviews merge` not `crit reviews close`** — agent timed out trying to find a "close" command. Precise command names in prompts prevent this.
- **Reviewer re-review was thorough** — read actual code, ran clippy, verified each fix against original issue. Didn't rubber-stamp based on author's thread replies alone.
- **crit v0.9.1 vote override fix confirmed** — R4-2 LGTM properly overrides block in SQLite index. The 6-point Phase 4 improvement (4/10 → 10/10) is entirely attributable to this fix + workspace path hint.
- **Sonnet finds execution-path bugs with the v2 prompt** — R8-1 found all 3 adversarial bugs (race condition, TOCTOU delete, pagination underflow) that require comparing code paths rather than pattern matching. Expected range was 35-50; actual was 54/65 (83%). The v2 prompt's evidence-grounding instruction helps with subtle bugs too.
- **Clean code traps must be truly unambiguous** — R8-1 flagged the `mode & 0o444` permission check as LOW because the comment said "Standard Unix permission check" but the code only checks if bits are set, not actual process readability. The reviewer's argument has some merit. Future traps should be code that is both correct AND has accurate comments.
- **Quality issue over-severity is the main calibration gap** — R8-1 rated the non-UTF-8 `.unwrap()` as HIGH ("DoS") rather than LOW. While a panic is impactful, the trigger (non-UTF-8 filename on disk) isn't attacker-controlled in normal upload flows. Severity calibration degrades with more complex code.
- **R4 results are reproducible** — R4-1 and R4-2 with different agents, same protocol, same outcomes (modulo the fixed bug). Validates the eval framework produces consistent measurements.

## Upstream Tool Versions (as of 2026-01-31)

- botbus v0.3.8: self-message filtering, `claims --since`, `#channel` syntax
- maw v0.15.0: `maw ws merge --destroy` default (no `-f`), single-workspace merge, agent-oriented error output, absolute path guidance in help text, jj concept explanations
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

### Integration / R4 (95 points)

- Phase 1 (Work + Review Request): 40 pts (triage 10, start 5, implementation 10, review request 10, deferred finish 5)
- Phase 2 (Reviewer): 20 pts (bug/quality assessment 10, correct vote 5, protocol 5)
- Phase 3 (Handle Feedback): 15 pts (categorize 3, fix issues 5, thread replies 3, compile+re-request 4) — auto-award if Phase 2 LGTM
- Phase 4 (Re-review): 10 pts (read code 3, verify+LGTM 5, announcement 2) — auto-award if Phase 2 LGTM
- Phase 5 (Merge + Finish): 10 pts (verify LGTM 2, crit merge 2, maw merge 2, close+release 2, sync+announce 2)
- Pass: ≥66 pts (69%) | Excellent: ≥81 pts (85%)

### Adversarial Review / R8 (65 points, v2)

- Bug detection: 30 pts (race condition 12, TOCTOU delete 12, pagination underflow 6)
- Blocking decision: 5 pts (block if HIGH+ issues exist)
- Quality feedback: 10 pts (non-UTF-8 unwrap 3, silent error discard 3, constructive 4)
- Cross-file reasoning: 5 pts (explicitly compare download.rs vs delete.rs for TOCTOU)
- FP resistance: 5 pts (only penalize if clean trap flagged HIGH+ or cited in block reason)
- Protocol compliance: 10 pts (crit commands 5, botbus announcement 5)
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
- [R3-1](2026-01-31-review-r3-run1-sonnet.md)
- [R4-1](2026-01-31-review-r4-run1-sonnet.md)
- [R4-2](2026-01-31-review-r4-run2-sonnet.md)
- [R8-1](2026-02-01-review-r8-run1-sonnet.md)
