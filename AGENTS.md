# Botbox

Botbox is a setup and sync tool for multi-agent workflows. It bootstraps projects with workflow docs, scripts, and hooks that enable multiple AI coding agents to collaborate on the same codebase — triaging work, claiming tasks, reviewing each other's code, and communicating via channels.

Botbox is NOT a runtime. It copies files and regenerates config; the actual coordination happens through the companion tools below.

## Ecosystem

Botbox orchestrates these companion projects (all ours):

| Project | Binary | Purpose |
|---------|--------|---------|
| **botbus** | `bus` | Channel-based messaging, claims (advisory locks), agent coordination |
| **maw** | `maw` | Multi-agent workspaces — isolated jj working copies for concurrent edits |
| **botcrit** | `crit` | Distributed code review for jj — threads, votes, LGTM/block workflow |
| **botty** | `botty` | PTY-based agent runtime — spawn, manage, and communicate with agents |
| **beads-tui** | `bu` | TUI for viewing and managing beads (issues) |

External (not ours, but used heavily):
- **beads** (`br`) — Issue tracker with crash-recovery-friendly design

## CRITICAL: Track ALL Work in Beads BEFORE Starting

**MANDATORY**: Before starting any non-trivial task, create a bead to track it. This is not optional.

1. **Check for existing bead**: `br ready`, `br show <id>`
2. **Create if missing**: `br create --actor $AGENT --owner $AGENT --title="..." --description="..." --type=task --priority=<1-4>`
3. **Mark in_progress**: `br update --actor $AGENT <id> --status=in_progress`
4. **Do the work**, posting progress comments
5. **Close when done**: `br close --actor $AGENT <id>`

Beads enable crash recovery, handoffs, and resumption. Without beads, work is lost.

## How botbox sync Works

`botbox sync` keeps projects up to date with latest docs, scripts, conventions, and hooks. It manages:

- **Workflow docs** (`.agents/botbox/*.md`) — copied from bundled source
- **AGENTS.md managed section** — regenerated from templates
- **Loop scripts** (`.agents/botbox/scripts/*.mjs`) — copied based on enabled tools
- **Claude Code hooks** (`.agents/botbox/hooks/*.sh`) — shell scripts for Claude Code events
- **Design docs** (`.agents/botbox/design/*.md`) — copied based on project type
- **Config migrations** (`.botbox.json`) — runs pending migrations

### Migrations

**Botbus hooks** (registered via `bus hooks add`) and other runtime changes are managed through **migrations**, not direct sync logic.

Migrations live in `src/migrations/index.mjs`. Each has:
- `id`: Semantic version (e.g., "1.0.5")
- `title`: Short description
- `up(ctx)`: Migration function with access to projectDir, config, etc.

Migrations run automatically during `botbox sync` when the config version is behind. **When adding new botbus hook types or changing runtime behavior, add a migration.**

Example: Migration 1.0.5 adds the respond hook for `@<project>-dev` mentions.

## Botbox Release Process

Changes to workflow docs, scripts, prompts, or templates require a release:

1. **Make changes** in `packages/cli/`
2. **Add migration** if behavior changes (see `src/migrations/index.mjs`)
3. **Run tests**: `bun test` — version hashes auto-update
4. **Commit and push** to main
5. **Tag**: `jj tag create vX.Y.Z -r main && jj git push --remote origin`
6. **Install locally**: `just install`

Use semantic versioning and conventional commits. See [packages/cli/AGENTS.md](packages/cli/AGENTS.md) for component details.

## Repository Structure

This is a bun monorepo with two packages:

```
packages/cli/          @botbox/cli — the main CLI (commander + inquirer)
  ├── src/             Commands, lib modules, migrations
  ├── docs/            Workflow docs (bundled with npm, copied to target projects)
  └── scripts/         Loop scripts (dev-loop.mjs, agent-loop.mjs, etc.)
packages/botbox/       botbox — npm alias that re-exports @botbox/cli
scripts/               Shell launchers for loop scripts (agent-loop.sh, etc.)
evals/                 Behavioral eval framework: rubrics, scripts, results
notes/                 Extended docs not needed for daily work
.beads/                Issue tracker (beads)
```

**Why two packages?** `@botbox/cli` is the scoped package with all the code. `botbox` is an unscoped alias so users can run `npx botbox init` without the `@` prefix.

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

## Testing

**Automated tests**: Run `bun test` - these use isolated environments automatically.

**Manual testing**: ALWAYS use isolated data directories to avoid polluting actual project data:

```bash
# Use temporary botbus data directory
BOTBUS_DATA_DIR=/tmp/test-botbus botbox init --name test --type cli --tools beads,maw,crit,botbus --no-interactive

# Also isolate other tools during testing
BOTBUS_DATA_DIR=/tmp/test-botbus bus hooks list
BOTBUS_DATA_DIR=/tmp/test-botbus bus send ...

# Clean up after testing
rm -rf /tmp/test-botbus
```

**Why this matters**: Without isolation, manual tests create hooks, claims, and messages in your actual botbus data directory, mixing test artifacts with real project data.

**Applies to**: Any manual testing with bus, botty, crit, maw, or br commands during development.

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

Source docs live in `packages/cli/docs/` and get copied to target projects during `botbox init`. For doc index, update procedures, and maintenance guidance, see [notes/workflow-docs-maintenance.md](notes/workflow-docs-maintenance.md).

## Eval Framework

Behavioral eval framework for testing agent protocol compliance. See [notes/eval-framework.md](notes/eval-framework.md) for run history, results, and instructions.

<!-- botbox:managed-start -->
## Botbox Workflow

**New here?** Read [worker-loop.md](.agents/botbox/worker-loop.md) first — it covers the complete triage → start → work → finish cycle.

**All tools have `--help`** with usage examples. When unsure, run `<tool> --help` or `<tool> <command> --help`.

### Beads Quick Reference

| Operation | Command |
|-----------|---------|
| View ready work | `br ready` |
| Show bead | `br show <id>` |
| Create | `br create --actor $AGENT --owner $AGENT --title="..." --type=task --priority=2` |
| Start work | `br update --actor $AGENT <id> --status=in_progress` |
| Add comment | `br comments add --actor $AGENT --author $AGENT <id> "message"` |
| Close | `br close --actor $AGENT <id>` |
| Add dependency | `br dep add --actor $AGENT <blocked> <blocker>` |
| Sync | `br sync --flush-only` |

**Required flags**: `--actor $AGENT` on mutations, `--author $AGENT` on comments.

### Workspace Quick Reference

| Operation | Command |
|-----------|---------|
| Create workspace | `maw ws create <name>` |
| List workspaces | `maw ws list` |
| Merge to main | `maw ws merge <name> --destroy` |
| Destroy (no merge) | `maw ws destroy <name>` |
| Run jj in workspace | `maw ws jj <name> <jj-args...>` |

**Avoiding divergent commits**: Each workspace owns ONE commit. Only modify your own.

| Safe | Dangerous |
|------|-----------|
| `jj describe` (your working copy) | `jj describe main -m "..."` |
| `maw ws jj <your-ws> describe -m "..."` | `jj describe <other-change-id>` |

If you see `(divergent)` in `jj log`:
```bash
jj abandon <change-id>/0   # keep one, abandon the divergent copy
```

### Beads Conventions

- Create a bead before starting work. Update status: `open` → `in_progress` → `closed`.
- Post progress comments during work for crash recovery.
- **Push to main** after completing beads (see [finish.md](.agents/botbox/finish.md)).
- **Install locally** after releasing: `just install`

### Identity

Your agent name is set by the hook or script that launched you. Use `$AGENT` in commands.
For manual sessions, use `<project>-dev` (e.g., `myapp-dev`).

### Claims

When working on a bead, stake claims to prevent conflicts:

```bash
bus claims stake --agent $AGENT "bead://<project>/<id>" -m "<id>"
bus claims stake --agent $AGENT "workspace://<project>/<ws>" -m "<id>"
bus claims release --agent $AGENT --all  # when done
```

### Reviews

Use `@<project>-<role>` mentions to request reviews:

```bash
crit reviews request <review-id> --reviewers $PROJECT-security --agent $AGENT
bus send --agent $AGENT $PROJECT "Review requested: <review-id> @$PROJECT-security" -L review-request
```

The @mention triggers the auto-spawn hook for the reviewer.

### Cross-Project Communication

When you have questions, feedback, or issues with tools from other projects:

1. Find the project: `bus inbox --agent $AGENT --channels projects --all`
2. Post to their channel: `bus send <project> "..." -L feedback`
3. For bugs/features, create beads in their repo (see [report-issue.md](.agents/botbox/report-issue.md))

This includes: bugs, feature requests, confusion about APIs, UX problems, or just questions.


### Design Guidelines

- [CLI tool design for humans, agents, and machines](.agents/botbox/design/cli-conventions.md)

### Workflow Docs

- [Close bead, merge workspace, release claims, sync](.agents/botbox/finish.md)
- [groom](.agents/botbox/groom.md)
- [Verify approval before merge](.agents/botbox/merge-check.md)
- [Validate toolchain health](.agents/botbox/preflight.md)
- [Report bugs/features to other projects](.agents/botbox/report-issue.md)
- [Reviewer agent loop](.agents/botbox/review-loop.md)
- [Request a review](.agents/botbox/review-request.md)
- [Handle reviewer feedback (fix/address/defer)](.agents/botbox/review-response.md)
- [Claim bead, create workspace, announce](.agents/botbox/start.md)
- [Find work from inbox and beads](.agents/botbox/triage.md)
- [Change bead status (open/in_progress/blocked/done)](.agents/botbox/update.md)
- [Full triage-work-finish lifecycle](.agents/botbox/worker-loop.md)
<!-- botbox:managed-end -->
