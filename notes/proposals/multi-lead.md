# Proposal: Multiple Concurrent Dev Leads Per Project

**Status**: ACCEPTED
**Bead**: bd-3145
**Author**: botbox-dev
**Date**: 2026-02-12

## Summary

Today, each botbox project runs at most one dev-loop orchestrator at a time. A single `agent://project-dev` claim gates the router hook — when one dev-loop is running, new messages queue until it finishes. A 20-minute mission blocks all new work, even a 2-minute bug fix.

This proposal enables multiple concurrent dev-loop leads. Two modes:

- **Targeted**: `!mission <spec>` or `!mission <bead-id>` spawns one lead scoped to that bead.
- **Self-directing**: `!leads N` spawns N leads that find work from `br ready`.

All leads are ephemeral (work, merge, exit) and hook-triggered via router.mjs (renamed from respond.mjs). A merge mutex (`workspace://project/default` claim) serializes merges while allowing unbounded parallel work.

## Scope

### Goals

1. Multiple dev-loop instances run concurrently, each handling independent work.
2. Merges are serialized through the merge mutex — no divergent commits.
3. Leads avoid duplicate work through bead claims.
4. `!mission <spec>` spawns a targeted lead. `!leads N` spawns N self-directing leads.
5. Single-lead behavior preserved when `multiLead.enabled` is false.

### Non-Goals

- Cross-lead mission coordination (leads sharing children within a single mission).
- Persistent/daemon leads (leads are ephemeral — spawned by hooks, exit when done).
- Dynamic load balancing between leads.

### Success Criteria

- Two concurrent `!mission` messages each get their own lead and complete independently.
- `!leads 3` spawns 3 leads that divide ready beads without duplication.
- Merge mutex prevents concurrent squash-merges — verified by no divergent commits.
- Duplicate delivery of the same `BOTBUS_MESSAGE_ID` never creates duplicate beads or leads.
- No regression in single-lead E11-L4 eval scores.

## Motivation

The current architecture has one fundamental constraint: **one dev-loop per project at a time.**

```
Message arrives → Router hook checks agent://botbox-dev claim
                  → Claim held? → Message queued (hook doesn't fire)
                  → Claim free? → Spawn respond.mjs → exec dev-loop → claim held
```

This means:
1. **Serialized missions.** A 20-minute mission blocks a 2-minute bug fix.
2. **Wasted parallelism.** The project has capacity for many concurrent workspaces, but only one orchestrator.
3. **Human frustration.** `!dev fix the typo` while a mission runs gets no response until it completes.
4. **Underutilized infrastructure.** Bus, maw, botty, and beads all support concurrent access. Only the dev-loop is a singleton.

## Proposed Design

### Design Principles

- **Everything through hooks.** Leads are spawned by bus hooks via router.mjs. No separate CLI command or daemon.
- **Claims as coordination.** All lead coordination uses bus claims — existing primitives, no new infrastructure.
- **Merge mutex, not work mutex.** Work happens in parallel. Only merges into default are serialized.
- **Numbered lead slots as identities.** Each lead gets a slot number (e.g., `botbox-dev/0`). The slot claim is both admission control and identity.
- **Backwards compatible.** `multiLead.enabled=false` preserves current single-lead exec behavior.

### 1. Lead Identity

Each lead gets a numbered slot. The slot number IS the identity:

```
botbox-dev/0                  # first lead (slot 0)
botbox-dev/1                  # second lead (slot 1)
botbox-dev/0/<worker-name>    # workers spawned by lead 0
```

**Claims used:**

```bash
# Lead slot + identity (one claim does both)
agent://botbox-dev/0
agent://botbox-dev/1

# Lead's workers
agent://botbox-dev/0/frost-castle

# Merge mutex (shared — only one lead at a time)
workspace://botbox/default

# Message idempotency (prevents duplicate processing)
message://botbox/<message-id>

# Bead claims (unchanged — one lead per bead)
bead://botbox/bd-xxx

# Workspace claims (unchanged — one lead per workspace)
workspace://botbox/amber-reef
```

### 2. Router Hook

**Current:** `agent://project-dev` claim gates the hook. Fires only when no dev-loop is running.

**New:** `agent://project-router` claim gates the hook. Short-lived — held only during message intake.

```bash
bus hooks add --agent botbox-dev \
  --channel botbox \
  --claim "agent://botbox-router" \
  --claim-owner botbox-dev \
  --cwd "$PROJECT" \
  --ttl 60 \
  -- botty spawn --env-inherit BOTBUS_CHANNEL,BOTBUS_MESSAGE_ID,BOTBUS_AGENT \
     --name "botbox-dev/router" \
     --cwd "$PROJECT" \
     -- bun .agents/botbox/scripts/router.mjs botbox botbox-dev
```

- **Claim is `agent://project-router`** (not `agent://project-dev`). Intake is serialized, execution is parallel.
- **Short TTL (60s)** bounds intake stalls. If router.mjs hangs, the claim expires.
- **router.mjs spawns leads** via `botty spawn` and exits quickly.

### 3. Router.mjs (renamed from respond.mjs)

The script's primary role is routing messages to handlers and spawning agents. Renamed to match.

**Message routing:**

| Command | Action |
|---------|--------|
| `!mission <spec>` | Create mission bead, spawn targeted lead |
| `!mission <bead-id>` | Spawn targeted lead for existing bead |
| `!leads N` | Spawn N self-directing leads |
| `!dev <desc>` | Create bead, spawn one lead for it |
| `!q` / `!qq` / `!bigq` | Handle inline (unchanged) |

**Lead slot acquisition:**

```javascript
async function acquireLeadSlot() {
  let maxLeads = config.agents?.dev?.multiLead?.maxLeads ?? 3
  for (let i = 0; i < maxLeads; i++) {
    let name = `${AGENT}/${i}`
    // Stake with --agent <leadName> so the LEAD can release it on exit
    let result = await runCommand("bus", [
      "claims", "stake", "--agent", name, `agent://${name}`, "--ttl", "900",
    ]).catch(() => null)
    if (result) return name
  }
  return null // all slots occupied
}
```

**Spawning a lead:**

```javascript
async function spawnLead(leadName, { mission } = {}) {
  await runCommand("botty", [
    "spawn",
    "--name", leadName,
    "--env-inherit", "BOTBUS_CHANNEL,BOTBUS_DATA_DIR",
    "--env", `BOTBUS_AGENT=${leadName}`,
    "--env", `BOTBUS_CHANNEL=${PROJECT}`,
    ...(mission ? ["--env", `BOTBOX_MISSION=${mission}`] : []),
    "--timeout", CLAUDE_TIMEOUT.toString(),
    "--cwd", process.cwd(),
    "--",
    "bun", ".agents/botbox/scripts/dev-loop.mjs", PROJECT, leadName,
  ])
  await runCommand("bus", [
    "send", "--agent", AGENT, PROJECT,
    `Spawned lead ${leadName}${mission ? ` for mission ${mission}` : ""}`,
    "-L", "spawn-ack",
  ])
}
```

**`!leads N` handler:**

```javascript
async function handleLeads(count) {
  let spawned = 0
  for (let i = 0; i < count; i++) {
    let leadName = await acquireLeadSlot()
    if (!leadName) {
      await runCommand("bus", ["send", "--agent", AGENT, PROJECT,
        `Spawned ${spawned}/${count} leads (${count - spawned} slots unavailable)`,
        "-L", "spawn-ack"])
      break
    }
    await spawnLead(leadName)
    spawned++
  }
}
```

**Message idempotency:**

Before processing any message, router.mjs gates on the message ID:

1. Read `BOTBUS_MESSAGE_ID` from environment.
2. Attempt `bus claims stake --agent $AGENT "message://${PROJECT}/${BOTBUS_MESSAGE_ID}" --ttl 10m`.
3. If the claim fails (already processed), exit 0.

**When `multiLead.enabled` is false:** router.mjs falls back to current behavior — `exec` into dev-loop, no slot claims.

### 4. Dev-Loop Changes

#### 4a. Merge Protocol

```
Before merging any workspace:

0. PREFLIGHT REBASE (outside mutex, reduces lock hold time):
   maw exec $WS -- jj rebase -d main

1. ACQUIRE MUTEX:
   bus claims stake --agent $AGENT "workspace://$PROJECT/default" --ttl 120 -m "merging $WS"
   If held by another lead: backoff+jitter (2s, 4s, 8s, 15s with +-30% jitter).
   Between retries, check bus history $PROJECT -L coord:merge -n 1 — retry immediately on new merge.
   If still held after mergeTimeoutSec: post to bus, move on to other work.

2. REBASE under mutex (authoritative — catches merges that landed during wait):
   maw exec $WS -- jj rebase -d main
   Check for conflicts. Resolve if needed.

3. MERGE: maw ws merge $WS --destroy

4. ANNOUNCE: bus send --agent $AGENT $PROJECT "Merged $WS (bead): summary" -L coord:merge

5. SYNC + RELEASE CHECK:
   maw exec default -- br sync --flush-only
   Check unreleased feat/fix commits, bump version if needed.

6. RELEASE MUTEX (in finally block):
   bus claims release --agent $AGENT "workspace://$PROJECT/default"
```

The `--ttl 120` is a safety net — if a lead crashes, the claim expires after 2 minutes.

#### 4b. Bead Claim Checking

Before starting work on any bead:

```
- Check bus claims list --format json for bead://$PROJECT/<id>
- If claimed by another agent, skip this bead.
- Only claim beads you will immediately work on or dispatch.
```

#### 4c. Sibling Lead Discovery

At iteration start, discover other active leads:

```javascript
let baseAgent = AGENT.replace(/\/\d+$/, "")
let siblingLeads = claims.filter(c =>
  c.patterns?.some(p => p.match(new RegExp(`^agent://${baseAgent}/\\d+$`))) &&
  !c.patterns?.some(p => p.includes(AGENT))
)
```

Included in prompt: "Other leads active: botbox-dev/1 (working on bd-xxx)"

#### 4d. Targeted Mode

When `BOTBOX_MISSION` is set, skip triage — work only on that bead. Exit when done. This is existing behavior, unchanged.

#### 4e. Cleanup

```javascript
async function cleanup() {
  // Release merge mutex if held (prevents deadlock)
  await bus("claims", "release", "--agent", AGENT,
    `workspace://${PROJECT}/default`).catch(() => {})
  // Release slot claim (frees the slot for new leads)
  await bus("claims", "release", "--agent", AGENT,
    `agent://${AGENT}`).catch(() => {})
  // Kill child workers
  // ... existing cleanup ...
}
```

### 5. Config

```json
{
  "agents": {
    "dev": {
      "multiLead": {
        "enabled": false,
        "maxLeads": 3,
        "mergeTimeoutSec": 60
      }
    }
  }
}
```

- `multiLead.enabled` (default: false) — Feature flag. When false, router.mjs uses exec (current behavior).
- `multiLead.maxLeads` (default: 3) — Maximum concurrent leads. Enforced via atomic `agent://<project>-dev/<n>` slot claims.
- `multiLead.mergeTimeoutSec` (default: 60) — How long to wait for merge mutex before giving up.

### 6. Bus Message Conventions

| Label | Use |
|-------|-----|
| `coord:merge` | Lead announcing it merged a workspace into default. Body includes workspace name, bead ID, and summary. |
| `spawn-ack` | Router announcing it spawned a lead. |

## Implementation Plan

### Phase 1: Merge Mutex

Add merge mutex to dev-loop FINISH step. Add cleanup handler. Add `coord:merge` announcement. Single-lead only — no hook or router changes.

Files: `packages/cli/scripts/dev-loop.mjs`

Gate: E11-L4 eval shows no regression. Merge mutex claim/release works correctly.

### Phase 2: Router Rename + Multi-Lead Spawning

Rename respond.mjs → router.mjs. Change `exec` to `botty spawn` for `!dev`/`!mission`. Add `!leads N` route. Add numbered slot acquisition. Add message idempotency. Update SCRIPT_REGISTRY. Migration: update hook command path and claim URI.

Files: `packages/cli/scripts/router.mjs`, `packages/cli/src/commands/init.mjs`, `packages/cli/src/migrations/index.mjs`, `packages/cli/src/lib/scripts.mjs`, `packages/cli/src/lib/config.mjs`

Gate: `!mission <spec>` spawns a lead that works independently. `!leads 2` spawns two leads that find different beads.

### Phase 3: Dev-Loop Multi-Lead Awareness

Add sibling lead discovery at iteration start. Add bead claim checking before work. Add backoff+jitter merge wait with early wake on `coord:merge`.

Files: `packages/cli/scripts/dev-loop.mjs`

Gate: Two concurrent leads divide beads without duplication. Merges serialized correctly.

### Phase 4: Multi-Lead Eval

New eval: send two independent `!mission` messages simultaneously. Verify:
- Both get their own lead instance
- Both complete without interfering
- Merges serialized (no divergent commits)
- Bead claims prevent duplicate work
- Duplicate delivery: same `BOTBUS_MESSAGE_ID` twice produces exactly one lead
- Crash recovery: lead dies holding merge mutex, lock recovers after TTL
- Capacity: more than `maxLeads` requests — excess acknowledged

Files: `evals/scripts/multi-lead-{setup,run,verify}.sh`, `evals/rubrics.md`

Gate: Both missions complete with all beads closed. No divergent commits. Crash recovery test passes.

## Open Questions

### 1. How do leads divide ready beads?

First-come-first-served via bead claims. `bus claims stake` is atomic — only one claim per URI succeeds. The loser skips to the next bead.

### 2. What happens when two leads' workers edit the same file?

Handled by jj merge. When a lead acquires the merge mutex and rebases, jj detects conflicts. The lead resolves them before merging. Same as any concurrent workspace edits — multi-lead doesn't change it.

### 3. How does `!leads N` interact with `!mission`?

Both consume from the same slot pool. If all 3 slots are taken by `!leads 3`, a `!mission` can't spawn until a lead finishes and releases its slot. If this is too restrictive, increase `maxLeads`.

### 4. How do leads coordinate on releases?

Release check runs inside the merge mutex. After merging, while still holding `workspace://default`, the lead checks for unreleased feat/fix commits and bumps the version if needed.

### 5. What about `!q` conversation loop?

Question handling (`!q`, `!qq`, `!bigq`) continues to be handled inline by the router instance. These don't need a lead. Only work requests spawn leads.

## Risks and Mitigations

### Risk 1: Merge mutex deadlock

**Scenario:** Lead acquires mutex, crashes, never releases.
**Mitigation:** `--ttl 120` on the claim. Claim expires automatically. Cleanup handler releases on SIGINT/SIGTERM.

### Risk 2: Resource exhaustion

**Scenario:** 3 leads each spawn 4 workers = 15 concurrent sessions.
**Mitigation:** `maxLeads` × `maxWorkers` caps total. Default 3 × 4 = 12.

### Risk 3: Prompt complexity

**Scenario:** Adding lead discovery and merge protocol to the dev-loop prompt confuses the agent.
**Mitigation:** Phase 1 adds only merge mutex. Phase 3 adds lead discovery. Each gated by eval.

### Risk 4: Router fires too aggressively

**Scenario:** Every message spawns a router instance.
**Mitigation:** `agent://project-router` claim serializes intake. Short TTL bounds stalls. Router exits quickly after spawning or handling inline.

## Alternatives Considered

### Alternative 1: Persistent/Daemon Leads

Run N leads as long-lived processes that sleep when idle and wake on new beads.

**Rejected because:** Adds daemon lifecycle management (health checks, restart on crash, graceful shutdown). Hook-triggered ephemeral leads are simpler and consistent with existing botbox patterns.

### Alternative 2: Multiple Registered Hooks (One Per Lead)

Register N hooks with different claim URIs (`agent://project-dev-1`, `agent://project-dev-2`, etc.).

**Rejected because:** Static allocation — can't scale dynamically. Requires hook registration changes per project.

### Alternative 3: `botbox leads N` CLI Command

A separate CLI command (not hook-triggered) that spawns N leads directly.

**Rejected because:** Bypasses the bus hook system. All agent spawning should go through hooks for consistency and observability.

### Alternative 4: Single Lead with Inbox Multiplexing

Keep one dev-loop but make it check inbox at every checkpoint and start new work in parallel.

**Rejected because:** Overloads one context window. If the lead crashes, all concurrent work is orphaned. Multiple leads provide fault isolation.

### Alternative 5: Claude Code Agent Teams

Use `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` for multiple leaders.

**Rejected because:** Single fixed leader by design. No workspace isolation. Invisible to botty. Bypasses bus/claims infrastructure.

---

## Appendix: Review Responses (Round 1)

Review: `notes/proposals/multi-lead.review.1.md`

### Change #1: Select one router intake model and add message idempotency

**Verdict: Accepted.**

The `agent://project-router` claim is now the canonical intake model (formerly proposed as `respond://`, simplified to reuse the `agent://` prefix). The always-fire hook is a rejected alternative. Message idempotency via `message://<project>/<message-id>` claim is included.

### Change #2: Replace `botty list` admission with atomic lead-slot claims and durable queueing

**Verdict: Partially accepted (slots yes, queue no).**

Numbered slot claims (`agent://<project>-dev/<n>`) replace `botty list` counting — atomic and race-free. The slot number doubles as the lead's identity, eliminating a separate naming layer.

**Rejected: durable queue.** The bus channel is already the queue. When a lead finishes and releases its slot, the next message triggers the hook naturally. No second queue layer needed.

### Change #3: Upgrade merge mutex to an explicit lease protocol

**Verdict: Partially accepted (preflight rebase + backoff/jitter yes, refresh loop no).**

Preflight rebase outside the mutex reduces lock hold time. Backoff+jitter with early wake on `coord:merge` replaces fixed polling.

**Rejected: refresh loop.** `bus claims refresh` doesn't exist. The 120s TTL is long enough for any merge. If it takes longer, the TTL expiring is correct safety behavior.

### Change #4: Decouple release lock from merge lock

**Verdict: Rejected.**

Release checks are fast (10-15s). A separate `release://` lock doubles protocol surface area for minimal throughput gain. Keep release inside the merge critical section.

### Change #5: Add SLOs, telemetry, and alert thresholds

**Verdict: Rejected.**

Botbox has no metrics backend or alerting system. Eval scripts capture phase timing. `botty tail` and `bus history` provide observability.

### Change #6: Add security and abuse controls for lead-spawning paths

**Verdict: Rejected.**

Messages come from the human operator or their agents. No untrusted external input. `maxLeads` already caps concurrent execution.

### Change #7: Tighten execution plan details, eval breadth, and rollback strategy

**Verdict: Partially accepted (path fixes + eval cases yes, canary/rollback phase no).**

File path corrections applied. Eval test cases added (duplicate delivery, crash recovery, capacity overflow).

**Rejected: 7-day canary.** `multiLead.enabled=false` IS the rollback — a config flag on a local tool.
