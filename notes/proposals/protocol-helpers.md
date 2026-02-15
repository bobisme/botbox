# Proposal: Protocol Helper Commands

**Status**: ACCEPTED
**Bead**: bd-hlai (merged with bd-2601)
**Author**: botbox-dev
**Date**: 2026-02-15

## Summary

Agent protocol violations are the #1 source of operational bugs in the botbox ecosystem. Agents forget claims, skip crash-recovery comments, merge without releasing claims, or call tools in the wrong order. The root cause is often not that agents can't execute commands — it's that they don't know what state they're in and what comes next.

This proposal adds read-only `botbox protocol <step>` subcommands that inspect cross-tool state and output the exact shell commands an agent should run next. Agents retain full control over execution while getting reliable, context-aware guidance.

If eval data later shows agents still violate protocols despite having exact commands, a second layer of mutating commands can be added on top of the same foundation.

## Motivation

Today, "starting work on a bead" requires agents to know and execute 6 sequential subprocess calls in the correct order. But agents don't have a way to ask "what should I do next?" — they must reconstruct the protocol from prompt instructions, which gets lost in long contexts.

The fix: give agents a single command that checks the current state and tells them exactly what to run.

### Pain points from evals and production

| Problem | Frequency | Root cause |
|---------|-----------|------------|
| Orphaned claims after bead close | Common | Agent doesn't know what cleanup steps remain |
| Missing crash-recovery comments | Common | Agent doesn't know the comment is part of the protocol |
| Workspace merged without releasing claim | Occasional | Agent knows `maw ws merge` but not the full sequence |
| Review requested without bus mention | Occasional | Agent creates crit review but doesn't know about the bus step |
| Agent starts work without checking for existing claim | Occasional | No way to check "am I already working on something?" |
| Duplicate beads from inbox | Common | No dedup guidance before creating |

### Why read-only first

Two observations led to this design:

1. **Agents mostly fail at knowing what to do, not doing it.** When an agent has the exact command to run, it runs it. The failure mode is forgetting a step or not knowing the current state — not being unable to execute `bus claims stake ...`.

2. **Mutating commands need the read-only layer anyway.** If `botbox protocol start` executes 6 steps and step 4 fails, the error message needs to explain the current state and what to do to recover. That error message IS the read-only layer. So read-only is the foundation regardless.

Building Layer 1 (read-only) first lets us eval whether agents follow explicit command guidance reliably. If they do, we're done. If not, Layer 2 (mutating) can be added on top with the read-only layer already providing preflight checks and error recovery output.

## Proposed Design

### Architecture: Two layers

```
Layer 2 (future, if needed): Mutating commands
  botbox protocol exec start <bead-id>  →  actually runs the commands
  Uses Layer 1 for preflight and error recovery
  ┌─────────────────────────────────────────┐
  │                                         │
Layer 1 (this proposal): Read-only guidance
  botbox protocol start <bead-id>  →  outputs commands to run
  botbox protocol finish <bead-id> →  outputs commands to run
  Shared context collector underneath
  └─────────────────────────────────────────┘
```

Layer 1 is the full scope of this proposal. Layer 2 is a future option, not committed to.

### Protocol invariants

These invariants define correctness. Protocol commands check for violations and warn when they're detected.

1. A bead in `in_progress` should have exactly one active `bead://` claim.
2. A claimed workspace should map to exactly one bead via claim memo and bead comments.
3. A bead should not be closed before its workspace is merged (except explicit `--no-merge` scenarios).
4. Claims should be acquired before state mutations; released after irreversible operations complete.

### Shared protocol context

An internal `ProtocolContext::collect(project, agent)` helper gathers and normalizes state used by all protocol commands and `botbox status`:

- `bus claims list --agent $AGENT --mine --format json` (agent's held claims)
- `maw ws list --format json` (all workspaces)
- `br` data for referenced beads only (avoid full scans)
- optional `crit` review status for referenced workspaces

This reduces subprocess calls across commands, keeps status advice and protocol guidance in sync, and creates a single test seam for failure injection.

Cache scope is per-command invocation (not cross-command) to avoid stale coordination state.

### Command rendering and shell safety

Protocol commands output shell commands that agents copy and execute. Dynamic values (bead titles, workspace names, agent names) must be safely escaped to prevent broken commands or injection.

**Rules:**
1. All dynamic string values in generated commands are shell-escaped (single-quoted with internal `'` escaped as `'\''`).
2. Bead IDs, workspace names, and agent names are validated against `[a-z0-9][a-z0-9-]*` before inclusion — values that fail validation cause the command to error, not render unsafe output.
3. Environment variable references (`$AGENT`, `$WS`, `$REVIEW_ID`) are never escaped — they expand at execution time.

Example with a title containing special characters:
```
bus send --agent $AGENT myproject 'Working on bd-xxx: Fix the "auth" bug (won'\''t break)' -L task-claim
```

### JSON output contract

All protocol commands share a common JSON envelope when `--format json` is used:

```json
{
  "schema": "protocol-guidance.v1",
  "command": "start",
  "status": "ready",
  "snapshot_at": "2026-02-15T20:00:00Z",
  "bead": { "id": "bd-xxx", "title": "Fix the auth bug" },
  "workspace": null,
  "review": null,
  "steps": [
    "bus claims stake --agent $AGENT \"bead://myproject/bd-xxx\" -m \"bd-xxx\"",
    "maw ws create --random"
  ],
  "diagnostics": [],
  "advice": "Capture workspace name from step 2, then run remaining steps."
}
```

**Status values** are a fixed enum: `ready`, `blocked`, `resumable`, `needs-review`, `has-resources`, `clean`, `has-work`, `fresh`.

**Evolution policy:** additive changes only (new fields, new status values). Removing or renaming fields requires a schema version bump. Prompt integrations should use `--format json` for stability; text format may change freely.

### New subcommands under `botbox protocol`

All protocol commands are **read-only** — they inspect state and output guidance. They never modify beads, claims, workspaces, or bus messages.

#### `botbox protocol start <bead-id>`

Check whether the agent can start work on a bead, and output the exact commands to run.

**Checks:**
1. Bead exists and is `open` (or `in_progress` already owned by `$AGENT`)
2. No conflicting `bead://` claim held by another agent
3. Agent doesn't already hold a different bead claim (warn about context switching)

**Output** (text format):
```
status  ready
bead  bd-xxx  "Fix the auth bug"

Run these commands to start:
  bus claims stake --agent $AGENT "bead://myproject/bd-xxx" -m "bd-xxx"
  maw ws create --random
  # capture workspace name from output, then:
  bus claims stake --agent $AGENT "workspace://myproject/$WS" -m "bd-xxx"
  maw exec default -- br update --actor $AGENT bd-xxx --status=in_progress --owner=$AGENT
  maw exec default -- br comments add --actor $AGENT --author $AGENT bd-xxx "Started in workspace $WS, agent $AGENT"
  bus send --agent $AGENT myproject "Working on bd-xxx: Fix the auth bug" -L task-claim
```

If the bead is already claimed:
```
status  blocked
bead  bd-xxx  "Fix the auth bug"
reason  Bead claimed by other-agent (claim ck-abc, staked 12m ago)

No action available. Wait for other-agent to finish or release the claim.
```

If the agent already holds this bead (crash recovery):
```
status  resumable
bead  bd-xxx  "Fix the auth bug"
workspace  amber-reef
path  /home/bob/src/myproject/ws/amber-reef
review  none

You already hold this bead. Resume working in workspace amber-reef.
Files are at /home/bob/src/myproject/ws/amber-reef/
```

**Flags:**
- `--agent <name>` (or from `$BOTBUS_AGENT` / config)
- `--project <name>` (or from config)
- `--format json` — structured output for machine consumption
- `--dispatched` — omit bus announcement command from output

#### `botbox protocol finish <bead-id>`

Check whether the agent can finish a bead, and output the exact commands to run.

**Checks:**
1. Agent holds the `bead://` claim for this bead
2. Resolve workspace from claims
3. If reviews enabled: enforce review pass policy:
   - All required reviewers (from `.botbox.json` `review.reviewers`) have voted LGTM
   - No unresolved BLOCK vote after the latest LGTM
   - Diagnostics report which condition failed (`missing_approvals`, `newer_block_after_lgtm`)

**Output** (text format, review approved):
```
status  ready
bead  bd-xxx  "Fix the auth bug"
workspace  amber-reef
review  cr-2h1o  (LGTM by myproject-security)

Run these commands to finish:
  maw ws merge amber-reef --destroy
  maw exec default -- br close --actor $AGENT bd-xxx --reason="Completed"
  bus send --agent $AGENT myproject "Completed bd-xxx: Fix the auth bug" -L task-done
  bus claims release --agent $AGENT "bead://myproject/bd-xxx"
  bus claims release --agent $AGENT "workspace://myproject/amber-reef"
  maw exec default -- br sync --flush-only
```

If review is pending or blocked:
```
status  blocked
bead  bd-xxx  "Fix the auth bug"
workspace  amber-reef
review  cr-2h1o  (BLOCKED by myproject-security)
threads  2 unresolved

Address review feedback before finishing:
  maw exec amber-reef -- crit review cr-2h1o
  # Fix issues in ws/amber-reef/, then re-request:
  maw exec amber-reef -- crit reviews request cr-2h1o --reviewers myproject-security --agent $AGENT
  bus send --agent $AGENT myproject "Review updated: cr-2h1o @myproject-security" -L review-request
```

If no review exists and reviews are enabled:
```
status  needs-review
bead  bd-xxx  "Fix the auth bug"
workspace  amber-reef

Request a review before finishing:
  maw exec amber-reef -- crit reviews create --agent $AGENT --title "bd-xxx: Fix the auth bug" --reviewers myproject-security
  # capture review-id from output, then:
  maw exec default -- br comments add --actor $AGENT --author $AGENT bd-xxx "Review created: $REVIEW_ID in workspace amber-reef"
  bus send --agent $AGENT myproject "Review requested: $REVIEW_ID @myproject-security" -L review-request
```

**Flags:**
- `--agent`, `--project`, `--format json`
- `--no-merge` — output commands without merge step (for dispatched workers)
- `--force` — output finish commands even without review approval (with warning)

#### `botbox protocol review <bead-id>`

Check review state and output commands to request or re-request review.

**Checks:**
1. Agent holds the bead claim
2. Resolve workspace
3. Check for existing review in this workspace

**Output** (no existing review):
```
status  ready
bead  bd-xxx  "Fix the auth bug"
workspace  amber-reef
reviewers  myproject-security

Run these commands to request review:
  maw exec amber-reef -- crit reviews create --agent $AGENT --title "bd-xxx: Fix the auth bug" --reviewers myproject-security
  # capture review-id, then:
  maw exec default -- br comments add --actor $AGENT --author $AGENT bd-xxx "Review created: $REVIEW_ID in workspace amber-reef"
  bus send --agent $AGENT myproject "Review requested: $REVIEW_ID @myproject-security" -L review-request
```

**Output** (review exists, blocked):
```
status  blocked
bead  bd-xxx
workspace  amber-reef
review  cr-2h1o  (BLOCKED)
threads  2 unresolved

Read feedback and fix, then re-request:
  maw exec amber-reef -- crit review cr-2h1o
  # after fixing:
  maw exec amber-reef -- crit reviews request cr-2h1o --reviewers myproject-security --agent $AGENT
  bus send --agent $AGENT myproject "Review updated: cr-2h1o @myproject-security" -L review-request
```

**Flags:**
- `--agent`, `--project`, `--format json`
- `--reviewers <csv>` — override reviewers (default: `.botbox.json` `review.reviewers`)

#### `botbox protocol cleanup`

Check for held resources and output cleanup commands.

**Output:**
```
status  has-resources
claims  3 active (bead://myproject/bd-xxx, workspace://myproject/amber-reef, agent://myproject-dev)

Run these commands to clean up:
  bus send --agent $AGENT myproject "Agent idle" -L agent-idle
  bus statuses clear --agent $AGENT
  bus claims release --agent $AGENT --all
  maw exec default -- br sync --flush-only
```

Or if already clean:
```
status  clean
claims  0 active

No cleanup needed.
```

#### `botbox protocol resume`

Check for in-progress work from a previous session (crash recovery).

**Checks:**
1. Agent's held claims (`bead://` and `workspace://`)
2. Bead status and recent comments for each held bead
3. Review state for each associated workspace

**Output:**
```
status  has-work
held  1 bead

held-bead  bd-xxx  workspace=amber-reef  status=in_progress  review=cr-2h1o (LGTM)
  Review approved. Ready to finish:
    botbox protocol finish bd-xxx

held-bead  bd-yyy  workspace=frost-castle  status=in_progress  review=none
  No review yet. Continue working in ws/frost-castle/:
    # when ready for review:
    botbox protocol review bd-yyy
```

Or if no held work:
```
status  fresh
held  0 beads

No in-progress work found. Check for available beads:
  maw exec default -- br ready
```

### Enhanced `botbox status`

Enhance the existing `botbox status` command using the shared `ProtocolContext`:

1. **Advice generation** — analyze cross-tool state and emit actionable suggestions with commands:
   - "3 orphaned claims: bead closed but claim active → run `botbox protocol cleanup`"
   - "2 stale workspaces not associated with any claim"
   - "Review cr-xxx approved (LGTM) → run `botbox protocol finish bd-xxx`"
   - "5 ready beads available — run `maw exec default -- br ready`"

2. **Project scoping** — `--project <name>` filters to relevant claims/workspaces/beads

3. **Richer workspace details** — workspace names, associated beads, time since last activity

4. **Integration into prompts** — dev-loop and worker-loop call `botbox status --format json` once instead of 5+ separate tool calls

### Security considerations

1. **Strict input validation** — validate bead IDs, workspace names, project names, and agent names against conservative patterns before subprocess calls. Values that fail validation produce errors, not unsafe output.
2. **No shell interpolation** — all internal subprocesses use argument-array invocations (`Command::new` + `.args()`), never shell strings. This is already the pattern in `subprocess.rs`.
3. **Safe command rendering** — all dynamic values in generated shell commands are escaped via a single renderer function. See "Command rendering and shell safety" above.
4. **Least-privilege messaging** — output commands use `--agent $AGENT` (env var reference), not hardcoded agent names, so output is safe to log without leaking identity across sessions.

### What this does NOT do

- **Does not execute commands** — agents read the output and run the commands themselves. This keeps every step visible in `botty tail` and lets agents adapt if something fails.
- **Does not replace Claude's judgment** — agents still decide WHAT to work on, HOW to implement, WHETHER to request review.
- **Does not remove agent instructions** — prompts still describe the workflow. Protocol commands are a supplement, not a replacement.

### Future: Layer 2 (mutating commands)

If eval data shows agents still violate protocols despite having exact commands in front of them, a second layer can be added:

```
botbox protocol exec start <bead-id>   # actually runs the start sequence
botbox protocol exec finish <bead-id>  # actually runs the finish sequence
```

These would use Layer 1 for preflight (check state, detect conflicts) and error recovery (on failure, output the Layer 1 guidance for manual recovery). The read-only layer becomes the foundation for both the happy path and the error path.

Decision criteria for Layer 2: if agents follow >95% of protocol commands output by Layer 1 correctly, Layer 2 adds minimal value. If agents frequently skip steps or reorder commands despite having explicit guidance, Layer 2 is justified.

## Open Questions

(none — all resolved during validation)

## Answered Questions

1. **Q:** Should `protocol start` check for existing claims before reporting ready?
   **A:** Yes. Check for conflicting claims and report `blocked` status with details about who holds the claim.

2. **Q:** Should `protocol finish` check review status?
   **A:** Yes. Report `blocked` if review is pending/blocked, with commands to address feedback. `--force` outputs finish commands anyway with a warning.

3. **Q:** How should dispatched workers differ?
   **A:** `--no-merge` for finish (omit merge command), `--dispatched` for start (omit bus announcement command).

4. **Q:** How are reviewers selected?
   **A:** Default to `.botbox.json` `review.reviewers` mapped to `<project>-<role>`; `--reviewers` flag overrides.

5. **Q:** Should `protocol dispatch` be in scope?
   **A:** No — defer to follow-up. Dispatch is the most complex protocol sequence (workspace + name generation + 2 claims + bead comment with mission context + botty spawn with 6+ env vars). Read-only guidance would output ~15 lines of commands with variable interpolation chains — too much for copy-paste. Dispatch is the strongest candidate for a Layer 2 mutating command. Ship start/finish/review/cleanup/resume first, eval, then tackle dispatch.

6. **Q:** How verbose should command output be?
   **A:** Keep inline comments (lines starting with `#`) by default. They help agents understand multi-step sequences (e.g., "capture workspace name from output, then:"). Cost is ~20 tokens per command, benefit is agents not misunderstanding variable capture steps. No `--terse` mode for v1 — revisit if token usage becomes a measurable problem.

7. **Q:** Do the companion tool JSON APIs provide what `ProtocolContext` needs?
   **A:** Yes, validated against real data. `bus claims list --mine --format json` returns held claims with patterns and TTL. `maw ws list --format json` returns workspace names and metadata. `br show <id> --format json` returns bead status, owner, labels. `crit review <id> --format json` returns votes array with reviewer/vote/voted_at, thread status, and review status. `bus claims stake` fails with exit code 1 and clear conflict error on duplicate claims, confirming claims handle concurrency at execution time.

## Alternatives Considered

### A. Mutating commands only (previous version of this proposal)

Build `botbox protocol start/finish/review` as commands that execute the full sequence.

**Why not as v1:** Mutating commands need the read-only layer for preflight and error recovery anyway. Starting with read-only lets us eval whether agents need execution assistance or just guidance. Also: read-only is simpler to implement, easier to debug (every step visible in transcript), and has zero blast radius if botbox has a bug.

**Not rejected:** Preserved as Layer 2 option if eval data justifies it.

### B. Template-based shell scripts

Generate shell scripts that agents can source, e.g., `.agents/botbox/scripts/start-bead.sh bd-xxx`.

**Why not:** Shell scripts can't check cross-tool state, can't adapt output based on current conditions, can't return JSON, and the Rust binary already has the subprocess infrastructure.

### C. Enhanced status only (no protocol commands)

Just enhance `botbox status` with advice and let agents figure out the sequences from prompt instructions.

**Why not:** Status tells you WHAT the state is but not WHAT TO DO about it. Protocol commands bridge the gap by outputting concrete, copy-pasteable commands for each protocol step. The status enhancement is still part of this proposal, but protocol commands are the main value.

## Rollout

1. **Ship Layer 1** — implement read-only protocol commands and enhanced status. Test with integration tests and manual eval runs.
2. **Update prompts** — modify worker-loop, dev-loop, and reviewer-loop prompts to call `botbox protocol <step>` at each protocol transition. Agent reads output and executes the suggested commands.
3. **Eval** — run standard evals. Measure protocol violation rate compared to baseline. If agents follow guidance reliably (>95%), Layer 1 is sufficient. If not, proceed to Layer 2.
4. **Layer 2 (conditional)** — if eval data justifies it, add `botbox protocol exec <step>` mutating commands on top of Layer 1.

## Implementation Plan

1. **Shared context collector** — `ProtocolContext` in `src/commands/protocol/context.rs`. Gathers claims, workspaces, bead state, and review state in minimal subprocess calls. Used by all protocol commands and enhanced status.

2. **Core protocol subcommands** — `src/commands/protocol/` module with `start.rs`, `finish.rs`, `review.rs`, `cleanup.rs`, `resume.rs`. Each checks state via `ProtocolContext`, determines status (ready/blocked/resumable/etc), and formats output with concrete commands. Wire into CLI via `botbox protocol <subcommand>`.

3. **Enhanced status** — Add advice generation to `src/commands/status.rs` using `ProtocolContext`. Cross-reference claims with bead status, detect orphans, suggest `botbox protocol` commands.

4. **Output formatting** — Support text (default, human/agent-readable with commands), json (structured, for programmatic use in prompts), and pretty (colored, for human TTY).

5. **Tests** —
   - Unit tests for state analysis and status determination
   - Rendering tests for shell-safe command output (titles with quotes, special chars, unicode, empty strings)
   - Contract tests for JSON schema version and status enum completeness
   - Integration tests with mock tool runner for various state combinations
   - E2e tests with real tools in isolated temp dirs (`BOTBUS_DATA_DIR`)

6. **Integrate into agent prompts** — Update worker-loop, dev-loop, and reviewer-loop prompts to call `botbox protocol <step>` at each protocol transition point. Agent reads output, runs the suggested commands.

7. **Update workflow docs** — Update start.md, finish.md, review-request.md to show `botbox protocol` as the recommended way to know what to do next.

---

## Appendix A: Review Response

Review: `notes/proposals/protocol-helpers.review.1.md`

The original proposal was reviewed when it was designed around mutating commands (Layer 2). After discussion with the project owner, the proposal was restructured around read-only guidance (Layer 1) as the foundation, with mutating commands as a future option. Many review suggestions remain relevant to the read-only design.

### Change #1: Reorder start/finish steps — ACCEPTED (adapted)

The reviewer correctly identified that claim-before-mutate prevents race conditions and merge-before-close prevents inconsistent state. In the read-only design, this translates to: the output commands are ordered correctly (claim first, then mutate; merge first, then close). The invariants and correct ordering are documented in "Protocol invariants."

### Change #2: Saga + idempotency journal — REJECTED

**Accepted:** The invariants (bead in_progress ↔ exactly one claim, workspace ↔ one bead, etc.) are documented.

**Rejected:** Formal op-id journal + resume machinery. Read-only commands don't need saga semantics — they just inspect state and report. Crash recovery is handled by `protocol resume` reading claims + bead comments. If Layer 2 is implemented later, this may be revisited.

### Change #3: Resolve policy ambiguities — ACCEPTED

All four policy decisions moved to "Answered Questions."

### Change #4: Shared protocol context collector — ACCEPTED

`ProtocolContext::collect()` is the core of the read-only design. All commands share the same state gathering, reducing subprocess calls and ensuring consistent guidance.

### Change #5: Security guardrails — PARTIALLY ACCEPTED

**Accepted:** Input validation, no shell interpolation, least-privilege output.

**Rejected:** `--allow-impersonation` (no identity override in read-only commands), formal redaction policy (premature).

### Change #6: Rollout plan — ADAPTED

Restructured as: ship Layer 1 → update prompts → eval → Layer 2 conditional. Feature flags and metric gates rejected as unnecessary ceremony.

### Change #7: Expanded implementation plan — PARTIALLY ACCEPTED

Accepted granular deliverable structure. Rejected operation journal, chaos tests, formal release gates.

## Appendix B: Review Response (Round 2)

Review: `notes/proposals/protocol-helpers.review.2.md`

### Change #1: Guidance freshness / TOCTOU — REJECTED (timestamp accepted)

The concern is valid — state can change between guidance output and execution. But the protection already exists at execution time: `bus claims stake` fails if someone else claimed first. The claim system IS the concurrency control. Adding `valid_for_sec`, `revalidate_command`, and `--max-age-sec` builds a caching/invalidation protocol on top of a simple "check state, print commands" tool. If a command fails because state changed, the agent naturally re-runs the protocol command.

**Accepted:** `snapshot_at` timestamp in JSON output for debugging/observability. Added to the JSON output contract.

**Rejected:** TTL semantics, `valid_for_sec`, `revalidate_command`, `--max-age-sec`. Solving a problem the claim system already solves.

### Change #2: Shell quoting — ACCEPTED (modified approach)

Real bug — bead titles with quotes or special characters would produce broken shell commands. The reviewer proposed ID-only messages by default with `--include-title` opt-in. We instead adopted always-include-titles with proper shell escaping via a single renderer function. Titles in bus messages and comments are valuable for human readability and `botty tail` debugging. Added "Command rendering and shell safety" section with escaping rules.

### Change #3: Review approval policy — PARTIALLY ACCEPTED

The gap is real for multi-reviewer setups. Added explicit review-pass criteria to `protocol finish`: all configured reviewers must have LGTM'd, no BLOCK after latest LGTM. Diagnostics (`missing_approvals`, `newer_block_after_lgtm`) report which condition failed.

Detailed multi-reviewer resolution logic (quorum voting, per-reviewer thread tracking) is deferred to crit — botbox should consume crit's review status, not reimplement it.

### Change #4: Stable output contract / JSON schema — PARTIALLY ACCEPTED

**Accepted:** `schema` version field, normalized status enum, additive-change evolution policy. Added "JSON output contract" section.

**Rejected:** Full per-step structured model (`id`, `command`, `preconditions[]`, `purpose`). Over-specified for v1 — we'd be designing an API before we know how prompts consume the output. Steps are rendered as a string array in JSON; structured step metadata can be added later if prompt integrations need it.

### Change #5: Rollout metrics — REJECTED

Same feedback as review 1's Change #6. Formal baseline windows, acceptance rules, and rollback triggers are more process than we need. We run evals, watch agents, iterate.

### Change #6: Expanded test plan — PARTIALLY ACCEPTED

**Accepted:** Rendering tests for shell safety (directly tied to #2) and contract tests for JSON schema stability. Added both to the test plan.

**Rejected:** Race-window tests. Protocol commands are read-only — they can't prevent races, that's what claims do at execution time. Testing "what if state changes between output and execution" is testing the claim system, not protocol commands.

## Appendix C: Design Evolution

This proposal went through four design iterations:

1. **v1 (original):** Mutating commands that execute protocol sequences. `botbox protocol start <id>` runs 6 commands atomically.

2. **v2 (post-review):** Mutating commands with stronger invariants, compensation policies, and shared context collector. Incorporated reviewer feedback on step ordering and policy ambiguity.

3. **v3 (read-only pivot):** Read-only guidance commands. Restructured after recognizing that (a) agents mainly fail at knowing what to do, not doing it, and (b) mutating commands need the read-only layer anyway for preflight and error recovery. Layer 2 preserved as future option gated on eval data.

4. **v4 (current):** Hardened read-only design. Added shell-safe command rendering, JSON output contract with schema versioning, explicit review-pass policy for multi-reviewer setups, and rendering/contract tests. Incorporated round 2 review feedback.
