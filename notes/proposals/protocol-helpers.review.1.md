# Review: Protocol Helper Commands Proposal

## Executive Summary

This proposal is strong on problem framing and practicality: it identifies real failure patterns from evals, proposes concrete command interfaces, and keeps scope anchored to protocol mechanics instead of replacing agent judgment.

The biggest gaps are around true atomicity semantics, race-condition ordering in `start/finish`, unresolved policy decisions, and thin rollout/testing/security detail.

The seven changes below keep the core direction but make the plan more implementable, safer under failure, more performant in loop-heavy usage, and easier to validate before rollout.

## Proposed Changes

### [High Impact, Low Effort] Change #1: Reorder `start`/`finish` steps to prevent inconsistent state

**Current State:**
`start` sets bead `in_progress` before staking claim, and `finish` closes bead before merge (`notes/proposals/protocol-helpers.md:49`, `notes/proposals/protocol-helpers.md:80`).

**Proposed Change:**
Acquire bead claim before mutating bead status in `start`; merge before close in `finish`; add explicit retry/idempotency flags and clearer compensation behavior.

**Rationale:**
Current ordering creates race windows and inconsistent outcomes (for example, closed bead with failed merge). Reordering eliminates high-probability integrity bugs with minimal design change.

**Benefits:**
- Prevents double-start races and "closed-but-not-merged" outcomes
- Aligns operational state with real ownership/merge reality
- Makes retries deterministic under partial failure

**Trade-offs:**
- Slightly more preflight logic and additional flags
- More explicit error paths to document

**Implementation Notes:**
Keep output machine-parseable; ensure conflict paths return exact recovery commands.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -46,12 +46,16 @@
 Atomically starts work on a bead:

-1. Check bead exists and is open/ready (fail fast if claimed or closed)
-2. `br update --status=in_progress --owner=$AGENT`
-3. `bus claims stake "bead://project/<id>"`
-4. `maw ws create --random` → capture workspace name
-5. `bus claims stake "workspace://project/<ws>"`
-6. `br comments add <id> "Started in workspace <ws>, agent $AGENT"`
-7. `bus send project "Working on <id>: <title>" -L task-claim`
+1. Preflight: verify bead exists, is `open` (or is `in_progress` and already owned by `$AGENT` for retry), and has no conflicting active bead claim
+2. `bus claims stake "bead://project/<id>" --ttl <claim-ttl>`
+3. `br update --status=in_progress --owner=$AGENT <id>`
+4. `maw ws create --random` → capture workspace name
+5. `bus claims stake "workspace://project/<ws>" --ttl <claim-ttl>`
+6. `br comments add <id> "[protocol/start] workspace=<ws> agent=$AGENT op=<op-id>"`
+7. `bus send project "Working on <id>: <title>" -L task-claim`
+8. On any failure after step 2: run compensation (`bus claims release` + optional `maw ws destroy`) and return structured error details
@@ -70,6 +74,8 @@
 - `--agent <name>` (or from `$BOTBUS_AGENT` / config)
 - `--project <name>` (or from config)
 - `--workspace <name>` — use specific name instead of random
+- `--claim-ttl <duration>` — explicit TTL for bead/workspace claims
+- `--idempotency-key <key>` — make retries resume the same operation safely

 #### `botbox protocol finish <bead-id>`
@@ -77,17 +83,18 @@
 Atomically finishes a bead:

-1. Resolve workspace from bead claims (`bus claims list --agent $AGENT`)
-2. `br close --actor $AGENT <id>`
-3. `bus send project "Completed <id>: <title>" -L task-done`
-4. `bus claims release "bead://project/<id>"`
-5. `maw ws merge <ws> --destroy`
-6. `bus claims release "workspace://project/<ws>"`
-7. `br sync --flush-only`
+1. Preflight: resolve workspace from claims, verify bead ownership, and enforce review policy (LGTM required unless `--force`)
+2. If merge is enabled: `maw ws merge <ws> --destroy`
+3. `br close --actor $AGENT <id>`
+4. `bus send project "Completed <id>: <title>" -L task-done`
+5. `bus claims release "bead://project/<id>"`
+6. `bus claims release "workspace://project/<ws>"` (if still present)
+7. `br sync --flush-only`

 **Flags:**
 - `--no-merge` — skip workspace merge (for dispatched workers whose lead handles merge)
 - `--reason <text>` — close reason
 - `--agent`, `--project`
+- `--force` — bypass review gate (must emit warning + bead comment)

-**Error handling:** If merge fails (conflict), release bead claim but keep workspace claim, report the conflict. Agent or lead can fix and retry.
+**Error handling:** If merge fails, keep bead + workspace claims and keep bead open; return conflict details and exact recovery command. If close fails after merge, emit a reconciliation warning and keep bead claim until explicitly resolved.
```

---

### [High Impact, High Effort] Change #2: Define explicit atomicity model (saga + idempotency journal)

**Current State:**
The proposal says commands are "atomic," but does not define operational atomicity semantics across subprocess boundaries.

**Proposed Change:**
Add a formal invariants + saga section with per-command compensation and idempotent resume behavior based on `op-id`.

**Rationale:**
Without a transaction model, "atomic" is ambiguous. A clear saga contract is essential for crash recovery and deterministic retries.

**Benefits:**
- Clarifies correctness model for implementers and reviewers
- Makes failure handling testable and auditable
- Reduces regressions during future command additions

**Trade-offs:**
- Adds implementation complexity (journaling/resume)
- Slightly increases command output verbosity

**Implementation Notes:**
Journal can live in bead comments first (no new store needed); can evolve later if needed.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -42,6 +42,27 @@
 ### New subcommands under `botbox protocol`

+### Protocol invariants and atomicity contract
+
+`botbox protocol` commands are **atomic at the workflow level** (saga semantics), not database transactions. The design should define invariants explicitly:
+
+1. A bead in `in_progress` must have exactly one active `bead://` claim.
+2. A claimed workspace must map to exactly one bead via claim metadata and/or bead comments.
+3. A bead must not be closed before merge succeeds (except explicit `--no-merge` mode).
+4. Retrying the same protocol command must be idempotent.
+
+Each subcommand writes an operation journal marker:
+
+`[protocol-op] op=<uuid> cmd=<start|finish|review|cleanup> bead=<id> step=<n>/<N> status=<ok|failed>`
+
+On retry, the command reads journal + claims and resumes from the first incomplete step instead of replaying completed side effects.
+
+Compensation policy is required for each subcommand:
+- `start`: release claims and destroy newly-created workspace on partial failure
+- `finish`: never close bead if merge failed
+- `review`: if review creation succeeds but notification fails, retry notification without creating a second review
+- `cleanup`: retries remain safe (`release --all`, `sync --flush-only`)
+
 #### `botbox protocol start <bead-id>`
```

---

### [High Impact, Low Effort] Change #3: Resolve key policy ambiguities now (open questions -> defaults)

**Current State:**
Core behavior is still in "Currently thinking..." state (`notes/proposals/protocol-helpers.md:159`), which blocks implementation consistency.

**Proposed Change:**
Answer the high-impact policy questions now; leave only one intentionally deferred scope decision (`protocol dispatch` timing). Also make reviewer selection configurable in `protocol review`.

**Rationale:**
Unresolved policy decisions become inconsistent implementations and brittle prompt behavior. Converting them to defaults gives clear acceptance criteria.

**Benefits:**
- Removes ambiguity before coding starts
- Ensures `protocol finish` and `protocol review` are consistent across agents
- Reduces review churn during implementation

**Trade-offs:**
- Commits to defaults that may require later tuning
- Slightly reduces flexibility in v1

**Implementation Notes:**
Make defaults strict and add explicit escape hatches (`--force`, `--reviewers`, `--dispatched`).

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -94,14 +94,18 @@
 #### `botbox protocol review <bead-id>`

 Request review for the current workspace:

 1. Resolve workspace from bead claims
-2. `crit reviews create --agent $AGENT --title "<bead title>" --reviewers <project>-security`
+2. `crit reviews create --agent $AGENT --title "<bead title>" --reviewers <resolved-reviewers>`
 3. `br comments add <id> "Review created: <review-id> in workspace <ws>"`
 4. `bus send project "Review requested: <review-id> @<project>-security" -L review-request`
@@ -108,6 +112,10 @@
 review  <review-id>
 workspace  <ws-name>
 ```
+
+**Flags:**
+- `--reviewers <csv>` (default: `.botbox.json` `review.reviewers` mapped to `<project>-<role>`)
+- `--review-id <id>` (re-request an existing review without creating a new one)
@@ -157,13 +165,19 @@
 ## Open Questions

-1. **Should `protocol start` check for existing claims before staking?** If another agent already holds the bead, should it fail immediately or force-stake? Currently thinking: fail immediately with clear error.
-
-2. **Should `protocol finish` handle the review-not-approved case?** If the bead has a review that's still pending or blocked, should it refuse to close? Currently thinking: yes, refuse unless `--force` is passed.
-
-3. **How should dispatched workers differ?** Workers spawned by dev-loop shouldn't merge (lead handles it). The `--no-merge` flag covers this, but should `protocol start` also accept `--dispatched` to skip the bus announcement (since the lead already announced)?
-
-4. **Should there be a `protocol dispatch` for the lead?** Dev-loop's dispatch pattern (create ws, generate name, stake claims, comment bead, spawn worker) is complex. Worth encapsulating?
+1. **Should `protocol dispatch` ship in this proposal or as a follow-up?** Recommendation: follow-up after `start/finish/review/cleanup/resume` metrics stabilize.

 ## Answered Questions

-(none yet)
+1. **Q:** Should `protocol start` check for existing claims before staking?  
+   **A:** Yes. Fail fast on conflicting claim; no force-stake mode in v1.
+2. **Q:** Should `protocol finish` handle review-not-approved cases?  
+   **A:** Yes. Refuse by default when review is blocked/pending; allow explicit `--force` with mandatory warning and bead comment.
+3. **Q:** How should dispatched workers differ?  
+   **A:** Keep `--no-merge` and add `--dispatched` to suppress duplicate `task-claim` announcements while still writing crash-recovery bead comments.
+4. **Q:** How are reviewers selected for `protocol review`?  
+   **A:** Default to `.botbox.json` reviewer config; allow explicit `--reviewers` override.
```

---

### [Medium Impact, Low Effort] Change #4: Add shared protocol context collector (performance + consistency)

**Current State:**
The plan optimizes prompts by reducing tool calls, but does not define shared data collection strategy across `status` and protocol commands.

**Proposed Change:**
Add an internal context/snapshot collector reused by protocol preflights and status advice generation.

**Rationale:**
Centralizing reads avoids repeated subprocess work and reduces divergence between "status says X" and "protocol enforces Y."

**Benefits:**
- Fewer subprocess calls in loop-heavy operation
- Consistent decision logic between commands
- Easier unit/integration testing via one seam

**Trade-offs:**
- Slight architectural upfront cost
- Requires careful freshness semantics

**Implementation Notes:**
Use single-command snapshot scope first; avoid long-lived cache until needed.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -149,6 +149,20 @@
 4. **Integration into prompts** — dev-loop and worker-loop call `botbox status --format json` once instead of 5+ separate tool calls

+### Shared protocol context (performance + consistency)
+
+Add an internal `ProtocolContext::collect(project, agent)` helper used by both `botbox status` and `botbox protocol *` commands. It should gather and normalize:
+- `bus claims list` (single call)
+- `maw ws list --format json` (single call)
+- `br` data for referenced beads only (avoid full scans)
+- optional `crit` review status for referenced workspaces
+
+This reduces duplicate subprocess calls, keeps status advice and protocol preflight logic in sync, and creates a single test seam for failure injection.
+
+Cache scope should be per-command invocation (not cross-command global cache) to avoid stale coordination state.
+
 ### What this does NOT do
```

---

### [High Impact, Low Effort] Change #5: Add explicit security and privacy guardrails

**Current State:**
No explicit security model for identity override, input validation, output redaction, or command construction.

**Proposed Change:**
Add a security section with identity trust boundaries, strict validation, no shell interpolation, redaction policy, and operation audit IDs.

**Rationale:**
These commands orchestrate multiple tools and publish messages/comments. Without guardrails, they can introduce impersonation and data exposure risks.

**Benefits:**
- Reduces command-injection and impersonation risk
- Protects logs/comments from secret leakage
- Improves incident traceability with op IDs

**Trade-offs:**
- Adds validation/error cases that users must handle
- Slightly more verbose command behavior/docs

**Implementation Notes:**
Align with existing Rust argument-array patterns already used in `botbox`.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -156,6 +156,24 @@
 - **Does not remove agent instructions** — prompts still describe the workflow. But agents that miss a step get it done correctly anyway because they call one command instead of six.

+## Security and Privacy Considerations
+
+1. **Agent identity trust boundary** — default to `$BOTBUS_AGENT` / config identity. If `--agent` overrides identity, require `--allow-impersonation` and emit warning.
+2. **Strict input validation** — validate `bead-id`, `workspace`, `project`, `agent`, and reviewer names against conservative regex patterns before subprocess calls.
+3. **No shell interpolation** — subprocesses must be argument-array invocations only (never shell strings).
+4. **Redaction policy** — redact tokens/secrets from tool stderr before writing bead comments or bus messages.
+5. **Least-privilege messaging** — avoid publishing sensitive local path details to shared channels unless required for recovery.
+6. **Auditability** — include `op-id` in bead comments and protocol logs for end-to-end traceability.
+
 ## Open Questions
```

---

### [Medium Impact, Low Effort] Change #6: Add rollout plan, observability, and measurable success criteria

**Current State:**
No phased rollout or quantitative acceptance thresholds.

**Proposed Change:**
Add explicit rollout phases and operational metrics with targets.

**Rationale:**
A change this cross-cutting should not go straight to default behavior without instrumentation and gates.

**Benefits:**
- Lowers rollout risk
- Makes proposal success objectively measurable
- Enables data-driven follow-up prioritization

**Trade-offs:**
- Requires instrumentation work up front
- Slower path to default-on

**Implementation Notes:**
Tie go/no-go to existing eval cadence and `status --format json` outputs.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -189,6 +189,29 @@
 **Why not:** The whole point is that agents call these from their prompts. CLI subcommands are the interface agents use.

+## Rollout, Observability, and Success Criteria
+
+### Rollout
+1. **Phase 0 (feature-flagged)** — ship protocol commands behind config (`protocol.enabled=false` by default).
+2. **Phase 1 (opt-in prompts)** — dev/worker/reviewer prompts prefer protocol commands with raw-command fallback.
+3. **Phase 2 (default-on)** — enable by default after two release cycles meeting success metrics.
+4. **Phase 3 (hardening)** — optionally warn on raw multi-step protocol sequences in docs/prompts.
+
+### Success Metrics (baseline -> target)
+- Orphaned-claim incidents per 100 bead completions: target `< 1`
+- Missing crash-recovery start comments per 100 starts: target `< 1`
+- Protocol command failure rate (excluding chaos tests): target `< 2%`
+- Median `protocol start` latency: target `<= 2.5s`
+- Median `protocol finish` latency (no merge path): target `<= 2.0s`
+
+### Observability
+- Emit structured step events (`cmd`, `op-id`, `step`, `duration_ms`, `result`)
+- Surface protocol health counters in `botbox status --format json`
+- Track top failure reasons to prioritize follow-up hardening
+
 ## Implementation Plan
```

---

### [High Impact, High Effort] Change #7: Expand implementation plan into phased deliverables + test matrix

**Current State:**
Implementation plan is concise but underspecified, especially testing and rollout gates (`notes/proposals/protocol-helpers.md:193`).

**Proposed Change:**
Rewrite implementation plan with explicit architecture, idempotency, testing layers, docs/migration, and release gates.

**Rationale:**
The current bullets are directionally good but too broad for execution accountability.

**Benefits:**
- Converts proposal into implementation-ready backlog structure
- Improves estimation and ownership assignment
- Ensures reliability/performance/security are built-in, not bolt-on

**Trade-offs:**
- More upfront planning effort
- More dependencies before "done"

**Implementation Notes:**
Keep steps independently shippable to reduce long-lived branch risk.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -191,12 +191,19 @@
 ## Implementation Plan

-1. **Core protocol module** — `src/commands/protocol.rs` with `start`, `finish`, `review`, `cleanup`, `resume` subcommands. Each is a sequence of `Tool::new(...)` calls with error handling and rollback.
-
-2. **Enhanced status** — Add advice generation to `src/commands/status.rs`. Cross-reference claims with bead status, detect orphans, suggest actions.
-
-3. **Integrate into agent prompts** — Update worker-loop, dev-loop, and reviewer-loop prompts to use `botbox protocol <step>` instead of raw tool sequences. Keep the raw commands documented as fallback.
-
-4. **Tests** — Integration tests that mock companion tools and verify correct call sequences and error handling.
-
-5. **Update workflow docs** — Rewrite start.md, finish.md, review-request.md to recommend protocol commands as primary interface.
+1. **Core protocol engine** — Add `src/commands/protocol.rs` plus typed operation structs (`StartOp`, `FinishOp`, `ReviewOp`, `CleanupOp`, `ResumeOp`) and shared preflight validation.
+2. **Operation journal + idempotency** — Implement `op-id` tracking and resumable step execution with compensation handlers.
+3. **Shared context collector** — Implement `ProtocolContext::collect(...)` and reuse it in protocol commands and status advice.
+4. **Enhanced status advice** — Cross-reference claims/workspaces/beads/reviews and attach actionable remediation commands.
+5. **Prompt integration (gated)** — Update worker/dev/reviewer prompts to prefer protocol commands under feature flag; preserve raw fallback during rollout.
+6. **Test matrix** — unit tests (validation + step ordering), integration tests (mock tool runner + failure injection), end-to-end tests (real tools in isolated temp dirs), and chaos/retry tests (idempotency + compensation).
+7. **Docs + migration** — Update workflow docs and AGENTS managed template; add migration notes and backward-compatibility guidance.
+8. **Release gates** — Define acceptance checklist tied to rollout metrics; enable default-on only after two consecutive green eval cycles.
```
