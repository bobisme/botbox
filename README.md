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

## Ecosystem

Botbox coordinates five specialized Rust tools that work together to enable multi-agent workflows:

| Tool       | Purpose                         | Key commands                                  | Repository |
| ---------- | ------------------------------- | --------------------------------------------- | ---------- |
| **[botbus](https://github.com/StandardInput/botbus)** | Communication, claims, presence | `send`, `inbox`, `claim`, `release`, `agents` | Pub/sub messaging, resource locking, agent registry |
| **[maw](https://github.com/StandardInput/maw)**    | Isolated jj workspaces          | `ws create`, `ws merge`, `ws destroy`         | Concurrent work isolation with Jujutsu VCS |
| **[beads](https://github.com/StandardInput/beads)**  | Work tracking (`br`)            | `ready`, `create`, `close`, `update`          | Issue tracker optimized for agent triage |
| **[beads-tui](https://github.com/Dicklesworthstone/beads_viewer)** | Triage interface (`bv`)         | `--robot-triage`, `--robot-next`              | PageRank-based prioritization, graph analysis |
| **[crit](https://github.com/StandardInput/crit)**   | Code review                     | `review`, `comment`, `lgtm`, `block`          | Asynchronous code review workflow |
| **[botty](https://github.com/StandardInput/botty)**  | Agent runtime                   | `spawn`, `kill`, `tail`, `snapshot`           | Process management for AI agent loops |

### Flywheel connection

Botbox is inspired by and shares tools with the [Agentic Coding Flywheel](https://agent-flywheel.com) ecosystem. We use the same `br` ([beads_rust](https://github.com/Dicklesworthstone/beads_rust)) for issue tracking and `bv` ([beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)) for triage. Our `triage.mjs` script wraps `bv --robot-triage` to provide token-efficient work prioritization using PageRank-based analysis.

### How they work together

1. **botbus** provides the communication layer: agents send messages, claim resources (beads, workspaces), and discover each other
2. **beads** tracks work items and priorities, exposing a triage interface (`br ready`, `bv --robot-next`)
3. **maw** creates isolated workspaces so multiple agents can work concurrently without conflicts
4. **crit** enables code review: agents request reviews, reviewers comment, and changes merge after approval
5. **botty** spawns and manages agent processes, handling crashes and lifecycle

**botbox** doesn't run these tools—it configures projects to use them and keeps workflow docs synchronized.

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
