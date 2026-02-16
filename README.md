# botbox

![botbox utopia](images/botbox-utopia.webp)

Setup, sync, and runtime for multi-agent workflows. Bootstraps projects, keeps workflow docs in sync, and runs agent loops with built-in protocol guidance.

## Eval Results

32 behavioral evaluations across Opus, Sonnet, and Haiku. The eval framework tests whether agents follow the botbox protocol when driven autonomously through the botty-native spawn chain (hooks → botty spawn → loop scripts).

| Eval | Model | Score | What it tests |
|------|-------|-------|---------------|
| **E11-L3** | Opus | 133/140 (95%) | Full lifecycle: 2 projects, 3 agents, cross-project coordination, security review cycle — all from a single task-request |
| **E10** | Opus+Sonnet | 159/160 (99%) | 8-phase scripted lifecycle: 2 projects, 3 agents, cross-project bug discovery, review block/fix/LGTM |
| **E11-L2** | Opus | 97/105 (92%) | Botty-native dev + reviewer: single project, review cycle through real hooks |
| **R5** | Opus | 70/70 (100%) | Cross-project coordination: file bugs in external projects via bus channels |
| **R4** | Sonnet | 95/95 (100%) | Integration: full triage → work → review → merge lifecycle |
| **R8** | Opus | 49/65 (75%) | Adversarial review: multi-file security bugs requiring cross-file reasoning |

**Takeaway**: The full autonomous pipeline works. Agents spawn via hooks, coordinate across projects via bus channels, review each other's code via crit, and merge work through maw — all without human intervention. Friction comes from CLI typos, not protocol failures. See [evals/results/](evals/results/README.md) for all 32 runs and detailed findings.

## What is botbox?

`botbox` is a Rust CLI that:

1. **Initializes projects** for multi-agent collaboration (interactive or via flags)
2. **Syncs workflow docs** from a canonical source to `.agents/botbox/`
3. **Validates health** via `doctor` command
4. **Runs agent loops** as built-in subcommands (`dev-loop`, `worker-loop`, `reviewer-loop`, `responder`)
5. **Provides protocol commands** that guide agents through state transitions (`protocol start`, `merge`, `finish`, etc.)

It glues together 5 companion tools (bus, maw, br/bv, crit, botty) into a cohesive workflow and provides the runtime that drives agent behavior.

## Install

```bash
cargo install --path .
# or from a release:
cargo install botbox
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

# Run agent loops (typically invoked by botty spawn, not manually)
botbox run dev-loop --agent myproject-dev
botbox run worker-loop --agent myproject-dev/worker-1
botbox run reviewer-loop --agent myproject-security

# Protocol commands — check state and get guidance at transitions
botbox protocol start <bead-id> --agent $AGENT
botbox protocol merge <workspace> --agent $AGENT
botbox protocol finish <bead-id> --agent $AGENT
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

Agents are spawned automatically via botbus hooks when messages arrive on project channels. The spawn chain:

```
message → botbus hook → botty spawn → botbox run responder → botbox run dev-loop
```

Agent loops are built-in subcommands of the `botbox` binary:

- **`botbox run responder`** — Universal router. Routes `!dev`, `!q`, `!bead` prefixes; triages bare messages.
- **`botbox run dev-loop`** — Lead dev. Triages work, dispatches parallel workers, monitors progress, merges.
- **`botbox run worker-loop`** — Worker. Sequential: triage → start → work → review → finish.
- **`botbox run reviewer-loop`** — Reviewer. Processes crit reviews, votes LGTM or BLOCK.

No manual agent management needed — send a message to a project channel and the hook chain handles the rest.

## Ecosystem

Botbox coordinates five specialized Rust tools that work together to enable multi-agent workflows:

| Tool       | Purpose                         | Key commands                                  | Repository |
| ---------- | ------------------------------- | --------------------------------------------- | ---------- |
| **[botbus](https://github.com/bobisme/botbus)** | Communication, claims, presence | `send`, `inbox`, `claim`, `release`, `agents` | Pub/sub messaging, resource locking, agent registry |
| **[maw](https://github.com/bobisme/maw)**    | Isolated jj workspaces          | `ws create`, `ws merge`, `ws destroy`         | Concurrent work isolation with Jujutsu VCS |
| **[beads](https://github.com/bobisme/beads)**  | Work tracking (`br`)            | `ready`, `create`, `close`, `update`          | Issue tracker optimized for agent triage |
| **[beads-tui](https://github.com/Dicklesworthstone/beads_viewer)** | Triage interface (`bv`)         | `--robot-triage`, `--robot-next`              | PageRank-based prioritization, graph analysis |
| **[crit](https://github.com/bobisme/crit)**   | Code review                     | `review`, `comment`, `lgtm`, `block`          | Asynchronous code review workflow |
| **[botty](https://github.com/bobisme/botty)**  | Agent runtime                   | `spawn`, `kill`, `tail`, `snapshot`           | Process management for AI agent loops |

### Flywheel connection

Botbox is inspired by and shares tools with the [Agentic Coding Flywheel](https://agent-flywheel.com) ecosystem. We use the same `br` ([beads_rust](https://github.com/Dicklesworthstone/beads_rust)) for issue tracking and `bv` ([beads_viewer](https://github.com/Dicklesworthstone/beads_viewer)) for triage. The built-in `botbox run triage` command wraps `bv --robot-triage` to provide token-efficient work prioritization using PageRank-based analysis.

### How they work together

1. **botbus** provides the communication layer: agents send messages, claim resources (beads, workspaces), and discover each other
2. **beads** tracks work items and priorities, exposing a triage interface (`br ready`, `bv --robot-next`)
3. **maw** creates isolated workspaces so multiple agents can work concurrently without conflicts
4. **crit** enables code review: agents request reviews, reviewers comment, and changes merge after approval
5. **botty** spawns and manages agent processes, handling crashes and lifecycle

**botbox** configures projects to use these tools, keeps workflow docs synchronized, and runs the agent loops (`botbox run dev-loop`, `botbox run worker-loop`, etc.) that drive the entire workflow.

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

See `.agents/botbox/report-issue.md` for full workflow.
