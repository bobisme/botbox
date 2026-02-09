# Review: Mission-Aware Agent Coordination Plan

Source: `ws/default/notes/proposals/mission-coordination.md`

Date: 2026-02-09

## Executive Summary

This proposal is directionally strong. It uses existing primitives (labels, bus, botty, maw, crit) and avoids heavy schema changes. The phased implementation structure is also a good start.

The main gaps are around execution safety and operability:

- Assumed tool capabilities are not gated before implementation.
- Mission lifecycle invariants and crash-recovery behavior are under-specified.
- Risk policy is useful but needs stronger governance and auditable approval flow for `risk:critical`.
- Coordination message format is too free-form for reliable automation.
- Performance/backpressure controls, testing matrix, and rollout gates are not concrete enough yet.

The proposed changes below keep the architecture but make it implementation-ready, safer under failure, and measurable in production.

## Proposed Changes

### [High Impact, Low Effort] Change #1: Add explicit scope, non-goals, and measurable success criteria

**Current State:**
The plan has a strong summary and motivation, but no explicit scope boundary or quantitative success metrics.

**Proposed Change:**
Add a `Scope and Success Criteria` section defining goals, non-goals, measurable metrics, and proposal exit criteria.

**Rationale:**
Prevents scope creep and aligns implementation/review decisions to objective outcomes.

**Benefits:**
- Improves alignment on what "done" means
- Reduces planning drift across phases
- Enables data-driven rollout decisions

**Trade-offs:**
- Slightly more up-front planning work

**Implementation Notes:**
Insert this section immediately after `## Summary`.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/mission-coordination.md
+++ ws/default/notes/proposals/mission-coordination.md
@@ -10,6 +10,30 @@
 Botbox agents work well on independent tasks but have no framework for coordinated multi-task efforts. When a feature requires 5 related beads, each worker operates in isolation — there's no shared context, no risk-proportional review, no checkpoints, and no way for workers to coordinate with each other. This proposal adds **mission beads**, **risk labels**, **hierarchical agent spawning via botty**, and **peer coordination through bus** to unlock true team-based work without rigid script rails.
 
+## Scope and Success Criteria
+
+### Goals (v1)
+1. Coordinate related beads under a mission with explicit shared outcome and constraints.
+2. Reduce lead time for multi-bead features while preserving observability through botty/bus.
+3. Apply risk-proportional verification so low-risk work does not pay high review overhead.
+
+### Non-Goals (v1)
+- Replacing beads, bus, maw, crit, or botty data models.
+- Building a new UI/dashboard for mission management.
+- Cross-project mission orchestration (single project/channel only).
+
+### Success Metrics
+- >=30% median lead-time improvement for missions with 3+ child beads vs current dev-loop baseline.
+- <=5% increase in blocked/reopened child beads during rollout.
+- 100% of `risk:critical` merges include auditable human approval evidence.
+- >=90% mission invariant compliance (`parent` + matching `mission:<id>` label on children).
+
+### Proposal Exit Criteria
+- Capability checks (Phase 0) completed.
+- Open questions resolved or deferred with owner and due date.
+- Eval coverage includes crash-recovery and high-risk paths.
+
 ## Motivation
```

---

### [High Impact, Low Effort] Change #2: Add capability matrix and fallback rules before implementation

**Current State:**
The design assumes behavior for commands/flags such as `br list --label`, `bus history -L`, `botty list --label`, and `botty spawn --after/--wait-for`.

**Proposed Change:**
Add a mandatory `Capability Matrix and Fallback Rules` section as a pre-implementation gate.

**Rationale:**
Converts implicit assumptions into explicit validation and avoids late-stage rework.

**Benefits:**
- Reduces implementation risk from unknown CLI capabilities
- Improves portability across environments/versions
- Keeps fallback behavior explicit and testable

**Trade-offs:**
- Slightly delays coding start

**Implementation Notes:**
Add as `### 0.` under `## Proposed Design`, after Design Principles.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/mission-coordination.md
+++ ws/default/notes/proposals/mission-coordination.md
@@ -34,6 +34,27 @@
 - **Hierarchical agent names.** When `botbox-dev` spawns a worker `amber-reef`, the worker's identity is `botbox-dev/amber-reef`. This uses botty/bus's native slash support. Claims, messages, and statuses all naturally namespace under the parent.
 - **Bus for coordination, not scripts.** Rather than encoding coordination logic in script prompts, agents coordinate through bus messages, claims, and labels. Scripts provide the loop structure; bus provides the communication fabric.
 
+### 0. Capability Matrix and Fallback Rules
+
+Before implementation, validate each assumed command/flag and document fallback behavior:
+
+| Capability | Needed for | Validation command | Fallback |
+|------------|------------|--------------------|----------|
+| `br list --label` | sibling lookup | `maw exec default -- br list --help` | `br list --format json` + filter in script |
+| `bus history -L` | mission-scoped messages | `bus history --help` | `bus history --format json` + label filter |
+| `botty list --label` | worker checkpointing | `botty list --help` | `botty list --format json` + label filter |
+| `botty spawn --after/--wait-for` | orchestration sequencing | `botty spawn --help` | dependency-driven sequencing in dev-loop |
+
+Rules:
+1. Do not start implementation when both primary capability and fallback are missing.
+2. Record fallback performance/token cost in this document.
+3. Keep proposal status as `VALIDATING` until this matrix is complete.
+
 ### 1. Mission Beads
```

---

### [High Impact, High Effort] Change #3: Define mission invariants, state model, and crash-recovery policy

**Current State:**
Mission behavior is described conceptually, but invariants are not machine-checkable and failure policy is still open.

**Proposed Change:**
Add explicit mission invariants, a state model, and default crash-recovery behavior.

**Rationale:**
Multi-agent workflows fail at boundaries. Deterministic invariants and retry policy are required for reliability.

**Benefits:**
- Prevents silent mission data drift
- Improves checkpoint determinism
- Enables consistent failure recovery

**Trade-offs:**
- More orchestration logic in dev-loop

**Implementation Notes:**
Insert directly under `### 1. Mission Beads` after "What missions enable".

**Git-Diff:**
```diff
--- ws/default/notes/proposals/mission-coordination.md
+++ ws/default/notes/proposals/mission-coordination.md
@@ -75,6 +75,29 @@
 **What missions enable:**
 - Workers dispatched for a mission get the mission description in their prompt context (outcome, constraints, stop criteria)
 - Dev-loop can assess aggregate progress: "4/6 children closed, 1 blocked, 1 in-progress"
 - Checkpoint logic triggers when a mission has active workers
 - Mission close requires all children closed (enforced by the parent dep)
+
+**Mission invariants (must be machine-checkable):**
+1. Every child has exactly one `mission:<id>` label and `parent=<id>` for the same mission.
+2. A child cannot have multiple mission labels.
+3. Mission close is blocked unless all children are `closed`.
+4. Exactly one active worker assignment per child bead.
+
+**State model:**
+- Mission: `open -> in_progress -> blocked|completed -> closed`
+- Worker assignment: `unassigned -> assigned -> running -> done|failed`
+
+**Crash-recovery policy:**
+1. If worker exits unexpectedly, dev-loop records failure in bead comment + mission log.
+2. Dev-loop performs one automatic reassignment (new worker/workspace) for the same child.
+3. On second failure, child becomes `blocked` and requires explicit lead intervention.
+4. Recovery actions are included in checkpoint summaries for auditability.
```

---

### [High Impact, Low Effort] Change #4: Harden risk model with objective rubric and secure critical-approval flow

**Current State:**
Risk levels are valuable but classification/governance is subjective. `risk:critical` approval requirements are not fully authenticated or time-bounded.

**Proposed Change:**
Add a risk rubric, downgrade controls, critical approver allowlist, and approval expiry semantics.

**Rationale:**
Prevents inconsistent risk classification and strengthens safety/compliance posture.

**Benefits:**
- More consistent risk assignment
- Stronger controls for irreversible changes
- Better auditability for critical merges

**Trade-offs:**
- Adds process overhead for critical paths

**Implementation Notes:**
Patch `### 2. Risk Labels` around assignment and evidence requirements.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/mission-coordination.md
+++ ws/default/notes/proposals/mission-coordination.md
@@ -99,8 +99,24 @@
 The reviewer must address all five questions in their review comments. This is a prompt change to `reviewer-security.md`, not a tool change.
 
-**Assignment:** Risk labels are set during planning/grooming. Dev-loop assigns risk during triage based on bead content. Workers can escalate risk mid-implementation: `br label add --actor $AGENT -l risk:high <id>` with a comment explaining why.
+**Assignment and governance:**
+- Use a rubric: blast radius, data sensitivity, reversibility, and dependency uncertainty.
+- Risk can be escalated by any worker with justification comment.
+- Risk downgrades require explicit lead approval on the bead.
+- `risk:critical` merges require human approval from `project.criticalApprovers`.
+- Approval must reference the exact review/patch and expires after 24h or patch change.
 
 **Self-review for low-risk:** When a bead has `risk:low`, the agent-loop skips the crit review step entirely — it merges the workspace directly after implementation and proceeds to finish. This saves significant time and tokens on trivial work.
+
+**Evidence requirements by risk:**
+- `risk:low`: self-review note + relevant tests.
+- `risk:medium`: standard review id + relevant tests.
+- `risk:high`: security review + completed failure-mode checklist + rollback notes.
+- `risk:critical`: all high-risk evidence + valid human approval message id.
```

---

### [Medium Impact, Low Effort] Change #5: Standardize peer coordination with a structured message contract

**Current State:**
Mission coordination examples are free-form text and may be hard to parse reliably.

**Proposed Change:**
Define a required coordination message contract (labels + first-line fields).

**Rationale:**
Structured messages are easier to aggregate in checkpoint loops and less error-prone across agents.

**Benefits:**
- Improves reliability of mission status aggregation
- Reduces ambiguity in cross-worker communication
- Strengthens traceability by bead and message type

**Trade-offs:**
- Slight increase in worker message discipline

**Implementation Notes:**
Add under `### 4. Peer Coordination via Bus`.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/mission-coordination.md
+++ ws/default/notes/proposals/mission-coordination.md
@@ -168,6 +168,24 @@
 # Worker B checks for sibling messages
 bus history "$PROJECT" -n 20 -L "mission:bd-xxx"
 ```
+
+**Structured coordination contract (required):**
+- Labels: `mission:<id>`, `bead:<id>`, and one type label (`coord:interface|coord:blocker|coord:handoff|coord:done`)
+- First line fields: `kind=<type> bead=<id> from=<agent>`
+- Second line: `summary=<one sentence>`
+
+Example:
+```bash
+bus send --agent "$AGENT" "$PROJECT" \
+  "kind=coord:interface bead=bd-yyy from=$AGENT
+summary=POST /auth/callback request+response finalized
+details=Consumes {code,state}; returns {token,user}" \
+  -L "mission:bd-xxx" -L "bead:bd-yyy" -L "coord:interface"
+```
+
+This keeps messages human-readable while enabling deterministic parsing in checkpoints.
```

---

### [High Impact, High Effort] Change #6: Add performance guardrails and adaptive backpressure

**Current State:**
Checkpointing is described functionally, but lacks explicit limits, SLOs, and overload behavior.

**Proposed Change:**
Add concurrency controls, checkpoint interval config, cursor-based polling, and adaptive backpressure rules.

**Rationale:**
Mission orchestration can degrade under load without controls.

**Benefits:**
- Prevents runaway polling and message churn
- Improves stability under larger mission fanout
- Introduces clear operational tuning knobs

**Trade-offs:**
- More configuration and control logic

**Implementation Notes:**
Add under `#### Checkpoint Phase` as a dedicated subsection.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/mission-coordination.md
+++ ws/default/notes/proposals/mission-coordination.md
@@ -249,6 +249,22 @@
   -L "mission:bd-xxx"
 ```
 
+#### Performance and Backpressure Guardrails
+
+- Add config:
+  - `agents.dev.maxMissionWorkers` (default: 4)
+  - `agents.dev.checkpointIntervalSec` (default: 30, jitter +/-20%)
+  - `agents.dev.maxMissionChildren` (default: 12)
+- Track incremental cursors (`lastBusMessageId`, `lastCheckpointAt`) to avoid full rescans.
+- If checkpoint runtime exceeds interval twice consecutively, pause new dispatch and reduce worker target.
+- If mission message volume exceeds threshold, suppress non-essential chatter and require `coord:*` labels.
+- Initial SLOs:
+  - checkpoint latency p95 < 5s
+  - merge-queue wait p95 < 2m for `risk:low|medium`
+
 ### Merge Phase
```

---

### [Medium Impact, Low Effort] Change #7: Add explicit testing and observability plan

**Current State:**
Testing appears as a single eval task in implementation phases; observability requirements are not explicit.

**Proposed Change:**
Add a dedicated `Testing and Observability Plan` section with matrix, telemetry, and alert conditions.

**Rationale:**
Coordination changes need fault-injection and operational validation, not only happy-path tests.

**Benefits:**
- Reduces rollout risk
- Improves production debugging
- Clarifies health signals and failure triggers

**Trade-offs:**
- Additional effort to build test coverage and telemetry

**Implementation Notes:**
Insert this section before `## Open Questions`.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/mission-coordination.md
+++ ws/default/notes/proposals/mission-coordination.md
@@ -298,6 +298,29 @@
 This is a bead comment, not a separate file. Searchable via `br search`, visible to future agents working on related features.
 
+## Testing and Observability Plan
+
+### Test Matrix
+1. Unit: mission parsing, invariant checks, risk-policy routing.
+2. Integration: mission create -> dispatch -> checkpoint -> merge -> close.
+3. Fault injection: worker crash, stale claim, duplicate completion signal, delayed bus history.
+4. Load: missions with 1, 4, 8, and 12 workers.
+
+### Required Telemetry
+- Mission lifecycle timings (create, first dispatch, first child closed, mission closed)
+- Checkpoint duration and paused-dispatch count
+- Worker failure/retry count by mission
+- Review path distribution by risk level
+
+### Alert Conditions
+- Mission invariant violation detected
+- `risk:critical` merge attempt without valid human approval evidence
+- Retry budget exhausted for a child bead
+
 ## Open Questions
```

---

### [High Impact, High Effort] Change #8: Rework implementation plan into gated rollout with feature flags, migrations, and rollback

**Current State:**
The existing phased plan is linear and lacks explicit go/no-go gates, canary rollout, rollback path, and migration requirements.

**Proposed Change:**
Introduce Phase 0 validation, per-phase gates, feature flags, canary rollout, and explicit migration/release checks.

**Rationale:**
This proposal changes agent coordination behavior and should use progressive delivery with safe disable paths.

**Benefits:**
- Safer rollout in active projects
- Faster regression detection
- Better compatibility with botbox migration conventions

**Trade-offs:**
- Longer implementation timeline

**Implementation Notes:**
Replace the current `## Implementation Plan` details with the gated version below.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/mission-coordination.md
+++ ws/default/notes/proposals/mission-coordination.md
@@ -356,35 +356,49 @@
 ## Implementation Plan
 
-### Phase 1: Labels and Risk-Based Review
-
-1. **Add risk labels to grooming workflow** — Update `planning.md` and `groom.md` to include risk assessment. Dev-loop prompt assigns risk during triage.
-2. **Risk-aware review in agent-loop** — Modify agent-loop.mjs prompt: `risk:low` skips review, `risk:high` adds failure-mode checklist to review request, `risk:critical` waits for human.
-3. **Failure-mode checklist in reviewer prompt** — Add the 5 questions to `reviewer-security.md` (or a new `reviewer-risk.md`), triggered when the review target has `risk:high`+.
-4. **Update workflow docs** — `review-request.md`, `worker-loop.md`, `finish.md` to document risk-based paths.
+### Phase 0: Capability Validation (Gate)
+1. Validate all command/flag assumptions in the capability matrix.
+2. Implement fallback shims where required.
+3. Keep status as `VALIDATING` until completed.
 
-### Phase 2: Mission Beads
+### Phase 1: Risk Policy Foundation
+4. Add risk rubric + governance to planning/grooming docs.
+5. Update worker/reviewer prompts for evidence requirements by risk level.
+6. Add `project.criticalApprovers` config and enforcement for `risk:critical`.
 
-5. **Mission bead conventions** — Document the structured description format (outcome/metric/constraints/stop-criteria). Update `planning.md` to start with a mission bead.
-6. **Mission-aware dev-loop planning** — When dev-loop receives a large task, it creates a mission bead first, then decomposes into children with `--parent` and `mission:bd-xxx` labels.
-7. **Mission-aware triage** — Dev-loop recognizes mission beads, checks child progress, reports aggregate status.
+**Gate A:** all risk paths pass eval (`low/medium/high/critical`).
 
-### Phase 3: Hierarchical Spawning
+### Phase 2: Mission Model + Invariants
+7. Implement mission invariants and state transitions.
+8. Add idempotent worker assignment records and single-active-worker checks.
+9. Implement crash-recovery policy and retry budget.
 
-8. **Hierarchical agent names in dev-loop dispatch** — Change worker dispatch to use `botbox-dev/<worker-name>` naming and pass mission env vars (`BOTBOX_MISSION`, `BOTBOX_BEAD`, `BOTBOX_WORKSPACE`).
-9. **Dispatched worker fast-path in agent-loop** — When env vars are set, skip triage and go directly to the assigned bead/workspace.
-10. **Worker cleanup on parent** — When dev-loop exits, clean up any lingering child agents via `botty kill`.
+**Gate B:** crash-recovery eval passes deterministically.
 
-### Phase 4: Peer Coordination and Checkpoints
+### Phase 3: Coordination Protocol + Performance Controls
+10. Add structured `coord:*` messaging contract.
+11. Add checkpoint cursors, worker caps, and adaptive backpressure.
+12. Add mission synthesis comment generation including recovery history.
 
-11. **Mission-scoped bus messages** — Workers post with `-L "mission:bd-xxx"`. Prompt includes instructions for interface announcements and sibling communication.
-12. **Sibling context in worker prompt** — When dispatched as part of a mission, worker prompt includes mission outcome, sibling beads/agents, file ownership hints.
-13. **Checkpoint logic in dev-loop** — After dispatching, dev-loop enters a checkpoint loop: check botty list, bus history, bead statuses. Post checkpoint summaries to bus.
-14. **Mission close and synthesis** — When all children close, dev-loop closes the mission bead with a summary comment.
+**Gate C:** load eval meets checkpoint/queue SLO targets.
 
-### Phase 5: Docs and Rollout
+### Phase 4: Safe Rollout
+13. Add feature flags in `.botbox.json` (`missionsEnabled`, `riskPolicyEnabled`, `coordProtocolEnabled`).
+14. Canary rollout to one project before defaults are enabled.
+15. Add rollback playbook and disable path.
 
-15. **New workflow doc: mission.md** — End-to-end guide for mission-based work.
-16. **Update CLAUDE.md** — Add mission beads, risk labels, hierarchical agents to the ecosystem docs.
-17. **Update dev-loop.mjs and agent-loop.mjs script prompts** — Incorporate all the above into the actual script prompt strings.
-18. **Eval: mission coordination** — New eval type testing mission planning, dispatch, peer coordination, risk-based review, and mission close.
+### Phase 5: Docs, Migrations, and Release
+16. Update docs (`mission.md`, `worker-loop.md`, `review-request.md`, `finish.md`).
+17. Add full eval suite (happy path, crash recovery, high-risk/critical approval, load).
+18. Add migrations for runtime behavior changes and run full tests before release.
```
