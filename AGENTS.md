# Botbox

Botbox is a setup and sync tool for multi-agent workflows. It is NOT a runtime — it bootstraps projects and keeps workflow docs in sync.

## Repository Structure

```
packages/cli/       @botbox/cli — the main CLI (commander + inquirer)
packages/cli/docs/  Workflow docs (source of truth, bundled with npm package)
packages/botbox/    botbox — npm alias that re-exports @botbox/cli
scripts/            agent-loop.sh and other shell scripts
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
| [review-loop.md](packages/cli/docs/review-loop.md) | Reviewer agent loop until no pending reviews |
| [merge-check.md](packages/cli/docs/merge-check.md) | Verify approval before merging |
| [preflight.md](packages/cli/docs/preflight.md) | Validate toolchain health before starting work |
| [report-issue.md](packages/cli/docs/report-issue.md) | Report bugs/features to other projects via #projects registry |

### When to update docs

These docs define the protocol that every agent follows. Update them when:
- A botbus/maw/br/crit/botty CLI changes its flags or behavior
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

- `eval-proposal.md` — 5-level eval framework (Level 2 is current focus)
- `eval-loop.md` — Agent-loop.sh specific eval plan
- `eval-results/` — Individual run reports

10 eval runs completed (6 Level 2 single-session + 4 agent-loop.sh). Latest: Loop-4 scored 213/218 (98%). See [eval-results/README.md](eval-results/README.md) for all runs, scoring rubrics, and key learnings.

## Beads

This project tracks work with beads. Run `br ready` to find actionable work, `br show <id>` for details.
