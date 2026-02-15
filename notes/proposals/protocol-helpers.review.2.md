# Review: Protocol Helper Commands Proposal (Revision 2)

## Executive Summary

The revised proposal is materially stronger than the previous version: it now has a coherent Layer 1 (read-only) strategy, shared context collection, clearer scope boundaries, and pragmatic rollout sequencing.

The biggest remaining risks are correctness-at-runtime gaps between read and execute (TOCTOU), shell-safety/quoting for generated commands, ambiguous multi-reviewer approval semantics, and the lack of a formal output contract for prompt integrations.

The changes below focus on making the design safer, more machine-reliable, and easier to evolve without breaking agent prompts.

## Proposed Changes

### [High Impact, Low Effort] Change #1: Add guidance freshness and revalidation semantics

**Current State:**
Layer 1 is read-only and outputs commands, but the plan does not define how long that guidance remains valid after state is read.

**Proposed Change:**
Define a snapshot/freshness contract (`snapshot_at`, `valid_for_sec`) and require explicit revalidation guidance in output.

**Rationale:**
In a multi-agent system, state can change between `botbox protocol start` output and command execution. Without freshness semantics, stale guidance can produce protocol violations even when guidance is correct at generation time.

**Benefits:**
- Reduces race-condition errors in concurrent workflows
- Gives agents deterministic recovery behavior when state changes
- Makes read-only guidance safer without introducing mutation

**Trade-offs:**
- Slightly more verbose output
- Prompts must handle stale guidance branch

**Implementation Notes:**
Keep freshness metadata in both text and json. Add a default TTL (for example, 30s) and a global override flag.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -84,6 +84,23 @@
 ### New subcommands under `botbox protocol`

 All protocol commands are **read-only** — they inspect state and output guidance. They never modify beads, claims, workspaces, or bus messages.
+
+### Guidance freshness and race handling
+
+Protocol guidance is snapshot-based. State may change between command output and execution.
+
+Every protocol output must include:
+- `snapshot_at` (UTC timestamp)
+- `valid_for_sec` (default 30)
+- `revalidate_command` (for example: `botbox protocol start <bead-id>`)
+
+If guidance is stale (`now - snapshot_at > valid_for_sec`) or if any precondition no longer holds, agents should re-run the protocol command before executing suggested steps.
+
+Global flag:
+- `--max-age-sec <n>` — override freshness window for this invocation
```

---

### [High Impact, Low Effort] Change #2: Harden command rendering against shell-quoting issues

**Current State:**
Examples interpolate dynamic text (for example bead titles) directly into shell commands.

**Proposed Change:**
Adopt a safe command rendering policy: default to ID-based messages, only include titles when explicitly requested, and guarantee escaping rules for all dynamic values.

**Rationale:**
Titles/comments may contain quotes or shell-sensitive characters. Since Layer 1 outputs executable commands, rendering safety is a correctness and security requirement.

**Benefits:**
- Prevents malformed command output and injection-style failures
- Improves reliability of copy/paste and agent execution
- Makes output deterministic across weird input data

**Trade-offs:**
- Slightly less descriptive default messages
- Additional formatter logic

**Implementation Notes:**
Prefer default bus/comment templates using bead IDs. Provide `--include-title` for human readability.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -102,12 +102,15 @@
 Run these commands to start:
   bus claims stake --agent $AGENT "bead://myproject/bd-xxx" -m "bd-xxx"
   maw ws create --random
   # capture workspace name from output, then:
   bus claims stake --agent $AGENT "workspace://myproject/$WS" -m "bd-xxx"
   maw exec default -- br update --actor $AGENT bd-xxx --status=in_progress --owner=$AGENT
-  maw exec default -- br comments add --actor $AGENT --author $AGENT bd-xxx "Started in workspace $WS, agent $AGENT"
-  bus send --agent $AGENT myproject "Working on bd-xxx: Fix the auth bug" -L task-claim
+  maw exec default -- br comments add --actor $AGENT --author $AGENT bd-xxx "Started in workspace $WS"
+  bus send --agent $AGENT myproject "Working on bd-xxx" -L task-claim
 ```
+
+By default, generated commands avoid interpolating untrusted title text. Use `--include-title` to request title-bearing messages.
@@ -312,6 +315,11 @@
 ### Security considerations

 1. **Strict input validation** — validate bead IDs, workspace names, project names, and agent names against conservative patterns before subprocess calls.
 2. **No shell interpolation** — all subprocesses use argument-array invocations (`Command::new` + `.args()`), never shell strings. This is already the pattern in `subprocess.rs`.
 3. **Least-privilege messaging** — output commands use `--agent $AGENT` (env var reference), not hardcoded agent names, so output is safe to log without leaking identity across sessions.
+4. **Safe command rendering** — dynamic values in generated shell commands must be escaped by a single renderer; prefer ID-only messages by default to avoid quoting hazards.
+5. **Title/comment opt-in** — include human title text only when explicitly requested (`--include-title`) and after escaping.
```

---

### [High Impact, Low Effort] Change #3: Formalize review approval policy for `finish`

**Current State:**
`finish` checks for LGTM, but policy details for multi-reviewer setups and unresolved threads are implicit.

**Proposed Change:**
Define explicit review-pass criteria and blocked diagnostics (`missing_approvals`, `unresolved_threads`, `newer_block_after_lgtm`).

**Rationale:**
Without a clear policy, two agents can interpret the same review state differently, causing inconsistent merge behavior.

**Benefits:**
- Predictable finish behavior across projects
- Better blocked guidance for agents
- Easier integration and unit test assertions

**Trade-offs:**
- Slightly more complex status evaluation logic
- Needs alignment with crit semantics

**Implementation Notes:**
Use `.botbox.json review.reviewers` as required reviewer set by default.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -143,7 +143,13 @@
 **Checks:**
 1. Agent holds the `bead://` claim for this bead
 2. Resolve workspace from claims
-3. If reviews enabled: check for LGTM approval
+3. If reviews enabled: enforce explicit review pass policy:
+   - all required reviewers (from `.botbox.json review.reviewers`) have approved
+   - no unresolved blocking threads
+   - no newer BLOCK after latest LGTM
+
+If policy fails, output `status  blocked` with machine-readable reasons (`missing_approvals`, `unresolved_threads`, `newer_block_after_lgtm`).
```

---

### [High Impact, High Effort] Change #4: Add stable output contract (json schema + status enums)

**Current State:**
The proposal includes examples and mentions `--format json`, but does not define a stable schema.

**Proposed Change:**
Define a versioned output contract with normalized statuses and a step list model used by both text and json renderers.

**Rationale:**
Prompt integrations depend on parseable structure. A stable contract avoids prompt breakage as command text evolves.

**Benefits:**
- Stronger API-like contract for agent loops
- Easier backwards-compatible evolution
- One internal model for text/json/pretty rendering

**Trade-offs:**
- Initial schema design and migration overhead
- Contract maintenance responsibility

**Implementation Notes:**
Include `schema_version` in json and document additive-change policy.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -386,6 +386,31 @@
 ## Implementation Plan

@@
 4. **Output formatting** — Support text (default, human/agent-readable with commands), json (structured, for programmatic use in prompts), and pretty (colored, for human TTY).
+
+### Output contract (v1)
+
+All protocol subcommands should render from a shared internal model:
+
+- `schema_version` (for example: `protocol-guidance.v1`)
+- `command` (`start|finish|review|cleanup|resume`)
+- `status` (`ready|blocked|resumable|needs-review|has-resources|clean|has-work|fresh`)
+- `diagnostics[]` (typed reasons)
+- `snapshot_at`, `valid_for_sec`
+- `steps[]` where each step has:
+  - `id`
+  - `command`
+  - `preconditions[]`
+  - `purpose`
+
+Text/pretty outputs are presentation layers over this model. Prompt integrations should prefer json to avoid brittle parsing.
```

---

### [Medium Impact, Low Effort] Change #5: Strengthen rollout with measurable baseline and rollback criteria

**Current State:**
Rollout has sequencing and a >95% threshold, but no baseline method, no explicit failure rollback trigger, and no metric definition details.

**Proposed Change:**
Add concrete measurement method, baseline window, and rollback conditions.

**Rationale:**
A clear adoption gate reduces risk and makes Layer 2 decisions evidence-based.

**Benefits:**
- Objective go/no-go criteria
- Faster detection of regressions after prompt updates
- Better audit trail for proposal acceptance decisions

**Trade-offs:**
- More eval bookkeeping
- Slight process overhead

**Implementation Notes:**
Use existing eval harness and report format to minimize net cost.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -379,7 +379,18 @@
 ## Rollout

 1. **Ship Layer 1** — implement read-only protocol commands and enhanced status. Test with integration tests and manual eval runs.
 2. **Update prompts** — modify worker-loop, dev-loop, and reviewer-loop prompts to call `botbox protocol <step>` at each protocol transition. Agent reads output and executes the suggested commands.
-3. **Eval** — run standard evals. Measure protocol violation rate compared to baseline. If agents follow guidance reliably (>95%), Layer 1 is sufficient. If not, proceed to Layer 2.
+3. **Eval** — run standard evals with explicit baseline and acceptance rules:
+   - baseline: last 5 comparable eval runs before prompt integration
+   - success: protocol violations reduced by >=30% and guidance-follow rate >=95%
+   - no-regression: task completion rate does not drop by >5%
+   - rollback: if no-regression fails in 2 consecutive runs, revert prompt integration and investigate
 4. **Layer 2 (conditional)** — if eval data justifies it, add `botbox protocol exec <step>` mutating commands on top of Layer 1.
```

---

### [Medium Impact, Low Effort] Change #6: Expand test plan to cover race, escaping, and contract stability

**Current State:**
Testing is defined, but key failure classes are not explicitly called out.

**Proposed Change:**
Add dedicated test categories for race windows, quoting edge cases, and output contract stability.

**Rationale:**
These are the most likely real-world breakpoints for a read-only command-generation layer.

**Benefits:**
- Catches high-risk defects early
- Prevents prompt breakage from format drift
- Improves confidence before rollout to default prompts

**Trade-offs:**
- More test fixtures and maintenance
- Slightly longer CI/runtime

**Implementation Notes:**
Add golden json tests and fuzz-like title/comment fixtures.

**Git-Diff:**
```diff
--- ws/default/notes/proposals/protocol-helpers.md
+++ ws/default/notes/proposals/protocol-helpers.md
@@ -394,7 +394,16 @@
 4. **Output formatting** — Support text (default, human/agent-readable with commands), json (structured, for programmatic use in prompts), and pretty (colored, for human TTY).

-5. **Tests** — Unit tests for state analysis and command generation. Integration tests with mock tool runner to verify correct output for various state combinations. E2e tests with real tools in isolated temp dirs (`BOTBUS_DATA_DIR`).
+5. **Tests** —
+   - unit tests for state analysis and status transitions
+   - contract tests for json schema/version and status enums
+   - rendering tests for shell-safe command output (quotes/special chars in bead titles/comments)
+   - race-window tests (state changes between guidance generation and execution simulation)
+   - integration tests with mock tool runner for state combinations
+   - e2e tests with real tools in isolated temp dirs (`BOTBUS_DATA_DIR`)

 6. **Integrate into agent prompts** — Update worker-loop, dev-loop, and reviewer-loop prompts to call `botbox protocol <step>` at each protocol transition point. Agent reads output, runs the suggested commands.
```
