# botbox

![botbox utopia](images/botbox-utopia.webp)

Setup and sync tool for multi-agent workflows. NOT a runtime — bootstraps projects and keeps workflow docs in sync.

## Eval Results

16 behavioral evaluations across Opus, Sonnet, and Haiku. The eval framework tests whether agents follow the botbox protocol (triage, claim, start, work, finish, release) when driven by `scripts/agent-loop.sh`.

| Model  | Best Score | Eval Version        | Key Result                                                  |
| ------ | ---------- | ------------------- | ----------------------------------------------------------- |
| Opus   | 100%       | L2 (single session) | Perfect protocol compliance                                 |
| Sonnet | 99%        | v3 (inbox triage)   | Handles full inbox + beads lifecycle                        |
| Haiku  | 94%        | v2.1 (beads only)   | Excellent on pre-groomed tasks; struggles with inbox triage |

**Takeaway**: Sonnet handles the full protocol including inbox triage. Haiku matches Sonnet on core task execution (94% vs 94-99%) but fails on message classification — use it for pre-triaged work. See [evals/results/](evals/results/README.md) for all 16 runs, scoring rubrics, and detailed findings.

## What is botbox?

`botbox` is an npm CLI that:

1. **Initializes projects** for multi-agent collaboration (interactive or via flags)
2. **Syncs workflow docs** from a canonical source to `.agents/botbox/`
3. **Validates health** via `doctor` command

It glues together 5 Rust tools (bus, maw, br/bv, crit, botty) into a cohesive workflow.

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
botbox init --name my-api --type api --tools beads,maw,crit,bus --reviewers security --no-interactive

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

## Agent loop

`scripts/agent-loop.sh` drives autonomous agent workers:

```bash
# Run a Sonnet worker (full protocol including inbox)
CLAUDE_MODEL=sonnet bash scripts/agent-loop.sh my-project

# Run a Haiku worker (best for pre-groomed beads)
CLAUDE_MODEL=haiku bash scripts/agent-loop.sh my-project
```

The script handles agent leases, work detection (`has_work()`), one-bead-per-iteration discipline, and cleanup on exit. Each iteration spawns a `claude -p` session that executes one triage-start-work-finish cycle.

## Stack

| Tool       | Purpose                         | Key commands                                  |
| ---------- | ------------------------------- | --------------------------------------------- |
| **bus** | Communication, claims, presence | `send`, `inbox`, `claim`, `release`, `agents` |
| **maw**    | Isolated jj workspaces          | `ws create`, `ws merge`, `ws destroy`         |
| **br/bv**  | Work tracking + triage          | `ready`, `create`, `close`, `--robot-next`    |
| **crit**   | Code review                     | `review`, `comment`, `lgtm`, `block`          |
| **botty**  | Agent runtime                   | `spawn`, `kill`, `tail`, `snapshot`           |

## Cross-project feedback

The `#projects` registry on botbus tracks which tools belong to which projects:

```bash
# Find who owns a tool
bus inbox --agent $AGENT --channels projects --all | grep "tools:.*botty"

# File bugs in their repo
cd ~/src/botty
br create --title="Bug: ..." --type=bug --priority=2
bus send botty "Filed bd-xyz: description @botty-dev" -L feedback
```

See `packages/cli/docs/report-issue.md` for full workflow.
