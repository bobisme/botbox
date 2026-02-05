# Eval Framework

This project has a behavioral evaluation framework for testing whether agents follow the botbox protocol.

## Key Docs

- `evals/rubrics.md` — Eval rubrics (R1-R9), tracked by epic bd-110
- `docs/dev-agent-architecture.md` — Target multi-agent architecture
- `evals/results/` — Individual run reports
- `evals/scripts/` — Eval setup and run scripts

## Completed Runs

27 eval runs completed:
- 6 Level 2 single-session
- 10 agent-loop.sh
- 3 review (R1)
- 1 author response (R2)
- 1 full review loop (R3)
- 2 integration (R4)
- 1 cross-project (R5)
- 1 parallel dispatch (R6)
- 1 planning (R7)
- 3 adversarial review (R8)
- 1 crash recovery (R9)

### Notable Results

- **R5-1**: Opus 70/70 (100%) — perfect cross-project coordination, followed report-issue.md to file bug in external project
- **R6-1**: Opus 69/70 (99%)
- **R9-1**: Opus 69/70 (99%)
- **R8v2 multi-file**: Opus 49/65 (75%), Sonnet 41/65 (63% FAIL)

See [evals/results/README.md](../evals/results/README.md) for all runs and key learnings.

## Running R4 Evals

Launcher scripts are in `evals/scripts/r4-{setup,phase1,phase2,phase3,phase4,phase5}.sh`. Run setup first, then phases sequentially. Phase 3+4 are only needed if Phase 2 blocks. The eval environment path, agent names, and review/workspace IDs are auto-discovered by each script. See `evals/rubrics.md` R4 section for the full rubric.

### Key learnings from R4-1

- Phase 4 (re-review) prompt must include workspace path — reviewer reads from `.workspaces/$WS/`, not project root
- crit v0.9.1 fixed a vote index bug where LGTM didn't override block (jj workspace reconciliation could restore stale events.jsonl)
- `crit reviews merge` not `close`; `maw ws merge --destroy` without `-f`
