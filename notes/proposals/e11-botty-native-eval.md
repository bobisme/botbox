# Proposal: E11 — Botty-Native End-to-End Eval

**Status**: ACCEPTED
**Author**: botbox-dev
**Date**: 2026-02-07
**Bead**: bd-ydxa

## Summary

A new eval type that tests the full botbox spawn chain by sending a task-request on a channel and observing what happens — no hand-crafted phase prompts, no sequential `claude -p` invocations. The eval watches as hooks fire, botty spawns agents, loop scripts drive behavior, and agents coordinate through the real tool suite.

E10 tests "can agents use the tools correctly?" E11 tests "does the whole system actually work?"

## Motivation

The current eval suite has a blind spot. E10 simulates the agent workflow with controlled prompts, but the real system has multiple untested layers:

| Layer | Tested by E10? | Tested by E11? |
|-------|---------------|---------------|
| Agent tool usage (bus, br, maw, crit) | Yes | Yes |
| Agent prompts (worker-loop.md, review-loop.md) | Approximated | Real prompts |
| Loop scripts (dev-loop.mjs, reviewer-loop.mjs) | No | Yes |
| Hook registration and firing | Partially (4.5) | Yes |
| botty spawn and PTY management | No | Yes |
| Iteration control (max_loops, pause, timeout) | No | Yes |
| Crash recovery within loop scripts | No | Yes |
| Inter-iteration state (journal files, claim renewal) | No | Yes |

Concrete things that could break without E11 catching them:
- dev-loop.mjs's `has_work()` function returns wrong result → agent sits idle
- reviewer-loop.mjs doesn't iterate workspaces via `maw ws list` + `crit inbox` per workspace correctly → reviews never picked up
- Hook command format changes after a migration → botty spawn fails silently
- `--pass-env` doesn't forward `BOTBUS_AGENT` → spawned agent has no identity
- Loop script exit conditions fire too early → agent quits mid-task
- botty spawn timeout too short → agent killed before finishing

## Design

### Complexity tiers

#### E11-L1: Single project, dev agent only (no review)

The simplest possible botty-native eval. Tests the core spawn chain.

**Setup**:
- 1 Rust project (Axum, like E10's Alpha but simpler — no planted vulnerability)
- Tools: beads, maw, crit, botbus, botty
- 1 bead: "Add GET /version endpoint returning `{"name":"myproject","version":"0.1.0"}`"
- Register dev-loop hook on the project channel
- Send task-request to channel

**What happens** (expected):
1. Hook fires → botty spawns dev agent running dev-loop.mjs
2. dev-loop.mjs iteration 1: triage inbox, find bead, claim it
3. dev-loop.mjs: create workspace, implement, describe commit
4. dev-loop.mjs: since review is enabled and reviewer is configured, request review
5. No reviewer spawns (no reviewer hook in L1) → agent may skip review or mark as self-reviewed
6. dev-loop.mjs: merge workspace, close bead, release claims, sync

**Scoring** (50 pts):

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Hook fired and agent spawned | 5 | `botty list` showed agent during run |
| Bead claimed (in_progress) | 5 | `br show` |
| Workspace created | 5 | `maw ws list` during run (check botty tail) |
| Code implemented and compiles | 10 | `cargo check` on main after merge |
| Workspace merged | 5 | No non-default workspaces remain |
| Bead closed | 5 | `br show` status=closed |
| Claims released | 5 | `bus claims list` (only agent:// from hooks) |
| Agent exited cleanly | 5 | botty shows no running agents after timeout |
| Bus labels correct | 5 | `bus history` shows task-claim, task-done |

**Timeout**: 10 minutes. If bead not closed by then, score what's observable.

#### E11-L2: Single project, dev + reviewer (review cycle)

Adds the review spawn chain. This is the key test — does the @mention hook fire the reviewer?

**Setup**:
- 1 Rust project with planted defect (e.g., path traversal in `GET /files/:name`)
- 1 bead: "Add GET /files/:name endpoint"
- Register dev-loop hook AND reviewer hook (alpha-security @mention)
- Send task-request to channel

**What happens** (expected):
1. Hook fires → dev agent spawns via dev-loop.mjs
2. Dev implements endpoint (likely with the path traversal — doesn't know it's a bug)
3. Dev creates review, sends `@alpha-security` mention on bus
4. Reviewer hook fires → botty spawns reviewer via reviewer-loop.mjs
5. Reviewer reads code from workspace, finds path traversal, blocks
6. Dev reads block, fixes in workspace, re-requests review
7. Reviewer re-reviews, LGTMs
8. Dev merges, closes bead, releases claims

**Scoring** (100 pts):

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Dev agent spawned via hook | 5 | botty tail / botty list |
| Bead triaged and claimed | 10 | br show: in_progress, bus claims |
| Workspace created | 5 | maw ws list |
| Code implemented | 10 | cargo check in workspace (via botty tail) |
| Review created with @mention | 10 | crit reviews list, bus history |
| Reviewer spawned via hook | 5 | botty list shows reviewer |
| Reviewer found defect | 10 | crit review shows block with relevant comment |
| Dev fixed defect | 10 | code inspection on main post-merge |
| Reviewer LGTMd | 10 | crit review shows lgtm |
| Workspace merged, bead closed | 5 | maw ws list, br show |
| Claims released | 5 | bus claims list |
| Code compiles on main | 5 | cargo check |
| Bus labels and identity correct | 5 | bus history audit |
| Both agents exited cleanly | 5 | botty list empty |

**Timeout**: 20 minutes. The review cycle adds latency — dev must wait for reviewer, which is a separate botty spawn.

**Key risk**: The review cycle requires two separate botty agents to coordinate asynchronously. If the reviewer hook doesn't fire, or the dev agent doesn't wait for the review result, the cycle breaks. This is exactly what we want to test.

#### E11-L3: Two projects, full lifecycle (E10-equivalent)

Same scenario as E10 but through the real system. Only attempt after L1 and L2 validate the approach.

**Setup**: Same as E10 (Alpha + Beta, planted defects, 3 agents).
**Difference**: Instead of 8 sequential `claude -p` phases, send one task-request and let everything unfold autonomously.

**Scoring**: Same rubric as E10 (160 pts workflow) plus friction (40 pts), scored on outcomes.

**Timeout**: 45 minutes. Cross-project communication adds unpredictable latency.

**Open question**: Can dev-loop.mjs handle the "wait for beta to fix the bug" pause? Currently the loop script iterates continuously — it doesn't have a "blocked on external dependency, wait for bus message" mode. This might require a script change, which would be a real finding from the eval.

### Observation approach

Since there are no phase boundaries, observation uses polling + event-driven checks:

**During the run** (real-time monitoring):
```bash
# Watch agent output
botty tail <name> --follow

# Stream bus messages
bus watch --channel <project>

# Poll periodically
while true; do
  botty list --format json
  br show <bead> --format json
  bus claims list --format json
  sleep 30
done
```

**After the run** (scoring):
```bash
# Agent logs (primary scoring data)
botty tail <name> --last 500 > artifacts/agent-<name>.log

# Channel history
bus history <channel> -n 50 > artifacts/channel.log

# Final state
br show <bead>
maw ws list --format json
crit reviews list --format json
bus claims list --format json
cargo check
```

The run script captures these into `$EVAL_DIR/artifacts/` for post-mortem scoring, same as E10.

### Differences from botty tail output vs phase stdout logs

E10's phase logs use `botbox run-agent` which produces clean tool-call-and-result output. botty tail output is raw PTY output with ANSI escape codes, spinner frames, and potentially interleaved stdout/stderr.

The friction extraction script needs to handle both formats. Options:
1. Strip ANSI codes with `sed` before analysis
2. Use `botbox run-agent` inside botty spawn (if the loop scripts support it)
3. Parse the raw PTY output with regex patterns for tool calls

Option 1 is simplest and most robust.

### Timeout and stuck detection

| Level | Overall Timeout | Stuck Threshold |
|-------|----------------|-----------------|
| L1 | 10 min | 3 min no bus/bead activity |
| L2 | 20 min | 5 min no activity |
| L3 | 45 min | 5 min no activity |

"Stuck" = no new bus messages from any agent AND no bead status changes AND no new crit events.

On timeout or stuck: `botty kill` all agents, capture final state, score what's observable.

## Risks

1. **Non-determinism**: Agents make autonomous decisions. Results may vary across runs. Mitigation: run multiple times, establish baselines. E10 showed high reproducibility (158 vs 159) — if the system is reliable, E11 should be too.

2. **Loop script bugs mask agent capability**: If dev-loop.mjs has a bug (e.g., wrong `has_work()` logic), E11 scores low even if the agent would have been fine with a correct script. This is actually desirable — we want to find these bugs — but complicates attribution.

3. **botty reliability**: botty must handle PTY management correctly throughout the run. If botty drops the session or misroutes input, the eval fails for infrastructure reasons. Mitigation: start with L1 (single agent, simple task) to validate botty works.

4. **Cost unpredictability**: Agents in loop scripts iterate until done. A stuck agent could burn API credits in a retry loop. Mitigation: `botty spawn --timeout` limits session duration. `.botbox.json` `agents.dev.timeout` controls per-agent timeout.

5. **Scoring difficulty**: Without phase boundaries, it's harder to attribute failures to specific steps. "The bead isn't closed" could mean the agent never triaged, or triaged but got stuck implementing, or implemented but couldn't merge. Mitigation: botty tail provides the full log — scoring requires reading it, same as E10 phase logs.

## Open Questions

1. **Does dev-loop.mjs support waiting for external events?** When alpha-dev discovers the beta bug in L3, it needs to wait for beta-dev to fix it. The current loop iterates continuously — does it handle "blocked on external" gracefully, or does it spin? This is a real question that E11-L3 would answer.

2. **How do we seed the task without triggering the hook prematurely?** In E10, we send the task-request during setup. But in E11, the hook is already registered — the task-request would fire the hook during setup. Options:
   - Register hook AFTER seeding the task (hook won't retroactively fire)
   - Send task-request as the last setup step (hook fires immediately, which is the point)
   - Use `bus send --no-hooks` if that exists (probably doesn't)

3. **Should E11 use the same planted defects as E10?** Using the same defects allows direct comparison. Using different defects tests generalization. Start with the same for comparability.

4. **How do we handle reviewer model selection?** In E10, each phase explicitly sets the model (Opus for security, Sonnet for beta). In E11, the model comes from `.botbox.json` agent config. We need to set `agents.reviewer.model: opus` in config.

## Answered Questions

1. **Is E11 a replacement for E10?** No. They measure different things. E10 (controlled) tests agent tool usage. E11 (uncontrolled) tests system integration. Both are valuable. Run E10v2 for tool UX iteration, E11 for system validation.

2. **Which tier to start with?** L1. It's the simplest (single agent, no review) and validates the core spawn chain. If L1 fails, we know botty/hooks/scripts have issues before attempting the complex L2/L3 scenarios.

3. **Where do scripts and rubrics go?** Same structure as E10: `evals/scripts/e11-*.sh` for scripts, `evals/rubrics.md` for rubrics, `evals/results/` for reports.

## Implementation Plan

### Phase 1: E11-L1

1. Write `evals/scripts/e11-l1-setup.sh` (single project, dev hook, task-request)
2. Write `evals/scripts/e11-l1-run.sh` (orchestrator: setup, wait, observe, capture)
3. Write `evals/scripts/e11-l1-verify.sh` (outcome checks)
4. Add E11-L1 rubric to `evals/rubrics.md`
5. Run E11-L1, score, write report
6. Iterate on stuck detection and timeout tuning

### Phase 2: E11-L2

7. Write `evals/scripts/e11-l2-setup.sh` (add reviewer hook, planted defect)
8. Write `evals/scripts/e11-l2-run.sh` (handle two agents, reviewer spawn)
9. Write `evals/scripts/e11-l2-verify.sh` (review cycle checks)
10. Add E11-L2 rubric to `evals/rubrics.md`
11. Run E11-L2, score, write report

### Phase 3: E11-L3 (only if L1+L2 work)

12. Adapt E10 setup for E11-L3 (two projects, three agents)
13. Write run and verify scripts
14. Add rubric, run, score, report

## Reference Files

### E10 infrastructure (patterns to adapt)
- `evals/scripts/e10-setup.sh` — Setup pattern
- `evals/scripts/e10-run.sh` — Orchestrator pattern
- `evals/scripts/e10-verify.sh` — Verification pattern
- `evals/rubrics.md` — Rubric patterns (E10 section, lines ~1182-1325)
- `notes/eval-framework.md` — Framework docs, report template
- `notes/proposals/e10-full-lifecycle-eval.md` — E10 original proposal

### Loop scripts (what E11 tests)
- `packages/cli/scripts/dev-loop.mjs` — Lead dev agent loop
- `packages/cli/scripts/agent-loop.mjs` — Worker agent loop
- `packages/cli/scripts/reviewer-loop.mjs` — Reviewer agent loop
- `packages/cli/scripts/respond.mjs` — Conversational responder
- `packages/cli/scripts/triage.mjs` — Token-efficient triage
- `packages/cli/scripts/iteration-start.mjs` — Combined status at iteration start
- `packages/cli/src/lib/scripts.mjs` — Script registry with eligibility rules

### Hook infrastructure (spawn chain)
- `packages/cli/hooks/init-agent.sh` — Session start hook
- `packages/cli/hooks/check-jj.sh` — jj reminder hook
- `packages/cli/hooks/check-bus-inbox.sh` — Inbox check hook
- `packages/cli/src/lib/hooks.mjs` — Hook registry
- `packages/cli/src/migrations/index.mjs` — Hook registration via migrations

### Agent configuration
- `.botbox.json` — Agent config (model, timeout, max_loops, pause per agent type)

### Workflow docs (agent prompts used by loop scripts)
- `packages/cli/docs/worker-loop.md` — Full triage-work-finish lifecycle
- `packages/cli/docs/start.md` — Claim bead, create workspace
- `packages/cli/docs/finish.md` — Close bead, merge, release
- `packages/cli/docs/review-request.md` — Request a review
- `packages/cli/docs/review-response.md` — Handle reviewer feedback
- `packages/cli/docs/review-loop.md` — Reviewer agent loop

### Botty (agent runtime)
- See CLAUDE.md botty section: spawn, tail, list, kill, send

### Previous E10 runs (baseline comparison)
- `evals/results/2026-02-06-e10-run1-opus.md` — E10-1: 158/160
- `evals/results/2026-02-07-e10-run2-opus.md` — E10-2: 159/160 + friction analysis
- `evals/results/README.md` — All 29 runs and key learnings

### Other eval patterns
- `evals/scripts/r6-*.sh` — R6 parallel dispatch (uses background `claude -p` processes, closest to E11's async nature)
- `evals/scripts/r9-*.sh` — R9 crash recovery (tests mid-task resume)
