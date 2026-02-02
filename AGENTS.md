# Botbox

Botbox is a setup and sync tool for multi-agent workflows. It is NOT a runtime — it bootstraps projects and keeps workflow docs in sync.

## CRITICAL: Track ALL Work in Beads BEFORE Starting

**MANDATORY**: Before starting any non-trivial task, create a bead to track it. This is not optional.

1. **Check for existing bead**: `br ready`, `br show <id>`
2. **Create if missing**: `br create --actor $AGENT --owner $AGENT --title="..." --description="..." --type=task --priority=<1-4>`
3. **Mark in_progress**: `br update --actor $AGENT <id> --status=in_progress`
4. **Do the work**, posting progress comments
5. **Close when done**: `br close --actor $AGENT <id>`

Beads enable crash recovery, handoffs, and resumption. Without beads, work is lost. See the [Beads (MANDATORY)](#beads-mandatory) section below for full details.

## Repository Structure

```
packages/cli/       @botbox/cli — the main CLI (commander + inquirer)
packages/cli/docs/  Workflow docs (source of truth, bundled with npm package)
packages/botbox/    botbox — npm alias that re-exports @botbox/cli
scripts/            Shell scripts: agent-loop.sh (worker), reviewer-loop.sh (reviewer), dev-loop.sh (lead dev orchestrator)
evals/              Behavioral eval framework: rubrics, scripts, and results
.beads/             Issue tracker (beads)
```

## Development

Runtime: **bun** (not node). Tooling: **oxlint** (lint), **oxfmt** (format), **tsc** (type check via jsconfig.json).

```bash
just install    # bun install
just lint       # oxlint
just fmt        # oxfmt --write
just check      # tsc -p jsconfig.json
bun test        # run tests (packages/cli/)
```

All source is `.mjs` with JSDoc type annotations — no build step. Types are enforced by `tsc --checkJs` with strict settings.

## CLI Architecture

Entry point: `packages/cli/src/index.mjs`

Commands:
- `botbox init` — interactive bootstrap (project name, type, tools, reviewers). Also accepts `--name`, `--type`, `--tools`, `--reviewers`, `--init-beads`, `--force`, `--no-interactive` for non-interactive use.
- `botbox sync` — update `.agents/botbox/` docs and managed section of AGENTS.md. `--check` exits non-zero if stale.
- `botbox doctor` — validate toolchain and project configuration.

Key modules:
- `src/lib/docs.mjs` — copies bundled docs, manages version markers (SHA-256 hash of doc content)
- `src/lib/templates.mjs` — renders AGENTS.md and its managed section
- `src/lib/errors.mjs` — `ExitError` class (thrown instead of `process.exit()`)

## Conventions

- **Version control: jj** (not git). Use `jj describe -m "message"` to set commit messages and `jj new` to finalize. Never use `git commit`. Run `maw jj-intro` for a git-to-jj quick reference.
- `let` for all variables, `const` only for true constants (module-level, unchanging values)
- No build step — `.mjs` + JSDoc everywhere
- Tests use `bun:test` — colocated as `*.test.mjs` next to source
- Strict linting (oxlint with correctness + suspicious as errors)
- Commands throw `ExitError` instead of calling `process.exit()` directly
- All commits include the trailer `Co-Authored-By: Claude <noreply@anthropic.com>` when Claude contributes

## Workflow Docs

Workflow docs live in `packages/cli/docs/` and are bundled with the npm package. When `botbox init` runs in a target project, they're copied into `.agents/botbox/` and referenced from the generated AGENTS.md.

### Index

| Doc | Purpose |
|-----|---------|
| [triage.md](packages/cli/docs/triage.md) | Find exactly one actionable bead from inbox and ready queue |
| [start.md](packages/cli/docs/start.md) | Claim a bead, create a workspace, announce |
| [update.md](packages/cli/docs/update.md) | Post progress updates during work |
| [finish.md](packages/cli/docs/finish.md) | Close bead, merge workspace, release claims, sync |
| [worker-loop.md](packages/cli/docs/worker-loop.md) | Full triage-start-work-finish lifecycle |
| [review-request.md](packages/cli/docs/review-request.md) | Request a code review via crit |
| [review-response.md](packages/cli/docs/review-response.md) | Handle reviewer feedback (fix/address/defer) and merge after LGTM |
| [review-loop.md](packages/cli/docs/review-loop.md) | Reviewer agent loop until no pending reviews |
| [merge-check.md](packages/cli/docs/merge-check.md) | Verify approval before merging |
| [preflight.md](packages/cli/docs/preflight.md) | Validate toolchain health before starting work |
| [report-issue.md](packages/cli/docs/report-issue.md) | Report bugs/features to other projects via #projects registry |
| [groom.md](packages/cli/docs/groom.md) | Groom ready beads: fix titles, descriptions, priorities, break down large tasks |

### When to update docs

These docs define the protocol that every agent follows. Update them when:
- A bus/maw/br/crit/botty CLI changes its flags or behavior
- You discover a missing step, ambiguity, or edge case during real agent runs
- A new workflow is added (e.g., a new review strategy, a new teardown step)

Do **not** update docs for project-specific conventions — those belong in the target project's AGENTS.md above the managed section.

### How to update docs

1. Edit the file in `packages/cli/docs/`
2. Run `bun test` — the version hash will change, confirming the update is detected
3. If adding a new doc, add an entry to the `DOC_DESCRIPTIONS` map in `src/lib/templates.mjs`
4. Target projects pick up changes on their next `botbox sync`

## Eval Framework

This project has a behavioral evaluation framework for testing whether agents follow the botbox protocol. Key docs:

- `evals/rubrics.md` — Eval rubrics (R1-R9), tracked by epic bd-110
- `docs/dev-agent-architecture.md` — Target multi-agent architecture
- `evals/results/` — Individual run reports
- `evals/scripts/` — Eval setup and run scripts

27 eval runs completed: 6 Level 2 single-session, 10 agent-loop.sh, 3 review (R1), 1 author response (R2), 1 full review loop (R3), 2 integration (R4), 1 cross-project (R5), 1 parallel dispatch (R6), 1 planning (R7), 3 adversarial review (R8), 1 crash recovery (R9). R5-1: Opus 70/70 (100%) — perfect cross-project coordination, followed report-issue.md to file bug in external project. R6-1: Opus 69/70 (99%). R9-1: Opus 69/70 (99%). R8v2 multi-file: Opus 49/65 (75%), Sonnet 41/65 (63% FAIL). See [evals/results/README.md](evals/results/README.md) for all runs and key learnings.

### Running R4 evals

Launcher scripts are in `evals/scripts/r4-{setup,phase1,phase2,phase3,phase4,phase5}.sh`. Run setup first, then phases sequentially. Phase 3+4 are only needed if Phase 2 blocks. The eval environment path, agent names, and review/workspace IDs are auto-discovered by each script. See `evals/rubrics.md` R4 section for the full rubric.

Key learnings from R4-1:
- Phase 4 (re-review) prompt must include workspace path — reviewer reads from `.workspaces/$WS/`, not project root
- crit v0.9.1 fixed a vote index bug where LGTM didn't override block (jj workspace reconciliation could restore stale events.jsonl)
- `crit reviews merge` not `close`; `maw ws merge --destroy` without `-f`

## Beads (MANDATORY)

**Every non-trivial task MUST be tracked in a bead.** This is not optional — beads are how we resume after crashes, handoffs, and context loss. If the session dies mid-task, the bead + its comments are the only record of what was done and what remains.

### Before starting work

1. Check if a bead exists: `br ready`, `br show <id>`
2. If no bead exists, create one: `br create --actor $AGENT --owner $AGENT --title="..." --description="..." --type=task --priority=<1-4>`
3. **Break down multi-step work** into subtasks before starting. Each subtask should be one resumable unit — if the session crashes after completing it, the next session knows exactly where to pick up. Wire dependencies:
   - **Ordering** (B can't start until A is done): `br dep add --actor $AGENT B A` — "B is blocked by A"
   - **Subtask-of** (parent can't close until child is done): `br dep add --actor $AGENT parent child` — "parent is blocked by child"
   - **Sibling chain**: `br dep add --actor $AGENT S2 S1`, `br dep add --actor $AGENT S3 S2` — sequential ordering
4. Mark it in_progress: `br update --actor $AGENT <id> --status=in_progress`

### During work

4. **Post progress comments** as you complete milestones: `br comments add --actor $AGENT --author $AGENT <id> "what was done, what's next"`
   - This is critical for crash recovery — if the session dies, the next session reads these comments to resume
   - Include: files changed, decisions made, what remains
   - Always include workspace name and path in the first comment (e.g., "Started in workspace frost-castle (/abs/path/.workspaces/frost-castle)")

### After work

5. Close the bead: `br close --actor $AGENT <id>`
6. Sync: `br sync --flush-only`

### Bead quality (see [groom.md](packages/cli/docs/groom.md))

- **Title**: Clear, actionable, imperative form ("Add X", "Fix Y")
- **Description**: What, why, acceptance criteria, testing strategy
- **Priority**: P0 (critical) through P4 (nice-to-have)
- **Labels**: Categorize consistently (e.g., `eval`, `cli`, `docs`)
- **Size**: One bead = one resumable unit of work. If a task has multiple steps that could be completed independently (e.g., "run eval with Opus" and "run eval with Sonnet"), each step gets its own bead. Use `br dep add --actor $AGENT <child> <parent>` for subtasks and sibling dependencies for ordering.
