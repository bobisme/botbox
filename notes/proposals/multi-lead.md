# Proposal: Multiple Concurrent Dev Leads Per Project

**Status**: PROPOSAL
**Bead**: bd-3145
**Author**: botbox-dev
**Date**: 2026-02-12

## Summary

Today, each botbox project runs at most one dev-loop orchestrator at a time. A single `agent://project-dev` claim gates the router hook — when one dev-loop is running, new messages queue until it finishes. This creates a throughput bottleneck: a 20-minute mission blocks all new work, even if the new task is independent.

This proposal enables multiple concurrent dev-loop orchestrators on the same project. Each lead runs its own mission or task set with its own workers, coordinating through bus claims and messages. The key insight: `workspace://project/default` serves as a merge mutex, serializing merges while allowing unbounded parallel work.

## Scope and Success Criteria

### Goals

1. Multiple dev-loop instances run concurrently on one project, each handling independent work.
2. Merges are serialized through the `workspace://default` claim — correct and deadlock-free.
3. Leads discover each other and avoid duplicate work through bus claims and messages.
4. The router hook spawns new leads for new messages while existing leads are busy.
5. Existing single-lead behavior is preserved when only one lead is active.

### Non-Goals

- Cross-lead mission coordination (leads sharing children within a single mission).
- Conflict resolution when two leads' workers edit the same file (handled by jj merge conflicts — lead resolves on merge).
- Dynamic load balancing between leads (each lead manages its own work independently).
- Changes to worker-to-worker coordination (already handled by mission-coordination-v2).

### Success Criteria

- Two concurrent `!mission` messages each get their own dev-loop instance and complete independently.
- Merge mutex prevents concurrent squash-merges into default — verified by no divergent commits.
- A lead that finishes merging releases the mutex, and the next waiting lead merges within 30 seconds.
- No regression in single-lead E11-L4 eval scores.

## Motivation

### The Single-Lead Bottleneck

The current architecture has one fundamental constraint: **one dev-loop per project at a time.**

```
Message arrives → Router hook checks agent://botbox-dev claim
                  → Claim held? → Message queued (hook doesn't fire)
                  → Claim free? → Spawn respond.mjs → exec dev-loop → claim held
```

This means:
1. **Serialized missions.** A 20-minute mission blocks a 2-minute bug fix from starting.
2. **Wasted parallelism.** The project has capacity for many concurrent workspaces, but only one orchestrator to use them.
3. **Human frustration.** Sending `!dev fix the typo` while a mission runs gets no response until the mission completes.
4. **Underutilized infrastructure.** Bus, maw, botty, and beads all support concurrent access. Only the dev-loop is a singleton.

### What Claude Code Agent Teams Don't Solve

Claude Code's experimental agent teams feature supports a single fixed leader with peer-capable teammates. There is no concept of multiple leaders. Their coordination is file-based (last-write-wins) with no workspace isolation. Our maw isolation is strictly better — concurrent leads can't overwrite each other's in-progress work.

This proposal puts botbox ahead of the state of the art for multi-agent project coordination.

## Proposed Design

### Design Principles

- **Claims as coordination primitive.** All lead-to-lead coordination happens through bus claims — the same mechanism already used for workers, beads, and workspaces. No new coordination infrastructure.
- **Merge mutex, not work mutex.** Work (coding, testing, reviewing) happens in parallel without locks. Only the merge into default is serialized, because jj squash-merge requires sequential access to the working copy.
- **Named leads with unique identities.** Each lead gets a unique name (e.g., `botbox-dev/lead-1`, `botbox-dev/lead-2`), enabling independent claim namespaces, bus message filtering, and botty observability.
- **Backwards compatible.** When only one lead runs, behavior is identical to today. Multi-lead is emergent — the router just spawns another instance.

### 1. Lead Identity and Naming

Each dev-loop instance gets a unique hierarchical name:

```
botbox-dev/lead-<suffix>     # generated via bus generate-name
botbox-dev/lead-<suffix>/<worker>  # workers spawned by that lead
```

The base agent `botbox-dev` remains the project's default identity for the router hook. Each spawned lead instance gets a unique sub-identity.

**Claim namespace:**

```bash
# Lead identity (each lead has its own)
agent://botbox-dev/lead-amber-reef

# Lead's workers
agent://botbox-dev/lead-amber-reef/worker-frost-castle

# Bead claims (unchanged — one lead per bead)
bead://botbox/bd-xxx

# Workspace claims (unchanged — one lead per workspace)
workspace://botbox/amber-reef

# NEW: Merge mutex (shared — only one lead at a time)
workspace://botbox/default
```

### 2. Router Hook Changes

**Current router hook (from init.mjs):**

```bash
bus hooks add --agent botbox-dev \
  --channel botbox \
  --claim "agent://botbox-dev" \
  --claim-owner botbox-dev \
  --cwd "$PROJECT" \
  --ttl 600 \
  -- botty spawn --env-inherit BOTBUS_CHANNEL,BOTBUS_MESSAGE_ID,BOTBUS_AGENT \
     --name botbox-dev \
     --cwd "$PROJECT" \
     -- bun .agents/botbox/scripts/respond.mjs botbox botbox-dev
```

This hook fires only when `agent://botbox-dev` is unclaimed. While a dev-loop runs, it holds this claim, so new messages are silently queued.

**New router hook:**

Replace the single claim-gated hook with a hook that always fires but delegates lead management to respond.mjs:

```bash
bus hooks add --agent botbox-dev \
  --channel botbox \
  --cwd "$PROJECT" \
  --ttl 600 \
  -- botty spawn --env-inherit BOTBUS_CHANNEL,BOTBUS_MESSAGE_ID,BOTBUS_AGENT \
     --name "botbox-dev/router-$(bus generate-name)" \
     --cwd "$PROJECT" \
     -- bun .agents/botbox/scripts/respond.mjs botbox botbox-dev
```

Key changes:
- **No `--claim` on the hook.** The hook fires for every message, not just when the agent claim is free.
- **Unique botty name per invocation.** Each router instance gets a unique name to prevent botty name collisions (e.g., `botbox-dev/router-amber-reef`).
- **respond.mjs handles concurrency.** The router script decides whether to spawn a new lead or route to an existing one.

**Alternative: Keep claim guard, use `respond://` claim instead.**

A simpler approach that avoids hook changes: keep the claim-based hook but use a short-TTL `respond://botbox-dev` claim instead of `agent://botbox-dev`. The respond.mjs instance grabs the claim, processes the message, spawns a lead if needed, then immediately releases the claim. This serializes message intake (one at a time) while allowing parallel leads.

```bash
bus hooks add --agent botbox-dev \
  --channel botbox \
  --claim "respond://botbox-dev" \
  --claim-owner botbox-dev \
  --cwd "$PROJECT" \
  --ttl 60 \
  -- botty spawn --env-inherit BOTBUS_CHANNEL,BOTBUS_MESSAGE_ID,BOTBUS_AGENT \
     --name "botbox-dev/router" \
     --cwd "$PROJECT" \
     -- bun .agents/botbox/scripts/respond.mjs botbox botbox-dev
```

The respond.mjs instance:
1. Processes the message (route by prefix).
2. For `!dev` / `!mission`: spawns a new lead via `botty spawn` (not `exec` — must not replace the router process).
3. Releases `respond://botbox-dev` claim.
4. Exits.

This is **recommended** because:
- Message intake is naturally serialized (prevents two routers from creating duplicate beads for the same message).
- Short TTL (60s) means intake latency is bounded.
- Hook registration is a one-line change (swap claim URI).
- respond.mjs already handles the `!dev` / `!mission` routing — just needs to `botty spawn` instead of `exec`.

### 3. Respond.mjs Changes

Currently, `handleDev()` and `handleMission()` use `exec` to replace the router process with the dev-loop process:

```javascript
// Current: exec replaces our process
let proc = spawn("bun", [scriptPath, PROJECT, AGENT], {
  stdio: "inherit",
  env: process.env,
})
let code = await new Promise((resolve) => {
  proc.on("close", (c) => resolve(c ?? 1))
})
process.exit(code)
```

**New behavior:** Spawn a new lead via `botty spawn` and exit the router:

```javascript
// New: spawn independent lead, then exit
let leadName = `${AGENT}/lead-${await generateName()}`
await runCommand("botty", [
  "spawn",
  "--name", leadName,
  "--env-inherit", "BOTBUS_CHANNEL,BOTBUS_DATA_DIR",
  "--env", `BOTBUS_AGENT=${leadName}`,
  "--env", `BOTBUS_CHANNEL=${PROJECT}`,
  "--env", `BOTBOX_PROJECT=${PROJECT}`,
  ...(missionId ? ["--env", `BOTBOX_MISSION=${missionId}`] : []),
  "--timeout", CLAUDE_TIMEOUT.toString(),
  "--cwd", process.cwd(),
  "--",
  "bun", ".agents/botbox/scripts/dev-loop.mjs", PROJECT, leadName,
])

// Announce and exit — router's job is done
await runCommand("bus", [
  "send", "--agent", AGENT, PROJECT,
  `Spawned lead ${leadName} for ${missionId ? `mission ${missionId}` : "dev work"}`,
  "-L", "spawn-ack",
])
// Release respond:// claim and exit
```

For `!q` / `!qq` / `!bigq` / triage: behavior unchanged — respond.mjs handles these directly and exits.

### 4. Dev-Loop Changes

#### 4a. Lead Identity

Dev-loop currently stakes `agent://botbox-dev` as its identity claim. With multiple leads, each must stake its own unique claim:

```javascript
// Current
await runCommand("bus", ["claims", "stake", "--agent", AGENT, `agent://${AGENT}`])

// New (AGENT is already unique, e.g., "botbox-dev/lead-amber-reef")
await runCommand("bus", ["claims", "stake", "--agent", AGENT, `agent://${AGENT}`])
```

No code change needed — `AGENT` is already passed as a CLI arg and used as the claim URI. The router just needs to pass the unique lead name.

#### 4b. Lead Discovery

At the start of each iteration, the dev-loop should discover other active leads:

```javascript
// Check for sibling leads (same project, different lead instance)
let claimsResult = await runCommand("bus", [
  "claims", "list", "--format", "json"
])
let claims = JSON.parse(claimsResult.stdout)
let siblingLeads = claims.claims.filter(c =>
  c.patterns?.some(p => p.startsWith("agent://botbox-dev/lead-")) &&
  !c.patterns?.some(p => p.includes(AGENT))
)
```

This information is included in the dev-loop prompt:

```
## SIBLING LEADS (other orchestrators working on this project)

${siblingLeads.length === 0 ? "None — you are the only active lead." : siblingLeads.map(c => `- ${c.agent}: ${c.memo || "working"}`).join("\n")}

When other leads are active:
- Check bead claims before starting work: bus claims list --format json | look for bead:// claims
- Do NOT claim beads already claimed by another lead or their workers
- Post coord:merge messages when you merge a workspace (so other leads can rebase if needed)
- Watch for coord:merge messages from sibling leads before merging (your workspace may need rebase)
```

#### 4c. Merge Protocol (workspace://default Mutex)

This is the core coordination mechanism. When a lead's worker completes and needs to merge:

```
Lead wants to merge worker's workspace (ws/amber-reef) into default:
  1. Claim workspace://botbox/default (merge mutex)
     → If claimed by another lead: wait (poll every 5s, or bus wait --claim)
     → If free: proceed
  2. Rebase workspace onto current default tip:
     maw exec amber-reef -- jj rebase -d main
  3. Check for conflicts:
     maw exec amber-reef -- jj status
     → If conflicts: resolve them (lead does this, not worker)
  4. Merge:
     maw ws merge amber-reef --destroy
  5. Announce:
     bus send --agent $AGENT $PROJECT "Merged ws/amber-reef (bd-xxx): <summary>" -L coord:merge
  6. Sync:
     maw exec default -- br sync --flush-only
  7. Release workspace://botbox/default claim
```

**Prompt addition to dev-loop (step 7 — FINISH):**

```
## MERGE PROTOCOL (multi-lead safe)

Before merging any workspace, you MUST acquire the merge mutex:

1. ACQUIRE MUTEX: bus claims stake --agent ${AGENT} "workspace://${PROJECT}/default" -m "merging <ws>"
   If this FAILS (claim already held by another lead):
   - Check who holds it: bus claims list --format json | look for workspace://${PROJECT}/default
   - Wait: sleep 5, then retry. Repeat up to 12 times (60 seconds max).
   - If still held after 60s: post to bus and move on to other work.

2. REBASE before merge (required when other leads have merged since your workspace was created):
   maw exec $WS -- jj rebase -d main
   Check for conflicts: maw exec $WS -- jj resolve --list
   If conflicts exist: resolve them in the workspace, then continue.

3. MERGE: maw ws merge $WS --destroy

4. ANNOUNCE: bus send --agent ${AGENT} ${PROJECT} "Merged $WS (bead-id): <summary of changes>" -L coord:merge

5. SYNC: maw exec default -- br sync --flush-only

6. RELEASE MUTEX: bus claims release --agent ${AGENT} "workspace://${PROJECT}/default"

IMPORTANT: Always release the mutex, even if merge fails. Use claims release in your cleanup handler.
Never hold the mutex while doing non-merge work (coding, reviewing, checkpointing).
```

#### 4d. Bead Dedup and Claim Checking

With multiple leads, two leads could pick up the same bead. The existing bead claim mechanism (`bead://project/bd-xxx`) already prevents this, but the dev-loop prompt needs reinforcement:

```
Before starting any bead (step 5a/5b):
- Check if the bead is already claimed: bus claims list --format json
- Look for "bead://${PROJECT}/<id>" — if claimed by another agent, skip this bead.
- Only claim beads you will immediately work on or dispatch.
```

#### 4e. Cleanup Handler

The dev-loop cleanup function must release the merge mutex if held:

```javascript
async function cleanup() {
  // ... existing cleanup ...

  // Release merge mutex if held (critical — prevents deadlock)
  try {
    await runCommand("bus", [
      "claims", "release", "--agent", AGENT,
      `workspace://${PROJECT}/default`,
    ])
  } catch {}
}
```

### 5. Config Changes

Add multi-lead config to `.botbox.json`:

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

- `multiLead.enabled` (default: false) — Feature flag. When false, behavior is identical to today (respond.mjs execs into dev-loop).
- `multiLead.maxLeads` (default: 3) — Maximum concurrent dev-loop instances. Router checks `botty list` before spawning.
- `multiLead.mergeTimeoutSec` (default: 60) — How long a lead waits for the merge mutex before giving up.

### 6. Bus Message Conventions

New label for multi-lead coordination:

| Label | Use |
|-------|-----|
| `coord:merge` | Lead announcing it just merged a workspace into default. Body includes workspace name, bead ID, and summary of changed files. |
| `spawn-ack` | Router announcing it spawned a new lead (existing label, new context). |

Leads watch for `coord:merge` messages before merging their own workspaces — this is a signal that the default workspace has changed and a rebase may be needed.

### 7. Lead Lifecycle

```
Router receives message
  → routeMessage() classifies it
  → !dev / !mission / triage-escalate:
      → Check maxLeads: botty list | count botbox-dev/lead-* processes
      → If at capacity: queue message (post acknowledgment, don't spawn)
      → If under capacity:
          → Generate lead name: botbox-dev/lead-$(bus generate-name)
          → botty spawn lead
          → Release respond:// claim, exit
  → !q / !qq / etc:
      → Handle directly (no lead needed)
      → Exit

Lead starts
  → Stake agent:// claim for unique identity
  → Discover sibling leads via claims
  → Run normal dev-loop cycle
  → Before merging: acquire workspace://default, rebase, merge, announce, release
  → On exit: release all claims (including merge mutex if held), kill child workers
```

## Implementation Plan

### Phase 1: Merge Mutex (Foundation)

Changes:
- `packages/cli/scripts/dev-loop.mjs`: Add merge mutex acquisition/release to the FINISH step (step 7). Add `workspace://project/default` claim to cleanup handler. Add `coord:merge` bus announcement after merge.
- No changes to hooks or router — single lead still works, but merge is now mutex-protected (no-op when only one lead).

Files: `packages/cli/scripts/dev-loop.mjs`

Gate: Single-lead E11-L4 eval shows no regression. Merge mutex claim/release works correctly.

### Phase 2: Lead Discovery and Bead Dedup

Changes:
- `packages/cli/scripts/dev-loop.mjs`: Add sibling lead discovery at iteration start. Add bead claim checking before work starts. Add `SIBLING LEADS` section to prompt.

Files: `packages/cli/scripts/dev-loop.mjs`

Gate: Dev-loop correctly detects sibling leads via claims. Skips already-claimed beads.

### Phase 3: Router Changes

Changes:
- `packages/cli/scripts/respond.mjs`: Change `handleDev()` and `handleMission()` from `exec` to `botty spawn`. Add maxLeads check before spawning. Generate unique lead names.
- `packages/cli/src/commands/init.mjs`: Change router hook from `--claim "agent://project-dev"` to `--claim "respond://project-dev"` with short TTL. Change `--name` from fixed to unique.
- `src/migrations/index.mjs`: Add migration to update existing router hooks from `agent://` claim to `respond://` claim.
- `packages/cli/src/lib/config.mjs`: Add `multiLead` config schema.

Files: `respond.mjs`, `init.mjs`, `migrations/index.mjs`, `config.mjs`

Gate: Two concurrent `!dev` messages each spawn their own lead. Both leads work independently.

### Phase 4: Multi-Lead Eval

Changes:
- `evals/scripts/multi-lead-*.sh`: New eval that sends two independent `!mission` messages simultaneously. Verifies:
  - Both get their own lead instance
  - Both complete without interfering
  - Merges are serialized (no divergent commits)
  - Bead claims prevent duplicate work

Files: `evals/scripts/multi-lead-{setup,run,verify}.sh`, `evals/rubrics.md`

Gate: Both missions complete with all beads closed. No divergent commits. No duplicate bead claims.

### Phase 5: Documentation and Rollout

Changes:
- `.botbox.json` config docs: Document `multiLead` settings.
- `CLAUDE.md`: Add multi-lead section.
- Workflow docs: Update `triage.md`, `start.md`, `finish.md` with merge mutex protocol.
- Migration: Add config migration for `multiLead` defaults.

Files: Various docs, `migrations/index.mjs`

## Open Questions

### 1. How do leads divide ready beads?

**Proposed answer:** First-come-first-served via bead claims. When a lead starts work on a bead, it stakes `bead://project/bd-xxx`. Other leads check claims before picking beads and skip claimed ones. This is the existing mechanism — no new protocol needed.

**Risk:** Two leads could race to claim the same bead. Mitigation: bus claims are atomic — only one claim per URI succeeds. The loser's `claims stake` fails, and it moves to the next bead.

### 2. What happens when two leads' workers edit the same file?

**Proposed answer:** This is handled by jj merge. When a lead acquires the merge mutex and rebases its workspace onto the current default tip, jj detects conflicts. The lead resolves them before merging. This is the same mechanism used for any concurrent workspace edits — multi-lead doesn't change it.

**Risk:** Complex merge conflicts could block a lead for a long time while holding the mutex. Mitigation: The merge timeout config (`mergeTimeoutSec`) bounds mutex hold time. If resolution takes too long, the lead can release the mutex, fix conflicts, and retry.

### 3. Should leads share missions?

**Proposed answer:** No. Each lead runs its own mission independently. Sharing children between leads would require a coordination protocol between orchestrators — significantly more complex for unclear benefit. If a mission is too large for one lead, it should be split into independent missions at the human level.

### 4. How does the router decide when to spawn a new lead vs. wait?

**Proposed answer:** The router always spawns a new lead (up to `maxLeads`) for `!dev` and `!mission` messages. For triage-escalated messages (bare messages that turn out to be work), the router also spawns. The maxLeads cap prevents runaway spawning.

**Alternative considered:** Route new work to an existing lead's inbox. Rejected because it reintroduces the single-lead bottleneck — the existing lead would need to finish its current work before processing the new message.

### 5. What about the respond.mjs `!q` conversation loop?

**Proposed answer:** Question handling (`!q`, `!qq`, `!bigq`) continues to be handled inline by the router instance. These are short-lived conversations that don't need a full dev-loop. Only work requests (`!dev`, `!mission`, triage → escalate) spawn leads.

### 6. How do leads coordinate on releases?

**Proposed answer:** The release check (dev-loop step 8) runs inside the merge mutex. After merging, while still holding `workspace://default`, the lead checks for unreleased feat/fix commits and bumps the version if needed. This ensures only one lead does a release at a time.

**Risk:** Two leads could both try to release. Mitigation: The merge mutex serializes this — only the lead that holds the mutex can access the default workspace to check commits and tag.

## Risks and Mitigations

### Risk 1: Merge mutex deadlock

**Scenario:** A lead acquires the mutex, crashes, and never releases it. All other leads wait forever.

**Mitigation:** Use `--ttl` on the mutex claim (e.g., 120s). If the holding lead doesn't release or refresh within TTL, the claim expires automatically. The dev-loop cleanup handler explicitly releases the claim on SIGINT/SIGTERM.

### Risk 2: Message storm from concurrent leads

**Scenario:** Three leads each with four workers flood the bus channel with checkpoint messages, making it hard for humans to follow.

**Mitigation:** Lead checkpoint messages already include the mission ID and lead name. Humans can filter with `bus history project -L feedback --from botbox-dev/lead-amber-reef`. Consider adding a `lead:<lead-name>` label to all lead messages for easy filtering.

### Risk 3: Resource exhaustion

**Scenario:** Three leads each spawn four workers = 15 concurrent Claude Code sessions.

**Mitigation:** `maxLeads` config caps lead count. Each lead already has `maxMissionWorkers` cap. Total concurrent sessions = maxLeads * maxMissionWorkers. Default 3 * 4 = 12, which is reasonable. Can be tuned down for resource-constrained environments.

### Risk 4: Complexity of multi-lead prompt

**Scenario:** Adding lead discovery, merge protocol, and sibling awareness to the already-long dev-loop prompt causes it to exceed useful context or confuse the agent.

**Mitigation:** Phase 1 adds only the merge mutex (small prompt addition). Phase 2 adds lead discovery (moderate). Each phase is gated by eval — if prompt complexity hurts performance, stop there. The merge mutex alone is valuable even without full multi-lead awareness.

### Risk 5: Router hook fires too aggressively

**Scenario:** Without the `agent://` claim gate, every message spawns a router instance, even status updates and announcements.

**Mitigation:** The `respond://` claim approach (recommended in section 2) serializes router instances. Only one router processes messages at a time, and it exits quickly after spawning a lead or answering a question. Messages that don't need a lead (`!q`, status updates) are handled inline without spawning.

## Alternatives Considered

### Alternative 1: Multiple Registered Hooks (One Per Lead)

Register N hooks with different claim URIs (`agent://project-dev-1`, `agent://project-dev-2`, etc.). Each hook spawns a fixed lead identity.

**Rejected because:**
- Static allocation — can't scale dynamically.
- Requires hook registration changes for each project.
- Breaks the current model where agent identity is derived from project name.

### Alternative 2: Lead Queue via Bus

Instead of spawning concurrent leads, maintain a message queue on bus. One lead processes messages from the queue, and when idle, picks the next message.

**Rejected because:**
- This is the current behavior (with extra steps). The whole point is to run leads concurrently, not sequentially.
- Doesn't solve the core problem: a 20-minute mission blocks a 2-minute fix.

### Alternative 3: Single Lead with Inbox Multiplexing

Keep one dev-loop but make it check inbox at every checkpoint and start new work in parallel. The lead becomes a dispatcher for all incoming work.

**Rejected because:**
- Overloads the single lead's context window with multiple unrelated tasks.
- A mission's checkpoint loop already runs continuously — interleaving new task dispatch adds complexity.
- If the lead crashes, all concurrent work is orphaned. Multiple leads provide fault isolation.

### Alternative 4: Use Claude Code Agent Teams for Multi-Lead

Use the experimental `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` feature to spawn multiple leaders.

**Rejected because:**
- Claude Code agent teams support a single fixed leader by design.
- No workspace isolation (last-write-wins file access).
- Processes are invisible to botty (no `botty tail`, no `botty kill`).
- Bypasses bus, claims, and the entire botbox coordination infrastructure.
