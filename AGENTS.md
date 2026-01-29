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

## Workflow Docs

Workflow docs live in `packages/cli/docs/` and are bundled with the npm package. When `botbox init` runs in a target project, they're copied into `.agents/botbox/` and referenced from the generated AGENTS.md.

To add or edit a workflow doc:
1. Edit the file in `packages/cli/docs/`
2. Run `bun test` to verify the version hash changes and tests pass
3. Update the description map in `renderManagedSection()` if adding a new doc

## Beads

This project tracks work with beads. Run `br ready` to find actionable work, `br show <id>` for details.
