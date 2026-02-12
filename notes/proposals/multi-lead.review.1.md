# Review: multi-lead proposal (round 1)

Source plan: `ws/default/notes/proposals/multi-lead.md`

## Executive Summary

The proposal is strong on motivation, ecosystem fit, and incremental rollout. It correctly identifies the single-lead bottleneck and reuses existing primitives (`bus` claims, `maw`, `botty`) rather than introducing new coordination systems.

The main gaps are in production-hardening details:

- Router architecture is still ambiguous (two intake patterns are documented as near-peers).
- Lead admission control uses a race-prone capacity check (`botty list` counting).
- Merge lock semantics need a strict lease protocol (TTL + refresh + backoff).
- Security/abuse controls for work-spawning paths are not explicit.
- SLOs/telemetry and chaos test coverage are under-specified.

This review proposes concrete plan edits prioritized by impact and effort.

---

## Proposed Changes

### [High Impact, Low Effort] Change #1: Select one router intake model and add message idempotency

**Current State:**

Section 2 documents both an always-fire hook and a `respond://` claim-gated hook, with one called recommended. The plan does not define explicit idempotency behavior for duplicate message delivery.

**Proposed Change:**

- Make `respond://` claim-gated intake the canonical design.
- Move always-fire to alternatives only.
- Add `BOTBUS_MESSAGE_ID` idempotency via `message://<project>/<message-id>` claim.

**Rationale:**

Concurrency proposals fail when intake behavior is not singular. A single intake design reduces migration ambiguity. Idempotency avoids duplicate side effects (duplicate beads, duplicate lead spawns) when events are retried or replayed.

**Benefits:**

- Removes architectural ambiguity before implementation.
- Prevents duplicate mission/bead/lead creation.
- Simplifies migration and eval expectations.

**Trade-offs:**

- Intake remains serialized, introducing small latency under burst load.

**Implementation Notes:**

- Use `BOTBUS_MESSAGE_ID` when available.
- If absent, derive a deterministic fallback ID and log warning.

**Git-Diff:**

```diff
--- ws/default/notes/proposals/multi-lead.md
+++ ws/default/notes/proposals/multi-lead.md
@@ -33,6 +33,7 @@
 - Two concurrent `!mission` messages each get their own dev-loop instance and complete independently.
 - Merge mutex prevents concurrent squash-merges into default - verified by no divergent commits.
 - A lead that finishes merging releases the mutex, and the next waiting lead merges within 30 seconds.
+- Duplicate delivery of the same `BOTBUS_MESSAGE_ID` never creates duplicate beads, leads, or mission threads.
 - No regression in single-lead E11-L4 eval scores.

@@ -120,23 +121,33 @@
-**New router hook:**
-
-Replace the single claim-gated hook with a hook that always fires but delegates lead management to respond.mjs:
+**Canonical router hook (selected design):**
+
+Use a short-lived intake mutex claim so one router handles intake at a time while leads still run concurrently:

 ```bash
 bus hooks add --agent botbox-dev \
   --channel botbox \
+  --claim "respond://botbox-dev" \
+  --claim-owner botbox-dev \
   --cwd "$PROJECT" \
-  --ttl 600 \
+  --ttl 60 \
   -- botty spawn --env-inherit BOTBUS_CHANNEL,BOTBUS_MESSAGE_ID,BOTBUS_AGENT \
-     --name "botbox-dev/router-$(bus generate-name)" \
+     --name "botbox-dev/router" \
      --cwd "$PROJECT" \
      -- bun .agents/botbox/scripts/respond.mjs botbox botbox-dev
 ```

 Key changes:
- **No `--claim` on the hook.** The hook fires for every message, not just when the agent claim is free.
- **Unique botty name per invocation.** Each router instance gets a unique name to prevent botty name collisions (e.g., `botbox-dev/router-amber-reef`).
- **respond.mjs handles concurrency.** The router script decides whether to spawn a new lead or route to an existing one.
+- **Claim is `respond://...` (not `agent://...`).** Intake is serialized, execution is parallel.
+- **Short TTL bounds intake stalls.**
+- **respond.mjs handles lead spawning and exits quickly.**

+**Idempotency requirement (new):**
+1. Read `BOTBUS_MESSAGE_ID`.
+2. Attempt `bus claims stake --agent $AGENT "message://${PROJECT}/${BOTBUS_MESSAGE_ID}" --ttl 10m`.
+3. If the claim fails, treat as duplicate delivery and exit 0.
+4. Release the message claim in cleanup (or rely on TTL expiry).

-**Alternative: Keep claim guard, use `respond://` claim instead.**
+**Alternative (non-default):** always-fire hook with no intake claim.
 ```

---

### [High Impact, High Effort] Change #2: Replace `botty list` admission with atomic lead-slot claims and durable queueing

**Current State:**

`maxLeads` is enforced by counting processes (`botty list`) and at-capacity behavior says "queue message" without durable queue protocol.

**Proposed Change:**

- Use claim-backed slots: `lead-slot://<project>/<n>`.
- Acquire slot atomically before spawning a lead.
- If all slots are occupied, persist queue entry keyed by message ID and acknowledge queue status.

**Rationale:**

Process counting is race-prone and not a distributed admission mechanism. Claim-backed slots match existing coordination primitives and provide deterministic capacity behavior.

**Benefits:**

- Eliminates over-spawn races.
- Defines deterministic at-capacity behavior.
- Prevents dropped tasks during spikes.

**Trade-offs:**

- Adds queue state management complexity.

**Implementation Notes:**

- Keep queue metadata minimal (`message_id`, `requested_at`, `requester`, `route_type`).
- Ensure queue drain logic runs on each router turn and on lead-exit signal.

**Git-Diff:**

```diff
--- ws/default/notes/proposals/multi-lead.md
+++ ws/default/notes/proposals/multi-lead.md
@@ -347,12 +347,16 @@
       "multiLead": {
         "enabled": false,
         "maxLeads": 3,
-        "mergeTimeoutSec": 60
+        "mergeTimeoutSec": 60,
+        "queueAtCapacity": true,
+        "queueMaxDepth": 200,
+        "queueRetrySec": 30
       }
@@ -361,7 +365,10 @@
 - `multiLead.enabled` (default: false) - Feature flag. When false, behavior is identical to today (respond.mjs execs into dev-loop).
- `multiLead.maxLeads` (default: 3) - Maximum concurrent dev-loop instances. Router checks `botty list` before spawning.
+- `multiLead.maxLeads` (default: 3) - Maximum concurrent dev-loop instances. Enforced via atomic `lead-slot://<project>/<n>` claims (not `botty list`).
+- `multiLead.queueAtCapacity` (default: true) - Persist overflow work when all lead slots are occupied.
+- `multiLead.queueMaxDepth` (default: 200) - Backpressure threshold for intake.
+- `multiLead.queueRetrySec` (default: 30) - Queue drain cadence.
 - `multiLead.mergeTimeoutSec` (default: 60) - How long a lead waits for the merge mutex before giving up.
@@ -381,9 +388,17 @@
   -> routeMessage() classifies it
   -> !dev / !mission / triage-escalate:
-      -> Check maxLeads: botty list | count botbox-dev/lead-* processes
-      -> If at capacity: queue message (post acknowledgment, don't spawn)
-      -> If under capacity:
+      -> Acquire one `lead-slot://botbox/<1..maxLeads>` claim
+      -> If slot acquired:
            -> Generate lead name: botbox-dev/lead-$(bus generate-name)
            -> botty spawn lead
            -> Release respond:// claim, exit
+      -> If no slot available:
+           -> Persist queue entry keyed by `BOTBUS_MESSAGE_ID`
+           -> Send acknowledgment with queue position and ETA
+           -> Release respond:// claim, exit
@@ -396,3 +411,4 @@
-  -> On exit: release all claims (including merge mutex if held), kill child workers
+  -> On exit: release all claims (including merge mutex if held), release lead-slot claim, kill child workers
 ```

---

### [High Impact, High Effort] Change #3: Upgrade merge mutex to an explicit lease protocol

**Current State:**

Merge protocol uses polling and references TTL mostly in risk section, but does not define a strict lease lifecycle (stake with TTL, refresh cadence, bounded wait strategy, mandatory finally-release).

**Proposed Change:**

- Define merge lock as a lease (`--ttl` + refresh loop).
- Use backoff + jitter for waits.
- Rebase preflight outside lock, authoritative rebase under lock.
- Require `finally` release behavior.

**Rationale:**

Lock correctness is where multi-lead systems usually fail. A strict lease protocol reduces stale-lock and starvation risks.

**Benefits:**

- Better correctness under crash and contention.
- Reduced deadlock/stall risk.
- More predictable merge throughput.

**Trade-offs:**

- More lock-lifecycle code in dev-loop.

**Implementation Notes:**

- Track lock ownership state in memory to avoid accidental double release.
- Emit lock wait/hold durations for observability.

**Git-Diff:**

```diff
--- ws/default/notes/proposals/multi-lead.md
+++ ws/default/notes/proposals/multi-lead.md
@@ -265,18 +265,30 @@
-  1. Claim workspace://botbox/default (merge mutex)
-     -> If claimed by another lead: wait (poll every 5s, or bus wait --claim)
-     -> If free: proceed
-  2. Rebase workspace onto current default tip:
+  1. Preflight rebase outside mutex (best-effort):
+     maw exec amber-reef -- jj rebase -d main
+  2. Acquire merge mutex lease:
+     bus claims stake --agent $AGENT "workspace://botbox/default" --ttl 120 -m "merging amber-reef"
+  3. If held by another lead, wait with bounded backoff + jitter (2s..15s) and wake early on `coord:merge`.
+  4. Start lease-refresh loop while mutex is held:
+     bus claims refresh --agent $AGENT "workspace://botbox/default"   # every 30s
+  5. Rebase workspace onto current default tip (authoritative rebase under lock):
      maw exec amber-reef -- jj rebase -d main
-  3. Check for conflicts:
+  6. Check for conflicts:
      maw exec amber-reef -- jj status
      -> If conflicts: resolve them (lead does this, not worker)
-  4. Merge:
+  7. Merge:
      maw ws merge amber-reef --destroy
-  5. Announce:
+  8. Announce:
      bus send --agent $AGENT $PROJECT "Merged ws/amber-reef (bd-xxx): <summary>" -L coord:merge
-  6. Sync:
+  9. Sync:
      maw exec default -- br sync --flush-only
-  7. Release workspace://botbox/default claim
+ 10. Stop refresh loop and release mutex in a `finally` block
@@ -291,8 +303,8 @@
-   - Wait: sleep 5, then retry. Repeat up to 12 times (60 seconds max).
-   - If still held after 60s: post to bus and move on to other work.
+   - Wait with backoff+jitter and `bus wait -c ${PROJECT} -L coord:merge -t 15`.
+   - If still held after `mergeTimeoutSec`: post to bus and move on to other work.
 ```

---

### [Medium Impact, Low Effort] Change #4: Decouple release lock from merge lock

**Current State:**

Open Question 6 proposes running release checks while holding `workspace://default` merge mutex.

**Proposed Change:**

- Introduce `release://<project>/default` lock.
- Keep merge lock only for rebase/merge/sync critical section.
- Perform release check under dedicated release lock.

**Rationale:**

Release work can be slower and should not extend merge critical-section hold times.

**Benefits:**

- Higher merge throughput under parallel leads.
- Cleaner separation of concerns.
- Reduced impact radius of release failures.

**Trade-offs:**

- Adds one more claim type and protocol path.

**Implementation Notes:**

- Keep release lock timeout separate from merge timeout.
- Ensure release lock is only attempted when merge committed changes.

**Git-Diff:**

```diff
--- ws/default/notes/proposals/multi-lead.md
+++ ws/default/notes/proposals/multi-lead.md
@@ -484,9 +484,12 @@
-**Proposed answer:** The release check (dev-loop step 8) runs inside the merge mutex. After merging, while still holding `workspace://default`, the lead checks for unreleased feat/fix commits and bumps the version if needed. This ensures only one lead does a release at a time.
+**Proposed answer:** Do not run release inside the merge mutex. After merge completes and `workspace://default` is released, acquire `release://botbox/default`, run release checks/version bump/tag, then release `release://...`.

-**Risk:** Two leads could both try to release. Mitigation: The merge mutex serializes this - only the lead that holds the mutex can access the default workspace to check commits and tag.
+**Risk:** Separate lock adds protocol complexity. Mitigation: merge lock remains short-lived, and release coordination is isolated to a dedicated lock with its own timeout.
 ```

---

### [Medium Impact, Low Effort] Change #5: Add SLOs, telemetry, and alert thresholds

**Current State:**

Success criteria are functional but do not define operational telemetry, SLOs, or alert triggers.

**Proposed Change:**

- Add SLO targets for intake latency, spawn latency, mutex wait, queue depth.
- Define structured log fields for correlation.
- Add alert conditions for queue saturation and lock contention.

**Rationale:**

Concurrency regressions are often operational before they are functional. Instrumentation should be part of the design, not a post-hoc patch.

**Benefits:**

- Faster issue detection and triage.
- Quantitative rollout gates.
- Better post-incident analysis.

**Trade-offs:**

- Additional implementation effort for instrumentation.

**Implementation Notes:**

- Add correlation fields to every spawn/merge/queue event.
- Evaluate p95 and p99 during canary.

**Git-Diff:**

```diff
--- ws/default/notes/proposals/multi-lead.md
+++ ws/default/notes/proposals/multi-lead.md
@@ -35,6 +35,22 @@
 - A lead that finishes merging releases the mutex, and the next waiting lead merges within 30 seconds.
 - No regression in single-lead E11-L4 eval scores.

+### Operational SLOs and Telemetry
+
+Track these metrics from day one:
+- `router_intake_latency_ms` (p95 < 10s)
+- `lead_spawn_latency_ms` (p95 < 20s)
+- `merge_mutex_wait_ms` (p95 < 60s, p99 < 180s)
+- `queued_work_depth` (steady-state near 0)
+- `duplicate_message_drops_total` (monitor trend)
+- `stale_claim_recoveries_total` (alert on spikes)
+
+Structured log fields on coordination events:
+`project`, `lead`, `message_id`, `mission_id`, `bead_id`, `workspace`, `claim_uri`, `event`, `duration_ms`.
+
+Alert triggers:
+- queue depth > 80% of `queueMaxDepth` for 5m
+- merge mutex wait p99 > 180s for 15m

 @@ -433,6 +449,10 @@
 ### Phase 4: Multi-Lead Eval

 Changes:
+- Add telemetry assertions for `merge_mutex_wait_ms`, `lead_spawn_latency_ms`, and queue depth.
+- Validate correlation IDs are present in router/dev-loop logs.
+- Fail eval if SLO thresholds are violated under load.
 - `evals/scripts/multi-lead-*.sh`: New eval that sends two independent `!mission` messages simultaneously. Verifies:
 ```

---

### [High Impact, Low Effort] Change #6: Add security and abuse controls for lead-spawning paths

**Current State:**

The plan does not define sender authorization, rate limiting, or payload limits for `!dev`, `!mission`, or triage-escalated work.

**Proposed Change:**

- Add allowlist/role-based admission controls.
- Add per-sender and global spawn rate limits.
- Enforce maximum mission payload size.

**Rationale:**

Without admission controls, one noisy actor can trigger resource exhaustion and unstable behavior.

**Benefits:**

- Stronger resilience under abuse or accidental floods.
- Better cost and resource control.
- Safer defaults for production projects.

**Trade-offs:**

- Requires policy configuration and maintenance.

**Implementation Notes:**

- Start with permissive defaults and log policy warnings.
- Harden defaults after canary.

**Git-Diff:**

```diff
--- ws/default/notes/proposals/multi-lead.md
+++ ws/default/notes/proposals/multi-lead.md
@@ -365,10 +365,29 @@
 ### 6. Bus Message Conventions

 New label for multi-lead coordination:
@@ -374,3 +393,22 @@
 Leads watch for `coord:merge` messages before merging their own workspaces - this is a signal that the default workspace has changed and a rebase may be needed.

+### 6b. Security and Abuse Controls
+
+Work-spawning paths (`!dev`, `!mission`, triage escalation) must be admission-controlled:
+- Allowlist who can trigger new leads (agent/user regex or explicit list).
+- Rate-limit per sender and globally (token bucket).
+- Enforce max message/mission body size before bead creation.
+- Reject malformed lead names and strip control characters from echoed text.
+
+Add config under `agents.dev.multiLead`:
+```json
+"admission": {
+  "allowedAgents": ["human:*", "botbox-dev", "botbox-security"],
+  "maxSpawnsPerMinutePerSender": 2,
+  "maxSpawnsPerMinuteGlobal": 12,
+  "maxMissionBodyBytes": 8192
+}
+```
 ```

---

### [Medium Impact, Low Effort] Change #7: Tighten execution plan details, eval breadth, and rollback strategy

**Current State:**

Phase 3 references `src/migrations/index.mjs` (path mismatch in this repo), and rollout does not include explicit canary and rollback drill.

**Proposed Change:**

- Correct file paths and implementation ownership references.
- Add chaos/race/idempotency eval cases.
- Add a dedicated canary + rollback phase.

**Rationale:**

Most failures happen during rollout and incident handling, not initial implementation.

**Benefits:**

- Prevents implementation drift from incorrect references.
- Catches race/crash bugs before broad deployment.
- Ensures rollback readiness.

**Trade-offs:**

- Slightly longer rollout timeline.

**Implementation Notes:**

- Use `multiLead.enabled=false` as hard rollback flag.
- Include hook resync step in rollback playbook.

**Git-Diff:**

```diff
--- ws/default/notes/proposals/multi-lead.md
+++ ws/default/notes/proposals/multi-lead.md
@@ -423,9 +423,9 @@
 Changes:
 - `packages/cli/scripts/respond.mjs`: Change `handleDev()` and `handleMission()` from `exec` to `botty spawn`. Add maxLeads check before spawning. Generate unique lead names.
 - `packages/cli/src/commands/init.mjs`: Change router hook from `--claim "agent://project-dev"` to `--claim "respond://project-dev"` with short TTL. Change `--name` from fixed to unique.
- `src/migrations/index.mjs`: Add migration to update existing router hooks from `agent://` claim to `respond://` claim.
- `packages/cli/src/lib/config.mjs`: Add `multiLead` config schema.
+- `packages/cli/src/migrations/index.mjs`: Add migration to update existing router hooks from `agent://` claim to `respond://` claim.
+- `packages/cli/src/commands/init.mjs` plus script config loaders: add `multiLead` defaults/validation.

 @@ -433,12 +433,20 @@
 ### Phase 4: Multi-Lead Eval

 Changes:
 - `evals/scripts/multi-lead-*.sh`: New eval that sends two independent `!mission` messages simultaneously. Verifies:
   - Both get their own lead instance
   - Both complete without interfering
   - Merges are serialized (no divergent commits)
   - Bead claims prevent duplicate work
+  - Duplicate delivery test: same `BOTBUS_MESSAGE_ID` twice -> exactly one lead/bead action
+  - Crash test: lead dies while holding merge mutex -> lock recovers after TTL
+  - Capacity test: >`maxLeads` requests are queued, acknowledged, and drained
+  - Release-lock test: concurrent release checks produce one release path

@@ -456,0 +464,14 @@
+### Phase 6: Canary Rollout and Rollback
+
+Changes:
+- Enable `multiLead.enabled` for one internal project first (canary).
+- Run for 7 days with SLO monitoring and daily queue/mutex review.
+- Define rollback playbook: set `multiLead.enabled=false`, re-sync hooks, and drain queue safely.
+
+Gate:
+- No P1/P2 incidents during canary.
+- p95 merge wait < 60s; orphaned claims < 0.1% of merge attempts.
+- Rollback drill executed successfully at least once.
 ```

---

## Overall Strengths to Preserve

- Correctly identifies the true bottleneck (single orchestrator, not worker throughput).
- Reuses native coordination primitives (`bus` claims and labels).
- Keeps backward compatibility via feature flag.
- Uses phased delivery instead of large-bang migration.

## Suggested Next Iteration Focus

1. Resolve router-intake decision and idempotency first.
2. Define admission protocol (`lead-slot` claims and queue semantics).
3. Finalize lock semantics and telemetry before implementation tickets.
