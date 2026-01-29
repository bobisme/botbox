# botbox

Setup and sync tool for multi-agent workflows. NOT a runtime — bootstraps projects and keeps workflow docs in sync.

## What is botbox?

`botbox` is an npm CLI that:
1. **Initializes projects** for multi-agent collaboration (interactive or via flags)
2. **Syncs workflow docs** from a canonical source to `.agents/botbox/`
3. **Validates health** via `doctor` command

It glues together 5 Rust tools (botbus, maw, br/bv, crit, botty) into a cohesive workflow.

## Install

```bash
npm install -g botbox
# or: npm install -g @botbox/cli
```

## Usage

```bash
# Bootstrap a new project (interactive)
botbox init

# Bootstrap with flags (for agents)
botbox init --name my-api --type api --tools beads,maw,crit,botbus --reviewers security --no-interactive

# Sync workflow docs after botbox upgrades
botbox sync

# Check if sync is needed
botbox sync --check

# Validate toolchain and project setup
botbox doctor
```

## What gets created?

After `botbox init`:
```
.agents/botbox/          # Workflow docs (triage, start, finish, etc.)
  triage.md
  start.md
  update.md
  finish.md
  worker-loop.md
  review-request.md
  review-loop.md
  merge-check.md
  preflight.md
  report-issue.md
  .version               # Version hash for sync tracking
AGENTS.md                # Generated with managed section + project-specific content above
CLAUDE.md -> AGENTS.md   # Symlink
```

## Workflow docs

The workflow docs in `.agents/botbox/` define the protocol:
- **triage.md**: Find work from inbox and beads
- **start.md**: Claim bead, create workspace, announce
- **update.md**: Post progress updates
- **finish.md**: Close bead, merge workspace, release claims, sync
- **worker-loop.md**: Full triage-start-work-finish lifecycle
- **review-request.md**: Request code review via crit
- **review-loop.md**: Reviewer agent loop
- **merge-check.md**: Verify approval before merge
- **preflight.md**: Validate toolchain health
- **report-issue.md**: Report bugs/features to other projects

These are the source of truth. When botbox updates, run `botbox sync` to pull changes.

## Stack

| Tool | Purpose | Key commands |
|------|---------|-------------|
| **botbus** | Communication, claims, presence | `send`, `inbox`, `claim`, `release`, `agents` |
| **maw** | Isolated jj workspaces | `ws create`, `ws merge`, `ws destroy` |
| **br/bv** | Work tracking + triage | `ready`, `create`, `close`, `--robot-next` |
| **crit** | Code review | `review`, `comment`, `lgtm`, `block` |
| **botty** | Agent runtime | `spawn`, `kill`, `tail`, `snapshot` |

## Development

```bash
cd packages/cli
bun install
bun link              # Make botbox available globally
just lint             # oxlint
just fmt              # oxfmt --write
just check            # tsc -p jsconfig.json
bun test              # 50 tests
```

Runtime: **bun** (not node)
Tooling: **oxlint** (lint), **oxfmt** (format), **tsc** (type check via jsconfig.json)
No build step: `.mjs` + JSDoc types

## Testing

- **Unit tests**: `bun test` (50 tests in packages/cli/)
- **E2E tests**: See `testing.md` (8 scenarios, all passing)
- **UX test**: See `ux-test.md` and `ux-test-report.md` (comprehension validated)
- **Behavioral eval**: See `eval-proposal.md` and `eval-results/` (Level 2 run 1: 92/92 perfect score)

## Cross-project feedback

The `#projects` registry on botbus tracks which tools belong to which projects:

```bash
# Find who owns a tool
botbus inbox --agent $AGENT --channels projects --all | grep "tools:.*botty"

# File bugs in their repo
cd ~/src/botty
br create --title="Bug: ..." --type=bug --priority=2
botbus send botty "Filed bd-xyz: description @botty-dev" -L feedback
```

See `packages/cli/docs/report-issue.md` for full workflow.

## Status

**Production-ready** as of 2026-01-29:
- ✅ CLI implemented (init, sync, doctor)
- ✅ 50 unit tests passing
- ✅ 8 e2e tests passing
- ✅ UX test validated (agent comprehension: 8/8 questions correct)
- ✅ Behavioral eval validated (Level 2: 92/92 perfect score)
- ✅ Cross-project feedback workflow documented

## Contributing

All commits include: `Co-Authored-By: Claude <noreply@anthropic.com>` when Claude contributes.

See `AGENTS.md` for conventions and workflow.
