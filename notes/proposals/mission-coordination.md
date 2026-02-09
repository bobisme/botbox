# Proposal: Mission-Aware Agent Coordination

**Status**: ACCEPTED
**Bead**: bd-9uri
**Author**: botbox-dev
**Date**: 2026-02-09

## Summary

Botbox agents work well on independent tasks but have no framework for coordinated multi-task efforts. When a feature requires 5 related beads, each worker operates in isolation — there's no shared context, no risk-proportional review, no checkpoints, and no way for workers to coordinate with each other. This proposal adds **mission beads**, **risk labels**, **hierarchical agent spawning via botty**, and **peer coordination through bus** to unlock true team-based work without rigid script rails.

## Scope and Success Criteria

### Goals (v1)

1. Coordinate related beads under a mission with explicit shared outcome and constraints.
2. Reduce lead time for multi-bead features while preserving observability through botty/bus.
3. Apply risk-proportional verification so low-risk work does not pay high review overhead.

### Non-Goals (v1)

- Replacing beads, bus, maw, crit, or botty data models.
- Building a new UI/dashboard for mission management.
- Cross-project mission orchestration (single project/channel only).
- Formal SLOs or telemetry infrastructure (defer until missions are proven in practice).

### Success Criteria

- Missions with 3+ children complete with all invariants intact (parent dep + `mission:<id>` label on every child).
- `risk:low` beads skip review without regressions.
- `risk:critical` merges always have auditable human approval evidence on the bead.
- Dev-loop successfully dispatches, checkpoints, and merges a multi-worker mission end-to-end in eval.

## Motivation

The current system handles "5 independent bugs" well but struggles with "1 feature that spans 5 tasks":

1. **No shared context.** Workers dispatched by dev-loop don't know they're part of a coordinated effort. Each gets a bead and a workspace but no mission-level outcome, constraints, or success criteria.

2. **Uniform review overhead.** Every bead gets identical security review. A typo fix burns the same reviewer tokens as a database migration. There's no way to say "this is low-risk, skip review" or "this is high-risk, add adversarial review."

3. **No checkpoints.** Dev-loop monitors individual workers but doesn't assess aggregate mission progress. There's no "we're 60% done with 30% budget remaining — should we cut scope?"

4. **No peer coordination.** Workers can't talk to each other. If worker-A builds an API that worker-B needs to consume, B has no way to ask A about the interface. Everything routes through dev-loop.

5. **Rigid dispatch model.** Dev-loop dispatches via `botty spawn` but the dispatch is fire-and-forget per bead. There's no parent-child relationship between the lead and its workers, and Claude Code's built-in subagent feature doesn't go through botty (losing observability via `botty tail`).

These gaps become painful for any non-trivial feature work: refactoring efforts, new subsystems, multi-component changes.

## Proposed Design

### Design Principles

- **Labels over schema changes.** New bead metadata uses labels (`risk:high`, `mission:bd-xxx`) rather than new fields. Labels are already supported, searchable, and require no migration.
- **botty spawn over Claude Code subagents.** All agent spawning goes through `botty spawn`. This gives us `botty tail` observability, `botty kill` control, `botty list` visibility, and the `--after`/`--wait-for` orchestration primitives. Claude Code's built-in Task tool spawns invisible processes we can't observe or manage.
- **Hierarchical agent names.** When `botbox-dev` spawns a worker `amber-reef`, the worker's identity is `botbox-dev/amber-reef`. This uses botty/bus's native slash support. Claims, messages, and statuses all naturally namespace under the parent.
- **Bus for coordination, not scripts.** Rather than encoding coordination logic in script prompts, agents coordinate through bus messages, claims, and labels. Scripts provide the loop structure; bus provides the communication fabric.

### 0. Execution Levels

Missions are a new level on top of existing behavior, not a replacement. The responder and dev-loop already handle levels 1-3. Level 4 is what this proposal adds.

| Level | Name | Who decides | How it works today | What changes |
|-------|------|------------|-------------------|-------------|
| 1 | Conversation | respond.mjs | `!q`/triage → answer + follow-up loop | Nothing |
| 2 | Sequential dev | dev-loop | 1 ready bead → lead works on it directly | Risk-aware review added |
| 3 | Parallel dispatch | dev-loop | 2+ independent ready beads → spawn workers per bead | Hierarchical names, botty spawn |
| 4 | Mission | dev-loop | Large coherent task → plan, create mission bead, dispatch coordinated workers | **New** |

**Level selection is a judgment call by the dev-loop agent**, not hardcoded logic. The dev-loop prompt includes guidance on when each level applies:

- **Level 2 (sequential):** One small, clear bead. Or multiple beads but they're tightly coupled (same files, must be done in order).
- **Level 3 (parallel):** Multiple independent beads that don't relate to each other. Different bugs, unrelated features. No shared outcome or constraints. This is the existing dispatch model.
- **Level 4 (mission):** A large task that needs decomposition into related beads with shared context. Signals: the task mentions multiple components, the description is a spec/PRD, the human explicitly asks for coordinated work, or the beads share a common feature/goal. The agent creates a mission bead, plans the decomposition, then dispatches workers with mission context.

**Key distinction between level 3 and 4:** Level 3 dispatches workers for *pre-existing independent beads*. Level 4 *creates the beads as part of planning* under a mission envelope. A level 3 dispatch has no shared context between workers. A level 4 mission gives every worker the mission outcome, constraints, and sibling awareness.

**Existing behavior is preserved.** If `missionsEnabled` is false (or the agent judges level 2/3 is sufficient), behavior is identical to today. Missions are additive.

**Explicit human trigger:** respond.mjs gets a new `!mission <description>` prefix that creates a mission bead directly and spawns dev-loop with `BOTBOX_MISSION` set. This lets humans force level 4 when they know the task warrants it. Without the prefix, the dev-loop agent decides.

### 1. Mission Beads

A **mission bead** is a regular bead with the `mission` label that acts as an envelope for related work.

```bash
# Create a mission
br create --actor $AGENT --owner $AGENT \
  --title="Add OAuth login support" \
  --labels mission \
  --type=task --priority=2 \
  --description="Outcome: Users can log in via Google OAuth.
Success metric: OAuth login flow works end-to-end with tests passing.
Constraints: No new dependencies beyond google-auth-library.
Stop criteria: Login flow works; token refresh is out of scope for now."
```

The mission description follows a structured format:
- **Outcome**: One sentence — what does "done" look like?
- **Success metric**: How do we verify the outcome?
- **Constraints**: Budget, forbidden actions, scope boundaries
- **Stop criteria**: When to stop even if not everything is done

Child beads use `--parent`:

```bash
br create --actor $AGENT --owner $AGENT \
  --title="Add OAuth callback handler" \
  --parent bd-xxx \
  --labels "mission:bd-xxx" \
  --type=task --priority=2
```

The `--parent` flag wires up the dependency automatically. The `mission:bd-xxx` label lets any agent query for siblings:

```bash
br list --label "mission:bd-xxx"  # all beads in this mission
```

**What missions enable:**
- Workers dispatched for a mission get the mission description in their prompt context (outcome, constraints, stop criteria)
- Dev-loop can assess aggregate progress: "4/6 children closed, 1 blocked, 1 in-progress"
- Checkpoint logic triggers when a mission has active workers
- Mission close requires all children closed (enforced by the parent dep)

**Mission invariants (must hold at all times):**
1. Every child bead has exactly one `mission:<id>` label matching its `--parent`.
2. A child bead belongs to at most one mission.
3. Mission bead cannot close while any child is not `closed`.
4. At most one active worker assignment per child bead (enforced by bead claims).

**Crash-recovery policy for missions:**
1. If a worker exits unexpectedly (detected via `botty list` — process gone but bead still in_progress), dev-loop records failure in a bead comment.
2. Dev-loop performs one automatic reassignment: new worker name, same workspace (if it still exists) or new workspace.
3. On second failure for the same child, the child becomes `blocked` with a comment explaining the repeated failure. Requires explicit lead intervention.
4. Recovery actions are included in checkpoint summaries for visibility.

### 2. Risk Labels

Every bead gets a risk label that controls verification requirements. Default is `risk:medium` (current behavior).

| Label | Meaning | Review behavior |
|-------|---------|----------------|
| `risk:low` | Typo fixes, doc updates, config tweaks | Self-review only. No crit review needed. Merge directly. |
| `risk:medium` | Standard feature work, bug fixes | Standard crit review (current default). |
| `risk:high` | Security-sensitive, data integrity, user-visible behavior changes | Security review + failure-mode checklist required in review. |
| `risk:critical` | Irreversible actions, migrations, regulated changes | Human approval required. Post to bus, wait for explicit human go-ahead before merge. |

**Failure-mode checklist** (required for `risk:high` and above, included in reviewer prompt):
1. What could fail in production?
2. How would we detect it quickly?
3. What is the fastest safe rollback?
4. What dependency could invalidate this plan?
5. What assumption is least certain?

The reviewer must address all five questions in their review comments. This is a prompt change to `reviewer-security.md`, not a tool change.

**Assignment and governance:**
- Assign risk during planning/grooming using these dimensions: blast radius, data sensitivity, reversibility, dependency uncertainty.
- Any agent can escalate risk upward with a justification comment: `br label add --actor $AGENT -l risk:high <id>`.
- Risk downgrades require explicit lead approval (comment on the bead noting the downgrade and rationale).
- `risk:critical` merges require human approval. The human posts a bus message referencing the bead/review. The agent records the message ID in a bead comment as evidence before merging. Add `project.criticalApprovers` to `.botbox.json` so agents know who to ask.

**Self-review for low-risk:** When a bead has `risk:low`, the agent-loop skips the crit review step entirely — it merges the workspace directly after implementation and proceeds to finish. This saves significant time and tokens on trivial work.

**Evidence requirements by risk:**
- `risk:low`: self-review note in bead comment + relevant tests pass.
- `risk:medium`: crit review ID in bead comment + relevant tests pass.
- `risk:high`: security review + completed failure-mode checklist in review comments + rollback notes.
- `risk:critical`: all `risk:high` evidence + human approval message ID recorded on bead.

### 3. Hierarchical Agent Spawning via botty

Replace Claude Code subagent usage with `botty spawn` throughout. Adopt hierarchical naming with slashes.

**Naming convention:**

```
botbox-dev                    # lead dev agent
botbox-dev/amber-reef         # worker spawned by lead
botbox-dev/amber-reef/review  # reviewer spawned by worker (rare)
```

The parent sets `BOTBUS_AGENT` when spawning:

```bash
botty spawn \
  --name "botbox-dev/amber-reef" \
  --label worker \
  --label "mission:bd-xxx" \
  --env "BOTBUS_AGENT=botbox-dev/amber-reef" \
  --env "BOTBUS_CHANNEL=botbox" \
  --env "BOTBOX_MISSION=bd-xxx" \
  --env "BOTBOX_BEAD=bd-yyy" \
  --env "BOTBOX_WORKSPACE=amber-reef" \
  --timeout 600 \
  --cwd /path/to/project \
  -- bun .agents/botbox/scripts/agent-loop.mjs botbox
```

**What hierarchical names enable:**
- `botty list --label worker` — see all workers
- `botty list --label "mission:bd-xxx"` — see all agents for a mission
- `botty tail botbox-dev/amber-reef` — observe a specific worker
- `bus history botbox --from "botbox-dev/amber-reef"` — see a worker's messages
- Clear parent-child relationship in logs and statuses

**Claims namespace naturally:**

```bash
bus claims stake --agent "botbox-dev/amber-reef" "bead://botbox/bd-yyy"
bus claims stake --agent "botbox-dev/amber-reef" "workspace://botbox/amber-reef"
```

**Botty orchestration primitives:** botty already has `--after` (wait for agent to exit) and `--wait-for` (wait for output pattern). These enable sequencing:

```bash
# Spawn worker B after worker A's bead is ready
botty spawn --name "lead/worker-b" --after "lead/worker-a" -- ...
```

**How agents are actually spawned:**

The spawned command is `botbox run-agent claude -p <prompt>`, which calls `claude -p <prompt> --dangerously-skip-permissions --output-format stream-json`. The prompt is passed as a CLI argument.

For level 2/3 (sequential/parallel), the prompt is the same as today — the loop script builds it in JS and passes via `-p`. The prompts are ~4KB and well within CLI limits.

For level 4 (mission workers), the prompt adds mission context:
- Mission description (outcome/metric/constraints/stop-criteria): ~500 bytes
- Sibling bead list with owners: ~100 bytes per sibling
- File ownership hints: ~500 bytes

Total mission-aware prompt: ~6-8KB. Linux `ARG_MAX` is typically 2MB+, so CLI args are fine for v1.

**If prompts outgrow CLI args:** Add `--prompt-file <path>` to `botbox run-agent` that reads the prompt from a temp file instead of `-p`. The loop script writes the prompt to a temp file, passes the path, and `run-agent` reads it and passes the content to `claude -p`. This is a straightforward change to `run-agent.mjs` and can be done when needed — not a blocker for v1.

**Full spawn chain for a mission worker:**

```
dev-loop.mjs (lead agent, running in botty PTY)
  → builds prompt string with mission context
  → calls: botty spawn --name "$AGENT/worker-name" \
      --label worker --label "mission:bd-xxx" \
      --env "BOTBUS_AGENT=$AGENT/worker-name" \
      --env "BOTBOX_MISSION=bd-xxx" \
      --env "BOTBOX_BEAD=bd-yyy" \
      --env "BOTBOX_WORKSPACE=amber-reef" \
      --timeout 600 --cwd $PROJECT_ROOT \
      -- botbox run-agent claude -p "$PROMPT" -m haiku -t 600
        → claude -p "$PROMPT" --dangerously-skip-permissions ...
          → agent works in workspace, uses bus/br/crit/maw
```

Observable at every level: `botty tail $AGENT/worker-name`, `botty list --label "mission:bd-xxx"`, `bus history $PROJECT --from "$AGENT/worker-name"`.

### 4. Peer Coordination via Bus

Workers on the same mission can communicate directly through bus. This is not a new feature — bus already supports targeted messaging. The change is in prompts and conventions.

**Mission-scoped messages:** Workers on a mission use the project channel with `mission:bd-xxx` labels for mission-scoped communication:

```bash
# Worker A announces its API shape
bus send --agent "$AGENT" "$PROJECT" \
  "API ready: POST /auth/callback accepts {code, state}, returns {token, user}" \
  -L "mission:bd-xxx"

# Worker B checks for sibling messages
bus history "$PROJECT" -n 20 -L "mission:bd-xxx"
```

**Label conventions for coordination messages:**

Workers add a coordination type label alongside the mission label:

| Label | Use |
|-------|-----|
| `-L coord:interface` | Announcing an API/interface shape for siblings to consume |
| `-L coord:blocker` | Requesting something from a sibling |
| `-L coord:handoff` | Handing off an artifact or intermediate result |
| `-L task-done` | Completion signal (existing label) |

Message bodies stay natural language — labels are the structured layer for filtering. No structured first-line format required.

**Coordination patterns:**

1. **Interface announcement.** Worker building an API posts the interface to bus before finishing. Sibling workers consuming the API can check `bus history $PROJECT -L coord:interface -L "mission:bd-xxx"`.

2. **Blocking request.** Worker discovers it needs something from a sibling. Posts to bus with `@sibling-name`:
   ```bash
   bus send --agent "$AGENT" "$PROJECT" \
     "@botbox-dev/frost-castle need the auth middleware exported from src/auth/index.mjs" \
     -L "mission:bd-xxx" -L coord:blocker
   ```
   The sibling's inbox check (already in the worker loop) picks this up.

3. **Completion signal.** Workers announce completion on bus. The lead's checkpoint logic aggregates these:
   ```bash
   bus send --agent "$AGENT" "$PROJECT" \
     "Completed bd-yyy: OAuth callback handler" \
     -L task-done -L "mission:bd-xxx"
   ```

**What changes in scripts:**
- Worker prompt includes mission context (siblings, their beads, mission constraints)
- Worker inbox step checks for `@self` mentions from siblings, not just from humans
- Workers post interface announcements when their work produces something others consume
- None of this requires new bus features — it's prompts + conventions

### 5. Mission-Aware Dev-Loop

Dev-loop gets new capabilities when working with missions.

#### Planning Phase

When dev-loop receives a large task (via `!dev` or a high-level bead), it:

1. Creates a mission bead with outcome/metric/constraints/stop-criteria
2. Breaks the mission into child beads with dependencies (existing planning.md workflow)
3. Assigns risk labels to each child based on content
4. Identifies parallelism in the dependency graph
5. Posts the plan to bus for visibility

This replaces the current "triage N beads → dispatch N workers" with "plan the mission → dispatch workers for unblocked beads."

#### Dispatch Phase

For each unblocked child bead in a mission:

1. Create workspace: `maw ws create --random`
2. Select model based on bead complexity + risk (existing logic)
3. Spawn worker via `botty spawn` with hierarchical name, mission env vars, and labels
4. Stake claims on behalf of the worker
5. Comment the dispatch on the bead

**Key change:** Workers get mission context in their environment:
- `BOTBOX_MISSION=bd-xxx` — the mission bead ID
- `BOTBOX_BEAD=bd-yyy` — the specific bead to work on
- `BOTBOX_WORKSPACE=amber-reef` — pre-created workspace

The worker prompt includes:
- Mission outcome and constraints (from the mission bead description)
- Sibling beads and their owners (from `br list --label "mission:bd-xxx"`)
- File ownership hints (advisory, from the plan)

**Concurrency controls:**
- `agents.dev.maxMissionWorkers` config (default: 4) — max simultaneous workers per mission.
- `agents.dev.maxMissionChildren` config (default: 12) — max child beads per mission (forces scope discipline).
- `agents.dev.checkpointIntervalSec` config (default: 30) — seconds between checkpoints.
- Dev-loop dispatches in waves: spawn up to maxMissionWorkers, then checkpoint until slots free up.

#### Checkpoint Phase

While workers are active, dev-loop runs periodic checkpoints:

1. **Progress:** Count children by status (open/in-progress/blocked/closed)
2. **Workers:** `botty list --label "mission:bd-xxx"` — who's alive, who's done?
3. **Blockers:** Any blocked children? Can the lead unblock them?
4. **Failures:** Any workers that exited but their bead is still in_progress? Trigger crash-recovery policy.
5. **Completion messages:** `bus history $PROJECT -L task-done -L "mission:bd-xxx" --after-id <last-seen-id>` (cursor-based to avoid rescanning)
6. **Decision:** Continue / rescope (drop low-priority children) / stop

Checkpoint results are appended to the dev-loop journal and posted to bus:

```bash
bus send --agent "$AGENT" "$PROJECT" \
  "Mission bd-xxx checkpoint: 3/5 done, 1 in-progress, 1 blocked. Continuing." \
  -L "mission:bd-xxx"
```

#### Merge Phase

As workers complete, dev-loop:

1. Checks review status (if applicable per risk level)
2. Merges workspace: `maw ws merge $WS --destroy`
3. Closes the child bead
4. Checks if newly-closed work unblocks other children → dispatches next wave

When all children are closed:

1. Closes the mission bead
2. Posts a mission summary to bus
3. Writes a mission log as a comment on the mission bead (decisions, what worked, what to avoid)

### 6. Flexible Worker Loop

The worker loop (agent-loop.mjs) gets small changes to support mission context:

**Environment-aware startup:** If `BOTBOX_MISSION` and `BOTBOX_BEAD` are set, skip triage — go directly to the assigned bead in the pre-created workspace. This is the "dispatched worker" path.

**Mission context in prompt:** When working on a mission child, the worker prompt includes:
- Mission outcome/constraints from the mission bead
- Sibling worker names and beads (for peer messaging)
- Advisory file ownership (don't touch files owned by siblings)

**Peer inbox check:** During work, workers check for `@self` mentions from siblings (already part of the inbox step, just needs prompt emphasis).

**Risk-aware finish:** Based on the bead's risk label:
- `risk:low` → skip review, merge directly
- `risk:medium` → standard review
- `risk:high` → security review + failure-mode checklist
- `risk:critical` → post to bus, wait for human approval

### 7. Mission Log

When a mission closes, dev-loop writes a brief synthesis:

```bash
br comments add --actor $AGENT --author $AGENT bd-xxx \
  "Mission complete. Outcome: OAuth login works e2e.
   5 beads completed, 0 blocked.
   Key decisions: Used in-memory session storage (deferred Redis to future work).
   What worked: Parallel dispatch of callback handler + session storage saved time.
   What to avoid: Worker B had to wait for Worker A's API shape — next time announce interfaces earlier."
```

This is a bead comment, not a separate file. Searchable via `br search`, visible to future agents working on related features.

## Testing Plan

### Test Matrix

1. **Unit:** Mission bead creation with invariants, risk label assignment and routing, coordination label conventions.
2. **Integration:** Mission create → dispatch workers → checkpoint → merge → close. Full lifecycle in eval.
3. **Fault injection:** Worker crash mid-bead (test crash-recovery policy: reassign once, then block). Stale claim after worker exit. Duplicate completion signals from retried workers.
4. **Risk paths:** Eval each risk level end-to-end — `risk:low` (no review), `risk:medium` (standard), `risk:high` (failure-mode checklist), `risk:critical` (human approval flow).
5. **Scale:** Missions with 2, 4, and 8 workers to validate checkpoint and concurrency controls.

### Eval Types

- Extend existing eval framework with new types:
  - **M1**: Single mission, 3 children, no dependencies between children (parallel dispatch)
  - **M2**: Mission with dependency chain (sequential waves)
  - **M3**: Mission with worker crash (test recovery policy)
  - **M4**: Mission with mixed risk levels (test risk-aware finish paths)
  - **M5**: Mission with peer coordination (worker A produces interface, worker B consumes)

## Open Questions

1. **What's the maximum practical team size?** Nelson caps at 10. With botty spawn overhead and bus message volume, what's the real limit before coordination cost exceeds parallel benefit? Default `maxMissionWorkers=4` seems conservative enough to start. Tune based on eval results.

2. **Should missions have explicit stop criteria that the lead evaluates automatically?** For example, "stop when 80% of children are done and remaining are P3+." Or should this always be a lead judgment call in the prompt? Leaning toward prompt-based judgment for v1 — structured stop-criteria evaluation can be added later if the prompt approach is too inconsistent.

## Answered Questions

1. **Q:** Should we use Claude Code's agent-team feature? **A:** No. It's experimental, doesn't go through botty (losing observability), and duplicates what bus already provides. All spawning through botty, all communication through bus.

2. **Q:** Where do risk levels live — bead fields or labels? **A:** Labels. `risk:low`, `risk:medium`, `risk:high`, `risk:critical`. Labels are already supported by br, searchable, and require no schema changes.

3. **Q:** How do mission children know about each other? **A:** Two mechanisms: (1) `br list --label "mission:bd-xxx"` shows all siblings, (2) `bus history $PROJECT -L "mission:bd-xxx"` shows mission-scoped messages. Both are read-only queries on existing infrastructure.

4. **Q:** Should workers share a workspace? **A:** No. Each worker gets their own workspace (existing model). Workspaces provide physical isolation. File ownership hints are advisory and communicated via prompts, not enforced.

5. **Q:** How do hierarchical agent names affect existing hooks? **A:** The router hook uses `--claim "agent://botbox-dev"` — a worker named `botbox-dev/amber-reef` is a different claim URI, so it won't conflict with the lead's identity claim. No hook changes needed.

6. **Q:** Does `br list` support `--label` filtering? **A:** Yes. `br list -l <label>` with AND logic (all labels must match). Also `--label-any` for OR logic. Both support repetition. Confirmed via `br list --help`.

7. **Q:** Does `botty list` support label-based filtering? **A:** Yes. `botty list -l <label>` filters by label, with AND logic when repeated. So `botty list -l worker -l "mission:bd-xxx"` works. Confirmed via `botty list --help`.

8. **Q:** Does `bus history` support label filtering? **A:** Yes. `bus history -L <label>` filters by label (OR logic when repeated). So `bus history $PROJECT -L "mission:bd-xxx"` returns only mission-scoped messages. Confirmed via `bus history --help`.

9. **Q:** How should the lead handle worker failures? **A:** One automatic retry (new worker, same or new workspace), then block the child on second failure. Details in crash-recovery policy under Mission Beads section.

10. **Q:** Should coordination messages use structured first-line format? **A:** No. Labels (`-L coord:interface`, `-L coord:blocker`, etc.) provide the structured layer for filtering. Message bodies stay natural language for human readability on `bus history`. Structured body formats add rigidity without benefit — agents parse natural language fine, and humans need to read these too.

## Alternatives Considered

### Alternative 1: Claude Code Agent Teams

Use Claude Code's experimental `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` feature for team coordination. Rejected because:
- Experimental and may change or break
- Spawns invisible processes — no `botty tail`, no `botty kill`, no `botty list`
- Introduces a second communication channel alongside bus (confusing)
- Doesn't integrate with our existing claims, beads, or crit workflows

### Alternative 2: New "mission" Field in Beads Schema

Add a dedicated `mission_id` field to beads rather than using labels. Rejected because:
- Requires br schema changes and migration
- Labels already provide grouping, filtering, and search
- `--parent` already provides the dependency relationship
- Lower implementation cost with labels

### Alternative 3: Dedicated Mission Channel per Mission

Create a separate bus channel for each mission (e.g., `botbox/mission-bd-xxx`). Rejected because:
- Fragments communication — humans monitoring the project channel miss mission activity
- Adds channel lifecycle management (create/cleanup)
- Mission-scoped labels on the existing project channel achieve the same filtering without new channels

### Alternative 4: Keep Rigid Script Rails, Add Mission Awareness

Make dev-loop.mjs orchestrate everything with detailed scripted phases (like Nelson's 6-step workflow). Rejected because:
- Encodes coordination in prompts rather than enabling it through tools
- Agents can't adapt — if the script says "checkpoint every 15 minutes" but the mission is done in 5, the script still runs
- Bus + claims + labels provide flexible coordination primitives that agents can use situationally

### Alternative 5: Structured Coordination Message Body Format

Require workers to use a structured first-line format (`kind=coord:interface bead=bd-yyy from=$AGENT`) in bus messages. Rejected because:
- Labels already provide machine-readable filtering (`-L coord:interface -L "mission:bd-xxx"`)
- Structured bodies reduce readability for humans browsing `bus history`
- Agents parse natural language well enough — the structured layer belongs in labels, not prose
- Adds agent discipline overhead for marginal filtering benefit

## Implementation Plan

### Phase 1: Risk-Based Review

1. **Add risk labels to grooming workflow** — Update `planning.md` and `groom.md` to include risk assessment with rubric (blast radius, data sensitivity, reversibility, dependency uncertainty). Dev-loop prompt assigns risk during triage.
2. **Risk-aware review in agent-loop** — Modify agent-loop.mjs prompt: `risk:low` skips review, `risk:high` adds failure-mode checklist to review request, `risk:critical` waits for human.
3. **Failure-mode checklist in reviewer prompt** — Add the 5 questions to `reviewer-security.md` (or a new `reviewer-risk.md`), triggered when the review target has `risk:high`+.
4. **Add `project.criticalApprovers` to `.botbox.json`** — List of humans who can approve `risk:critical` merges. Agent-loop checks for approval message before merge.
5. **Update workflow docs** — `review-request.md`, `worker-loop.md`, `finish.md` to document risk-based paths and evidence requirements.

**Gate:** All four risk paths pass eval (low/medium/high/critical).

### Phase 2: Mission Beads and Execution Levels

6. **Mission bead conventions** — Document the structured description format (outcome/metric/constraints/stop-criteria) and invariants. Update `planning.md` to start with a mission bead.
7. **Execution level guidance in dev-loop prompt** — Add level 2/3/4 decision criteria to the dev-loop prompt. Level 4 triggers mission creation. Preserve existing level 2/3 behavior when missions aren't warranted.
8. **`!mission` prefix in respond.mjs** — New route type that creates a mission bead directly and execs into dev-loop with `BOTBOX_MISSION` set. Humans use this to explicitly request level 4 execution.
9. **Mission-aware triage** — Dev-loop recognizes mission beads, checks child progress, reports aggregate status.
10. **Add mission concurrency config** — `agents.dev.maxMissionWorkers`, `maxMissionChildren`, `checkpointIntervalSec` in `.botbox.json`. Add `missionsEnabled` feature flag (default false).

**Gate:** Mission create → dispatch → close lifecycle passes eval (M1, M2).

### Phase 3: Hierarchical Spawning

11. **Hierarchical agent names in dev-loop dispatch** — Change worker dispatch to use `$AGENT/<worker-name>` naming. Pass mission env vars (`BOTBOX_MISSION`, `BOTBOX_BEAD`, `BOTBOX_WORKSPACE`). Spawn via `botty spawn ... -- botbox run-agent claude -p "$PROMPT"`.
12. **Dispatched worker fast-path in agent-loop** — When env vars are set, skip triage and go directly to the assigned bead/workspace.
13. **Worker cleanup on parent** — When dev-loop exits, clean up any lingering child agents via `botty kill`.
14. **Crash-recovery in dev-loop** — Implement the one-retry-then-block policy. Detect dead workers via `botty list`, reassign or block.

**Gate:** Crash-recovery eval passes (M3).

### Phase 4: Peer Coordination and Checkpoints

15. **Coordination label conventions** — Document `coord:interface`, `coord:blocker`, `coord:handoff` labels. Update worker prompt to use them.
16. **Sibling context in worker prompt** — When dispatched as part of a mission, worker prompt includes mission outcome, sibling beads/agents, file ownership hints.
17. **Checkpoint logic in dev-loop** — After dispatching, dev-loop enters a checkpoint loop with cursor-based polling (`--after-id`). Post checkpoint summaries to bus.
18. **Mission close and synthesis** — When all children close, dev-loop closes the mission bead with a summary comment.

**Gate:** Peer coordination eval passes (M5). Checkpoint loop works with 4+ workers.

### Phase 5: Docs and Rollout

19. **New workflow doc: mission.md** — End-to-end guide for mission-based work.
20. **Update CLAUDE.md** — Add mission beads, risk labels, hierarchical agents, execution levels to the ecosystem docs.
21. **Update dev-loop.mjs and agent-loop.mjs script prompts** — Incorporate all the above into the actual script prompt strings.
22. **Full eval suite** — Run M1-M5 plus mixed risk levels (M4).
23. **(If needed) Add `--prompt-file` to `botbox run-agent`** — If mission-aware prompts exceed comfortable CLI arg sizes in practice, add file-based prompt input. Defer until actually needed.
