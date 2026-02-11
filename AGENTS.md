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
- **beads-view** (`bv`) — Smart triage recommendations (`bv --robot-triage`, `bv --robot-next`)

## How the Whole System Works End-to-End

Understanding the full chain from "message arrives" to "agent does work" is critical for debugging and development.

### The Agent Spawn Chain

```
1. Message lands on a botbus channel (e.g., `bus send myproject "New task" -L task-request`)
2. botbus checks registered hooks (`bus hooks list`) for matching conditions
3. Matching hook fires → runs its command (typically `botty spawn ...`)
4. botty spawn creates a PTY session, runs `botbox run-agent` or `bun <script>.mjs`
5. The loop script starts iterating: triage → start → work → review → finish
6. Agent communicates back via `bus send`, updates beads via `br`, manages workspace via `maw`
```

### Hook Types That Trigger Agents

Registered during `botbox init` (and updated via migrations):

| Hook Type | Trigger | Spawns | Example |
|-----------|---------|--------|---------|
| **Router** (claim-based) | Any message on project channel, when no agent claimed | respond.mjs (universal router) | `bus hooks add --channel myproject --claim "agent://myproject-dev" ...` |
| **Reviewer** (mention-based) | `@myproject-security` mention | Reviewer agent | `bus hooks add --channel myproject --mention "myproject-security" ...` |

The router hook spawns `respond.mjs` which routes messages based on `!` prefixes:
- `!dev [msg]` — create bead + spawn dev-loop
- `!bead [desc]` — create bead (with dedup via `br search`)
- `!q [question]` — answer with sonnet
- `!qq [question]` — answer with haiku
- `!bigq [question]` — answer with opus
- `!q(model) [question]` — answer with explicit model
- No prefix — smart triage via haiku (chat → reply, question → conversation mode, work → bead + dev-loop)

Also accepts old-style `q:` / `qq:` / `big q:` / `q(model):` prefixes for backwards compatibility.

Hook commands use `botty spawn` with `--env-inherit` to forward environment variables (BOTBUS_CHANNEL, BOTBUS_MESSAGE_ID, BOTBUS_AGENT) to the spawned agent.

### Observing Agents in Action

```bash
botty list                    # See running agents
botty tail <name>             # Stream real-time agent output (primary debugging tool)
botty tail <name> --last 100  # See last 100 lines
botty kill <name>             # Stop a misbehaving agent
botty send <name> "message"   # Send input to agent's PTY

bus history <channel> -n 20   # See recent channel messages
bus statuses list             # See agent presence/status
bus claims list               # See all active claims
bus inbox --all               # See unread messages across all channels
```

`botty tail` is the primary way to see what an agent is doing, whether it's stuck, and what tools it's calling. This is how you evaluate the effectiveness of the entire tool suite.

## Companion Tools Deep Dive

### botbus (`bus`) — Messaging and Coordination

SQLite-backed channel messaging system. Default output is `text` format (concise, token-efficient). Use `--format json` when you need structured data for parsing.

**Core commands:**
- `bus send [--agent $AGENT] <channel> "message" [-L label]` — Post message to channel. Labels categorize messages (task-request, review-request, task-done, feedback, etc.)
- `bus inbox [--channels <ch>] [--mentions] [--mark-read]` — Check unread messages. `--mentions` checks all channels for @agent mentions. `--count-only` for just the count.
- `bus history <channel> [-n count] [--from agent] [--since time]` — Browse message history. Channel can also be passed as `-c/--channel <ch>`. `bus history projects` shows the project registry.
- `bus search <query> [-c channel]` — Full-text search (FTS5 syntax)
- `bus wait [-c channel] [--mention] [-L label] [-t timeout]` — Block until matching message arrives. Used by respond.mjs for follow-up conversations.
- `bus watch [-c channel] [--all]` — Stream messages in real-time

**Claims (advisory locks):**
- `bus claims stake --agent $AGENT "<uri>" [-m memo] [--ttl duration]` — Claim a resource
- `bus claims release --agent $AGENT [--all | "<uri>"]` — Release claims
- `bus claims list [--mine] [--agent $AGENT]` — List active claims
- Claim URI patterns: `bead://project/id`, `workspace://project/ws`, `agent://name`, `respond://name`

**Hooks (event triggers):**
- `bus hooks add --channel <ch> --cwd <dir> [--claim uri] [--mention name] [--ttl secs] <command>` — Register hook. `--cwd` is mandatory.
- `bus hooks list` — List registered hooks with their conditions
- `bus hooks remove <id>` — Remove a hook
- Hook matching: `--claim` fires when claim is available; `--mention` fires on @name in message

**Other:**
- `bus statuses set/clear/list` — Agent presence and status messages
- `bus generate-name` — Generate random agent names (used by dev-loop for worker dispatch)
- `bus whoami [--agent $AGENT]` — Show/verify agent identity

### maw — Multi-Agent Workspaces

Creates isolated jj working copies so multiple agents can edit files concurrently without conflicts.

**Core commands:**
- `maw ws create <name> [--random]` — Create workspace. Returns workspace name. Workspace files live at `ws/<name>/`. `--random` generates a random name.
- `maw ws list [--format json]` — List all workspaces with their status
- `maw ws merge <name> --destroy` — Squash-merge workspace commit into main and delete it. `--destroy` is required. **Never use on `default`.**
- `maw ws destroy <name>` — Delete workspace without merging. **Never use on `default`.**
- `maw exec <name> -- <command>` — Run any command inside a workspace (e.g., `maw exec myws -- jj describe -m "feat: ..."`)
- `maw ws status` — Comprehensive view of all workspaces, conflicts, and unmerged work
- `maw init` — Initialize maw in a project
- `maw upgrade` — Upgrade from v1 (`.workspaces/`) to v2 (`ws/`) layout
- `maw push` — Push changes to remote
- `maw doctor` — Validate maw configuration

**Critical rules:**
- **Never merge or destroy the default workspace.** It is the main working copy — other workspaces merge INTO it.
- Use `maw exec <ws> -- <command>` to run commands in workspace context (br, bv, crit, jj, cargo, etc.)
- Use `maw exec default -- br ...` for beads commands (always in default workspace)
- Use `maw exec <ws> -- crit ...` for review commands (always in the review's workspace)
- Workspace files are at `ws/<name>/` — use absolute paths for file operations
- Never `cd` into a workspace directory and stay there — it breaks cleanup when the workspace is destroyed
- Each workspace owns ONE jj commit. Only modify your own.

### botcrit (`crit`) — Code Review

Distributed code review system for jj. Reviews are tied to jj change IDs, with file-line-based comment threads and LGTM/BLOCK voting.

**Review lifecycle:**
```bash
maw exec $WS -- crit reviews create --agent $AGENT --title "..." --reviewers <name>  # Create review + assign reviewer
maw exec $WS -- crit reviews request <id> --reviewers <name> --agent $AGENT  # Re-assign reviewer (after fixes)
maw exec $WS -- crit review <id> [--format json] [--since time]  # Show full review with threads
maw exec $WS -- crit comment --file <path> --line <n> <review-id> "msg"  # Add line comment
maw exec $WS -- crit reply <thread-id> "message"                 # Reply to existing thread
maw exec $WS -- crit lgtm <review-id> [-m "message"]             # Approve
maw exec $WS -- crit block <review-id> --reason "..."            # Block (request changes)
maw exec default -- crit reviews mark-merged <review-id>          # Mark as merged after workspace merge
maw exec $WS -- crit inbox --agent $AGENT                        # Show reviews/threads needing attention
```

**Key details:**
- Always run crit commands via `maw exec <ws> --` in the workspace context
- Reviewers iterate workspaces via `maw ws list` + `maw exec $WS -- crit inbox` per workspace
- Agent identity via `--agent` flag or `CRIT_AGENT`/`BOTBUS_AGENT` env vars
- `--user` flag switches to human identity ($USER) for manual reviews

### botty — Agent Runtime

PTY-based agent spawner and manager. Runs Claude Code sessions in managed PTY processes.

**Core commands:**
- `botty spawn [--pass-env] [--model model] [--timeout secs] <name> <command...>` — Spawn agent. `--pass-env` forwards BOTBUS_* env vars to the spawned process.
- `botty list [--format json]` — List running agents with PIDs and uptime
- `botty tail <name> [--last n] [--follow]` — Stream agent output. **Primary debugging tool.**
- `botty kill <name>` — Terminate agent
- `botty send <name> "message"` — Send text to agent's PTY stdin

### beads (`br`) — Issue Tracking

File-based issue tracker designed for crash recovery. Beads are stored in `.beads/` and synced via `br sync`.

**Core commands:**
- `br create --actor $AGENT --owner $AGENT --title="..." [--description="..."] [--type=task|bug|feature] [--priority=1-4]`
- `br ready` — List beads ready to work on (open, unblocked, unowned or owned by you)
- `br show <id>` — Full bead details with comments and dependencies
- `br update --actor $AGENT <id> --status=<open|in_progress|blocked|closed>`
- `br close --actor $AGENT <id> [--reason="..."] [--suggest-next]`
- `br comments add --actor $AGENT --author $AGENT <id> "message"`
- `br dep add --actor $AGENT <blocked-id> <blocker-id>` — Add dependency
- `br dep tree <id>` — Show dependency graph
- `br label add --actor $AGENT -l <label> <id>` — Add label
- `br sync --flush-only` — Flush local changes without full sync
- `bv --robot-triage` — JSON triage output with scores and recommendations
- `bv --robot-next` — Single best bead to work on next

**Priority levels:** P1 (critical/blocking) → P2 (normal) → P3 (nice-to-have) → P4 (backlog)

## Agent Loop Scripts

Scripts in `packages/cli/scripts/` are copied to target projects at `.agents/botbox/scripts/`. They are self-contained `.mjs` files (cannot import from `../src/lib/`).

### dev-loop.mjs — Lead Dev Agent

Triages work, dispatches parallel workers, monitors progress, merges completed work.

**Config:** `.botbox.json` → `agents.dev.{model, timeout, maxLoops, pause}`

**Per iteration:**
1. Read inbox, create beads from task requests
2. Check ready beads and in-progress work
3. For N >= 2 ready beads: dispatch Haiku workers in parallel via `botty spawn`
4. For single bead or when solo: work directly
5. Monitor worker progress, merge completed workspaces
6. Check for releases (feat/fix commits → version bump + tag)

**Dispatch pattern:** Creates workspace per worker, generates random worker name via `bus generate-name`, stakes claims, comments bead with worker/workspace info, spawns via `botty spawn`.

### agent-loop.mjs — Worker Agent

Sequential: one bead per iteration. Triage → start → work → review → finish.

**Config:** `.botbox.json` → `agents.worker.{model, timeout}`

**Per iteration:**
1. Resume check (crash recovery via bead comments)
2. Triage: inbox → create beads → `br ready` → pick one
3. Start: claim bead, create workspace, announce
4. Work: implement in workspace using absolute paths
5. Stuck check: 2 failed attempts = blocked, post and move on
6. Review: `crit reviews create`, request reviewer, STOP and wait
7. Finish: close bead, merge workspace (`maw ws merge --destroy`), release claims, sync
8. Release check: unreleased feat/fix → bump version

### reviewer-loop.mjs — Reviewer Agent

Processes reviews, votes LGTM or BLOCK, leaves severity-tagged comments.

**Config:** `.botbox.json` → `agents.reviewer.{model, timeout, maxLoops, pause}`

**Role detection:** Agent name suffix determines role (e.g., `myproject-security` → loads `reviewer-security.md` prompt). Falls back to generic `reviewer.md`.

**Per iteration:**
1. Iterate workspaces via `maw ws list`, check `maw exec $WS -- crit inbox` per workspace
2. Read review diff and source files from workspace (`ws/$WS/...`)
3. Comment with severity: CRITICAL, HIGH, MEDIUM, LOW, INFO
4. Vote: BLOCK if CRITICAL/HIGH issues, LGTM otherwise
5. Post summary to project channel

**Journal:** Maintains `.agents/botbox/review-loop-<role>.txt` with iteration summaries.

### respond.mjs — Universal Message Router

THE single entrypoint for all project channel messages. Routes based on `!` prefixes, maintains conversation context across turns, and can escalate to dev-loop mid-conversation.

**Commands:** `!dev` → dev-loop, `!bead` → create bead, `!q`/`!qq`/`!bigq`/`!q(model)` → question answering, no prefix → haiku triage (chat/question/work)

**Flow:** Fetch message → route by prefix → dispatch to handler. Question mode enters a conversation loop with transcript buffer. Triage classifies bare messages and routes accordingly. Mid-conversation escalation creates a bead with conversation context and spawns dev-loop.

**Config:** `.botbox.json` → `agents.responder.{model, timeout, wait_timeout, max_conversations}`

### triage.mjs — Token-Efficient Triage

Wraps `bv --robot-triage` JSON into scannable output: top picks, blockers, quick wins, health metrics.

### iteration-start.mjs — Combined Status

Aggregates inbox, ready beads, pending reviews, active claims into a single status snapshot at iteration start.

## Script Eligibility

Scripts are only deployed if the project has the required tools enabled:

| Script | Requires |
|--------|----------|
| `agent-loop.mjs`, `dev-loop.mjs` | beads + maw + crit + botbus |
| `reviewer-loop.mjs` | crit + botbus |
| `respond.mjs` | botbus |
| `triage.mjs` | beads |
| `iteration-start.mjs` | beads + crit + botbus |

Registry: `src/lib/scripts.mjs` → `SCRIPT_REGISTRY`

## Claude Code Hooks

Shell scripts in `packages/cli/hooks/`, copied to `.agents/botbox/hooks/`, registered in `.claude/settings.json`:

| Hook | Event | Requires | Purpose |
|------|-------|----------|---------|
| `init-agent.sh` | SessionStart | botbus | Display agent identity from `.botbox.json` (defaultAgent, channel) |
| `check-jj.sh` | SessionStart | maw | Remind agent to use jj; display workspace tips |
| `check-bus-inbox.sh` | PostToolUse | botbus | Check for unread bus messages, inject reminder with previews |

Registry: `src/lib/hooks.mjs` → `HOOK_REGISTRY`

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
- **AGENTS.md managed section** — regenerated from templates (between `<!-- botbox:managed-start/end -->` markers)
- **Loop scripts** (`.agents/botbox/scripts/*.mjs`) — copied based on enabled tools
- **Prompts** (`.agents/botbox/prompts/*.md`) — reviewer prompt templates
- **Claude Code hooks** (`.agents/botbox/hooks/*.sh`) — shell scripts for Claude Code events
- **Design docs** (`.agents/botbox/design/*.md`) — copied based on project type
- **Config migrations** (`.botbox.json`) — runs pending migrations

Each component is version-tracked via SHA-256 content hashes stored in marker files (`.version`, `.scripts-version`, `.hooks-version`, `.prompts-version`, `.design-docs-version`). Sync detects staleness by comparing installed hash vs current bundled hash.

### Migrations

**Botbus hooks** (registered via `bus hooks add`) and other runtime changes are managed through **migrations**, not direct sync logic.

Migrations live in `src/migrations/index.mjs`. Each has:
- `id`: Semantic version (e.g., "1.0.5")
- `title`: Short description
- `up(ctx)`: Migration function with access to `{ projectDir, agentsDir, configPath, config, log, warn }`

Migrations run automatically during `botbox sync` when the config version is behind. **When adding new botbus hook types or changing runtime behavior, add a migration.**

Current migrations: 1.0.1 (move scripts to .agents/), 1.0.2 (.sh → .mjs scripts), 1.0.3 (update botbus hooks to .mjs), 1.0.4 (add defaultAgent/channel to config), 1.0.5 (add respond hook for @dev mentions), 1.0.6 (add --pass-env to botty spawn hooks), 1.0.10 (rename snake_case config keys to camelCase), 1.0.12 (update hook cwd for maw v2), 1.0.14 (use bare repo root for hook CWDs).

### Init vs Sync

**`botbox init`** does everything: interactive config, creates `.agents/botbox/`, copies all files, generates AGENTS.md + CLAUDE.md symlink + `.botbox.json`, initializes external tools (`br init`, `maw init`, `crit init`), registers botbus hooks, seeds initial beads, creates .gitignore.

**`botbox sync`** is incremental: checks staleness, runs pending migrations, updates only changed components, preserves user edits outside managed markers. `--check` mode exits non-zero without changing anything (CI use).

## .botbox.json Config

```json
{
  "version": "1.0.6",
  "project": {
    "name": "myproject",
    "type": ["cli"],
    "defaultAgent": "myproject-dev",
    "channel": "myproject",
    "installCommand": "just install"
  },
  "tools": { "beads": true, "maw": true, "crit": true, "botbus": true, "botty": true },
  "review": { "enabled": true, "reviewers": ["security"] },
  "pushMain": false,
  "agents": {
    "dev": { "model": "opus", "maxLoops": 20, "pause": 2, "timeout": 900,
      "missions": { "enabled": false, "maxWorkers": 4, "maxChildren": 12, "checkpointIntervalSec": 30 }
    },
    "worker": { "model": "haiku", "timeout": 600 },
    "reviewer": { "model": "opus", "maxLoops": 20, "pause": 2, "timeout": 600 },
    "responder": { "model": "sonnet", "timeout": 300, "wait_timeout": 300, "max_conversations": 10 }
  }
}
```

Mission config is read from `agents.dev.missions`. `enabled` defaults to false for safe rollout. `maxWorkers` limits concurrent worker agents per mission, `maxChildren` caps the number of child beads, and `checkpointIntervalSec` controls how often the dev-loop persists mission state.

Scripts read `project.defaultAgent` and `project.channel` on startup, making CLI args optional.

## Botbox Release Process

Changes to workflow docs, scripts, prompts, or templates require a release:

1. **Make changes** in `packages/cli/`
2. **Add migration** if behavior changes (see `src/migrations/index.mjs`)
3. **Run tests**: `bun test` — version hashes auto-update
4. **Commit and push** to main
5. **Tag and push**: `maw release vX.Y.Z`
6. **Install locally**: `maw exec default -- just install`

Use semantic versioning and conventional commits. See [packages/cli/AGENTS.md](packages/cli/AGENTS.md) for component details.

## Repository Structure

```
packages/cli/          @botbox/cli — the main CLI (commander + inquirer)
  ├── src/
  │   ├── commands/    init.mjs, sync.mjs, doctor.mjs, status.mjs, run-agent.mjs
  │   ├── lib/         docs.mjs, templates.mjs, scripts.mjs, hooks.mjs, design-docs.mjs,
  │   │                prompts.mjs, config.mjs, errors.mjs, jj.mjs
  │   └── migrations/  index.mjs (versioned migrations)
  ├── docs/            Workflow docs (bundled, copied to target projects)
  ├── scripts/         Loop scripts (agent-loop.mjs, dev-loop.mjs, etc.)
  ├── hooks/           Claude Code hooks (init-agent.sh, check-jj.sh, check-bus-inbox.sh)
  └── prompts/         Reviewer prompts (reviewer.md, reviewer-security.md)
packages/botbox/       botbox — npm alias that re-exports @botbox/cli
scripts/               Shell launchers (symlinks to package scripts)
evals/                 Behavioral eval framework: rubrics, scripts, results
notes/                 Extended docs (eval-framework.md, migration-system.md, workflow-docs-maintenance.md)
.beads/                Issue tracker (beads)
```

**Why two packages?** `@botbox/cli` is the scoped package with all the code. `botbox` is an unscoped alias so users can run `npx botbox init` without the `@` prefix.

## Development

Runtime: **bun** (not node). Tooling: **oxlint** (lint), **oxfmt** (format), **tsc** (type check via jsconfig.json).

```bash
maw exec default -- just install    # bun link from workspace
maw exec default -- just lint       # oxlint
maw exec default -- just fmt        # oxfmt --write
maw exec default -- just check      # tsc -p jsconfig.json
maw exec default -- bun test        # run tests (packages/cli/)
```

All source is `.mjs` with JSDoc type annotations — no build step. Types are enforced by `tsc --checkJs` with strict settings.

## Testing

**Automated tests**: Run `bun test` - these use isolated environments automatically.

**Manual testing**: ALWAYS use isolated data directories to avoid polluting actual project data:

```bash
BOTBUS_DATA_DIR=/tmp/test-botbus botbox init --name test --type cli --tools beads,maw,crit,botbus --no-interactive
BOTBUS_DATA_DIR=/tmp/test-botbus bus hooks list
rm -rf /tmp/test-botbus
```

**Applies to**: Any manual testing with bus, botty, crit, maw, or br commands during development.

## Conventions

- **Version control: jj** (not git). Use `jj describe -m "message"` to set commit messages and `jj new` to finalize. Never use `git commit`. Run `maw jj-intro` for a git-to-jj quick reference.
- `let` for all variables, `const` only for true constants (module-level, unchanging values)
- No build step — `.mjs` + JSDoc everywhere
- Tests use `bun:test` — colocated as `*.test.mjs` next to source
- Strict linting (oxlint with correctness + suspicious as errors)
- Commands throw `ExitError` instead of calling `process.exit()` directly
- All commits include the trailer `Co-Authored-By: Claude <noreply@anthropic.com>` when Claude contributes

## Debugging and Troubleshooting

### "Look at the botty session for X"

When asked to look at a botty session, immediately run `botty tail <name> --last 200` to see recent output from that agent. This is the primary workflow for:
- Checking if an agent is stuck or making progress
- Identifying tool failures or protocol violations
- Finding improvement opportunities in the tool suite
- Understanding what the agent tried and where it went wrong

Drop whatever you're doing and run the tail command. Analyze the output and report what the agent is doing, whether it's stuck, and what might need fixing.

### Agent not spawning
1. Check hook registration: `bus hooks list` — is the router hook there? Does the channel match? It should point to `respond.mjs`.
2. Check claim availability: `bus claims list` — is the `agent://X-dev` claim already taken? (router hook won't fire if claimed)
3. Check botty: `botty list` — is the agent already running?
4. Verify hook command: the hook should run `botty spawn` with correct script path and `--env-inherit`

### Agent stuck or looping
1. `botty tail <name>` — what is the agent doing right now?
2. Check claims: `bus claims list --mine --agent <name>` — stuck claim?
3. Check bead state: `br show <id>` — is the bead in expected status?
4. Check workspace: `maw ws list` — is workspace still alive?

### Review not being picked up
1. `maw exec $WS -- crit inbox --agent <reviewer>` — does it show the review? (check each workspace)
2. Verify the @mention: the bus message MUST contain `@<project>-<role>` (no @ prefix in hook registration, but @ in message)
3. Check hook: `bus hooks list` — is there a mention hook for that reviewer?
4. Verify reviewer workspace path: reviewer reads code from workspace, not project root

### Common pitfalls from evals
- **Workspace path**: Workspace files are at `ws/$WS/`. Use absolute paths for file operations. Never `cd` into workspace.
- **Re-review**: Reviewers must read from workspace path (`ws/$WS/`) to see fixed code, not main
- **Duplicate beads**: Check existing beads before creating from inbox messages
- **br/bv via maw exec**: Always use `maw exec default -- br ...` — never run `br` directly
- **crit via maw exec**: Always use `maw exec $WS -- crit ...` — crit runs in workspace context
- **Mention format**: `--mention "agent-name"` in hook registration (no @), but `@agent-name` in bus messages

## Eval Framework

Behavioral eval framework for testing agent protocol compliance. See [notes/eval-framework.md](notes/eval-framework.md) for run history, results, and instructions.

Eval types: L2 (single session), Agent Loop, R1 (reviewer bugs), R2 (author response), R3 (full review loop), R4 (integration), R5 (cross-project), R6 (parallel dispatch), R7 (planning), R8 (adversarial review), R9 (crash recovery).

Eval scripts in `evals/scripts/` use `BOTBUS_DATA_DIR` for isolation. Rubrics in `evals/rubrics.md`.

## Proposals

For significant features or changes, use the formal proposal process before implementation.

**Lifecycle**: PROPOSAL → VALIDATING → ACCEPTED/REJECTED

1. Create a bead with `proposal` label and draft doc in `./notes/proposals/<slug>.md`
2. Validate by investigating open questions, moving answers to "Answered Questions"
3. Accept (remove label, create implementation beads) or Reject (document why)

See [proposal.md](.agents/botbox/proposal.md) for full workflow.

## Output Formats

All companion tools support output formats via `--format`:
- **text** (default for agents/pipes) — Concise, structured plain text. ID-first records, two-space delimiters, no prose. Token-efficient and parseable by convention.
- **pretty** (default for TTY) — Tables, color, box-drawing. For humans at a terminal. Never fed to LLMs or parsed.
- **json** (machines) — Structured output. Always an object envelope (never bare arrays) with an `advice` array for warnings/suggestions.

Format auto-detection: `--format` flag > `FORMAT` env > TTY→pretty / non-TTY→text. Agents always get `text` unless they explicitly request `--format json`.

## Message Labels

Labels on bus messages categorize intent: `task-request`, `task-claim`, `task-blocked`, `task-done`, `review-request`, `review-done`, `review-response`, `feedback`, `grooming`, `tool-issue`, `agent-idle`, `spawn-ack`, `agent-error`.

<!-- botbox:managed-start -->
## Botbox Workflow

**New here?** Read [worker-loop.md](.agents/botbox/worker-loop.md) first — it covers the complete triage → start → work → finish cycle.

**All tools have `--help`** with usage examples. When unsure, run `<tool> --help` or `<tool> <command> --help`.

### Directory Structure (maw v2)

This project uses a **bare repo** layout. Source files live in workspaces under `ws/`, not at the project root.

```
project-root/          ← bare repo (no source files here)
├── ws/
│   ├── default/       ← main working copy (AGENTS.md, .beads/, src/, etc.)
│   ├── frost-castle/  ← agent workspace (isolated jj commit)
│   └── amber-reef/    ← another agent workspace
├── .jj/               ← jj repo data
├── .git/              ← git data (core.bare=true)
├── AGENTS.md          ← stub redirecting to ws/default/AGENTS.md
└── CLAUDE.md          ← symlink → AGENTS.md
```

**Key rules:**
- `ws/default/` is the main workspace — beads, config, and project files live here
- **Never merge or destroy the default workspace.** It is where other branches merge INTO, not something you merge.
- Agent workspaces (`ws/<name>/`) are isolated jj commits for concurrent work
- Use `maw exec <ws> -- <command>` to run commands in a workspace context
- Use `maw exec default -- br|bv ...` for beads commands (always in default workspace)
- Use `maw exec <ws> -- crit ...` for review commands (always in the review's workspace)
- Never run `br`, `bv`, `crit`, or `jj` directly — always go through `maw exec`

### Beads Quick Reference

| Operation | Command |
|-----------|---------|
| View ready work | `maw exec default -- br ready` |
| Show bead | `maw exec default -- br show <id>` |
| Create | `maw exec default -- br create --actor $AGENT --owner $AGENT --title="..." --type=task --priority=2` |
| Start work | `maw exec default -- br update --actor $AGENT <id> --status=in_progress --owner=$AGENT` |
| Add comment | `maw exec default -- br comments add --actor $AGENT --author $AGENT <id> "message"` |
| Close | `maw exec default -- br close --actor $AGENT <id>` |
| Add dependency | `maw exec default -- br dep add --actor $AGENT <blocked> <blocker>` |
| Sync | `maw exec default -- br sync --flush-only` |
| Triage (scores) | `maw exec default -- bv --robot-triage` |
| Next bead | `maw exec default -- bv --robot-next` |

**Required flags**: `--actor $AGENT` on mutations, `--author $AGENT` on comments.

### Workspace Quick Reference

| Operation | Command |
|-----------|---------|
| Create workspace | `maw ws create <name>` |
| List workspaces | `maw ws list` |
| Merge to main | `maw ws merge <name> --destroy` |
| Destroy (no merge) | `maw ws destroy <name>` |
| Run jj in workspace | `maw exec <name> -- jj <jj-args...>` |

**Avoiding divergent commits**: Each workspace owns ONE commit. Only modify your own.

| Safe | Dangerous |
|------|-----------|
| `maw ws merge <agent-ws> --destroy` | `maw ws merge default --destroy` (NEVER) |
| `jj describe` (your working copy) | `jj describe main -m "..."` |
| `maw exec <your-ws> -- jj describe -m "..."` | `jj describe <other-change-id>` |

If you see `(divergent)` in `jj log`:
```bash
jj abandon <change-id>/0   # keep one, abandon the divergent copy
```

**Working copy snapshots**: jj auto-snapshots your working copy before most operations (`jj new`, `jj rebase`, etc.). Edits go into the **current** commit automatically. To put changes in a **new** commit, run `jj new` first, then edit files.

**Always pass `-m`**: Commands like `jj commit`, `jj squash`, and `jj describe` open an editor by default. Agents cannot interact with editors, so always pass `-m "message"` explicitly.

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
maw exec $WS -- crit reviews request <review-id> --reviewers $PROJECT-security --agent $AGENT
bus send --agent $AGENT $PROJECT "Review requested: <review-id> @$PROJECT-security" -L review-request
```

The @mention triggers the auto-spawn hook for the reviewer.

### Cross-Project Communication

**Don't suffer in silence.** If a tool confuses you or behaves unexpectedly, post to its project channel.

1. Find the project: `bus history projects -n 50` (the #projects channel has project registry entries)
2. Post question or feedback: `bus send --agent $AGENT <project> "..." -L feedback`
3. For bugs, create beads in their repo first
4. **Always create a local tracking bead** so you check back later:
   ```bash
   maw exec default -- br create --actor $AGENT --owner $AGENT --title="[tracking] <summary>" --labels tracking --type=task --priority=3
   ```

See [cross-channel.md](.agents/botbox/cross-channel.md) for the full workflow.

### Session Search (optional)

Use `cass search "error or problem"` to find how similar issues were solved in past sessions.


### Design Guidelines

- [CLI tool design for humans, agents, and machines](.agents/botbox/design/cli-conventions.md)

### Workflow Docs

- [Ask questions, report bugs, and track responses across projects](.agents/botbox/cross-channel.md)
- [Close bead, merge workspace, release claims, sync](.agents/botbox/finish.md)
- [groom](.agents/botbox/groom.md)
- [Verify approval before merge](.agents/botbox/merge-check.md)
- [Turn specs/PRDs into actionable beads](.agents/botbox/planning.md)
- [Validate toolchain health](.agents/botbox/preflight.md)
- [Create and validate proposals before implementation](.agents/botbox/proposal.md)
- [Report bugs/features to other projects](.agents/botbox/report-issue.md)
- [Reviewer agent loop](.agents/botbox/review-loop.md)
- [Request a review](.agents/botbox/review-request.md)
- [Handle reviewer feedback (fix/address/defer)](.agents/botbox/review-response.md)
- [Explore unfamiliar code before planning](.agents/botbox/scout.md)
- [Claim bead, create workspace, announce](.agents/botbox/start.md)
- [Find work from inbox and beads](.agents/botbox/triage.md)
- [Change bead status (open/in_progress/blocked/done)](.agents/botbox/update.md)
- [Full triage-work-finish lifecycle](.agents/botbox/worker-loop.md)
<!-- botbox:managed-end -->
