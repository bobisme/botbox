# Proposal: Mission Coordination v2 — From Counter to Coordinator

**Status**: PROPOSAL
**Bead**: bd-1h5q
**Author**: botbox-dev
**Date**: 2026-02-12

## Summary

The v0.7.0 mission framework (Level 4) decomposes specs into child beads, dispatches parallel workers via botty, and monitors progress via checkpoints. E11-L4 evals validate this works (best 122/130, 94%). But the orchestrator is a **counter** — it counts done/blocked/active children. Workers are isolated — no bus communication with siblings. If worker A changes a shared interface, worker B doesn't know.

This proposal designs the upgrade from "parallel dispatch with monitoring" to "coordinated multi-agent execution," drawing on patterns from nelson (hierarchical command framework) and mcp_agent_mail (agent-to-agent messaging system).

## Research Findings

### Nelson: What It Does and What We Can Learn

Nelson is a Claude Code skill (~30 markdown files) that provides a structured framework for coordinating multi-agent work using Royal Navy operational metaphors. No runtime code — pure prompt engineering.

**Key patterns relevant to botbox:**

1. **Hierarchical command with local autonomy.** Admiral coordinates captains, captains coordinate crew. Lateral communication flows through the hierarchy, not peer-to-peer. Workers report upward; the coordinator relays relevant information downward. This is the opposite of a "mesh" where everyone talks to everyone.

2. **Quarterdeck Rhythm.** Fixed-cadence checkpoints (every 15-30 min) where the admiral:
   - Tracks task states: pending → in_progress → completed
   - Monitors token/time burn against budget
   - Detects scope drift and re-scopes early
   - Makes decisions: continue, re-assign, descope, stop
   - Posts signal flags (recognition) and corrections

   Our current checkpoint loop counts children but doesn't make decisions or relay information.

3. **Crew Briefings (~500 tokens).** Structured context blocks decoupled from conversation history. Every worker gets: sailing orders (mission outcome), their specific task, file ownership, dependencies, and standing orders. This is close to what we do with env vars, but more formalized.

4. **Split Keel: Prevent conflicts, don't detect them.** "NEVER assign the same file to multiple captains." If two tasks must touch the same file: serialize or split into independent modules first. File ownership is declared upfront in the battle plan and enforced by convention.

5. **Standing Orders (anti-pattern detection).** 11 codified anti-patterns as guardrails. Each has symptoms, remedy, and reference. Examples: "Admiral at the Helm" (coordinator implementing instead of coordinating), "Drifting Anchorage" (scope drift), "All Hands on Deck" (over-crewing).

6. **Damage Control procedures.** Six recovery patterns: man overboard (replace stuck agent), session resumption, partial rollback, crew overrun (budget recovery), scuttle and reform (mission abort), escalation chain.

7. **Action Stations (risk tiers).** Four graduated risk levels (Station 0-3) with escalating controls. Station 2+ requires "red-cell navigator" (adversarial review). Maps directly to our risk labels.

8. **No shared knowledge base.** Nelson doesn't use a shared store — it relies on context windows + checkpoint synthesis + escalation. Information emerges through reports flowing upward, not a shared database.

**What nelson does NOT do (limitations):**
- No runtime tooling — it's pure prompts. Agents can't query "what did my sibling post?" — they'd need to use Claude Code's built-in tools.
- No persistent state across sessions beyond conversation transcripts.
- Peer coordination is limited by design — flows through hierarchy. In `agent-team` mode it uses Claude Code's experimental agent teams, which botbox explicitly avoids (no botty observability).

### MCP Agent Mail: What It Does and What We Can Learn

MCP Agent Mail is a Python FastMCP server (HTTP on port 8765) providing a mail-like coordination layer for AI coding agents. ~30 MCP tools, SQLite + Git dual persistence.

**Key patterns relevant to botbox:**

1. **Recipient-centric messaging (vs channel-centric).** Messages sent to specific agents (to/cc/bcc), not broadcast to channels. Each agent has their own inbox. This contrasts with botbus where everything goes to a shared channel. Both models have trade-offs:
   - Channel (botbus): Simple, transparent, everyone sees everything. But noisy for workers who only care about their task.
   - Inbox (agent mail): Targeted, low noise. But requires the sender to know who needs the info.

2. **Thread-based grouping.** `thread_id` groups related messages (e.g., `TKT-123`, `FEAT-567`). Maps naturally to bead IDs. We already use `mission:<id>` labels on bus messages — similar concept.

3. **File reservations (advisory leases).** Glob-pattern file locks with TTL (e.g., `src/auth/**/*.ts` for 1 hour). Not blocking — conflicts are reported, agents decide how to coordinate. Like our claims but at the file level instead of bead/workspace level.

4. **Importance signals.** Messages have importance levels: low/normal/high/urgent. Optional `ack_required` flag. Workers could prioritize urgent sibling messages over their regular work.

5. **Incremental polling.** `fetch_inbox(since_ts=...)` enables efficient fetches without re-reading entire history. Workers poll periodically rather than doing full history scans.

6. **Contact policies.** Per-agent policies control who can message whom (open/auto/contacts_only/block_all). Prevents message spam in large teams.

7. **Macro workflows.** Compound operations (`macro_start_session`) that bundle: register agent + reserve files + fetch inbox into a single call. Reduces tool-call overhead.

**What agent mail does NOT do (limitations):**
- No orchestration logic — it's a communication layer, not a coordinator. Agents decide what to do with messages.
- Requires running an HTTP server — additional infrastructure beyond our CLI tools.
- MCP transport only — our agents use Claude Code with botty, not raw MCP.

## Gap Analysis: Current State vs Desired State

| Capability | Current (v0.7.0) | Desired | Priority |
|-----------|------------------|---------|----------|
| Worker isolation | Workers get env vars (MISSION, SIBLINGS, FILE_HINTS) but don't read bus during work | Workers periodically check bus for sibling updates | High |
| Orchestrator relay | Checkpoint counts children, doesn't relay info | Orchestrator reads worker discovery messages, sends targeted updates to affected siblings | High |
| File ownership | Advisory via BOTBOX_FILE_HINTS env var | Explicit file claims staked on bus, checked by workers before editing shared files | Medium |
| Discovery messages | coord:interface/coord:blocker labels exist but not used by workers in practice | Workers proactively post discoveries, orchestrator aggregates and relays | High |
| Dynamic re-scoping | Checkpoint detects "stuck" but doesn't re-assign | Orchestrator can merge children, re-order dispatch, intervene on conflicts | Low |
| Anti-pattern detection | None | Standing orders in worker prompt detect and correct common mistakes | Medium |
| Structured context | Env vars (flat strings) | Structured briefing blocks with mission context, role, file ownership, constraints | Medium |
| Escalation | Workers can post coord:blocker | Formal escalation: worker → orchestrator → human, with decision framework | Low |

## Proposed Design: Three Levels of Incremental Upgrade

### Level 1: Prompt-Only Changes (Recommended Starting Point)

**Philosophy:** Change zero tool code. Only modify prompt templates in dev-loop.mjs and agent-loop.mjs. Validate in E11 evals before building tooling.

**Changes to agent-loop.mjs (worker prompt):**

1. **Periodic bus check instruction.** Add to the work phase: "Every ~5 minutes of work (or before editing a file you didn't create), check bus for sibling updates: `bus inbox --agent $AGENT --mentions --count-only`. If count > 0, read with `bus inbox --agent $AGENT --mentions --mark-read`."

2. **Proactive discovery posting.** Add to the work phase: "When you change an API, schema, config format, or exported interface that siblings might consume, post a discovery message: `bus send --agent $AGENT $PROJECT 'Interface change: <file>: <summary>' -L coord:interface -L 'mission:<id>'`"

3. **Pre-edit file check.** Add: "Before editing a file listed in BOTBOX_FILE_HINTS as owned by a sibling, check if they've already modified it: `bus history $PROJECT -L coord:interface -n 5`. If they have, read their changes first and adapt."

4. **Standing orders block.** Add 3-4 anti-patterns to the worker prompt:
   - "If you find yourself rewriting a sibling's work, STOP. Post a coord:blocker message instead."
   - "If you're blocked waiting for a sibling's output, don't guess. Post a coord:blocker message and work on the non-blocked parts of your bead."
   - "If your task is expanding beyond the bead description, STOP. Post a message to the orchestrator describing the scope change."

**Changes to dev-loop.mjs (orchestrator prompt):**

1. **Checkpoint relay logic.** During checkpoint, add: "Check for coord:interface messages from workers: `bus history $PROJECT -L coord:interface -L 'mission:<id>' -n 10 --since <last-checkpoint>`. For each discovery, identify which siblings are affected (from the file hints). Post a targeted message to affected workers: `bus send --agent $AGENT $PROJECT '@<worker-name> Sibling update from <source-worker>: <summary>' -L coord:relay -L 'mission:<id>'`"

2. **Blocker resolution.** During checkpoint: "Check for coord:blocker messages. If a worker is blocked on a sibling, determine if the blocker can be resolved (sibling already done?), needs re-ordering (dispatch the blocker first?), or requires lead intervention."

3. **Decision framework.** Add to checkpoint: "After each checkpoint, make an explicit decision: CONTINUE (workers progressing normally), INTERVENE (send guidance to a specific worker), RESCOPE (drop/merge children), or ESCALATE (post to channel for human attention)."

**Estimated prompt size increase:** ~800 tokens for agent-loop.mjs, ~500 tokens for dev-loop.mjs.

### Level 2: Structured Worker Context (After Level 1 Validates)

**Changes to dev-loop.mjs dispatch template:**

1. **Structured briefing env var.** Replace flat env vars with a structured briefing file written to the workspace:

```bash
# Instead of multiple env vars, write a briefing file to workspace
cat > ws/$WS/.mission-briefing.md << EOF
# Mission Briefing

## Outcome
$MISSION_OUTCOME

## Your Bead
$BEAD_ID: $BEAD_TITLE

## Siblings
| Bead | Title | Owner | Status | Files |
|------|-------|-------|--------|-------|
$SIBLINGS_TABLE

## File Ownership
Files you own: $YOUR_FILES
Files owned by siblings (DO NOT EDIT without coordination):
$SIBLING_FILES

## Standing Orders
1. Post coord:interface when changing any exported API/schema/config
2. Check bus inbox before editing files in the "sibling files" list
3. If blocked, post coord:blocker — don't guess or wait silently
4. If scope expanding, post to orchestrator — don't implement unrequested changes
EOF
```

2. **Worker prompt reads briefing.** Agent-loop reads `.mission-briefing.md` from workspace root at startup, replacing env var parsing.

3. **File ownership via claims.** Orchestrator stakes file-level claims during dispatch:
```bash
bus claims stake --agent "$AGENT/$WORKER" "file://$PROJECT/src/auth/**" -m "bd-xxx"
```
Workers check: `bus claims list --pattern "file://$PROJECT/*"` before editing outside their ownership zone.

### Level 3: Intelligent Orchestrator (Future — After Evals Prove Value)

These changes require significant orchestrator intelligence and should only be attempted after Level 1+2 show clear improvement in eval scores:

1. **Dependency graph tracking.** Orchestrator maintains a mental model of which children depend on which, updates as workers report progress. Uses this to make dispatch decisions.

2. **Conflict detection.** When two workers post coord:interface messages touching overlapping files, orchestrator detects potential conflict and sends a targeted warning.

3. **Dynamic re-ordering.** If child B depends on child A's output and A is stuck, orchestrator can re-assign A's remaining work or split it differently.

4. **Mid-flight re-scoping.** If the mission is 80% done and remaining children are low-priority, orchestrator decides to close the mission with partial completion rather than burning more budget.

5. **Escalation to human.** For decisions beyond the orchestrator's authority (scope changes, budget extensions), post a structured message to the channel requesting human input.

## Implementation Plan

### Phase 1: Level 1 Prompt Changes

1. Update agent-loop.mjs worker prompt with bus polling, discovery posting, file check, standing orders
2. Update dev-loop.mjs checkpoint prompt with relay logic, blocker resolution, decision framework
3. Run E11-L4 evals (runs 12-14) to validate no regression
4. Design E11-L5 eval that specifically tests coordination (e.g., two workers sharing a module, one changes the interface)

### Phase 2: Level 1 Eval Validation

5. Create E11-L5 eval scripts (setup creates project where workers MUST coordinate)
6. Run E11-L5 evals (3-5 runs) to measure coordination effectiveness
7. Analyze: Do workers actually post discoveries? Does the orchestrator relay them? Do siblings adapt?

### Phase 3: Level 2 (Conditional on Phase 2 Results)

8. Implement structured briefing file in dev-loop.mjs dispatch
9. Add file-level claims to dispatch template
10. Update agent-loop.mjs to read `.mission-briefing.md`
11. Re-run E11-L5 evals to measure improvement

### Phase 4: Documentation and Release

12. Update CLAUDE.md mission section
13. Update notes/proposals/ with results
14. Release new version with coordination improvements

## Risk Assessment

**Is this worth the added complexity?**

The honest answer: **maybe, but start small and measure.**

- Level 1 is pure prompt changes — zero risk to existing functionality. If it doesn't help, remove it.
- Level 2 adds a briefing file and file claims — modest complexity, easy to revert.
- Level 3 is significant orchestrator intelligence — only attempt if Level 1+2 show clear value.

**Key risk:** Prompt bloat. Adding 800 tokens of coordination instructions to agent-loop.mjs might reduce the tokens available for actual work. E11-L4 evals (which test mission completion without coordination) should not regress.

**Key opportunity:** Current missions work well for independent children but struggle when children share code. Real-world missions almost always have shared code. Coordination is the difference between "parallel work that happens to succeed" and "coordinated work that succeeds by design."

## Mapping to Existing Primitives

| Pattern | Nelson Approach | Agent Mail Approach | Botbox Implementation |
|---------|----------------|--------------------|-----------------------|
| Worker context | Crew briefings (500-token templates) | macro_start_session + file reservations | BOTBOX_* env vars → .mission-briefing.md |
| File ownership | Split Keel standing order (prompt convention) | file_reservation_paths (advisory leases with TTL) | bus claims with file:// URI pattern |
| Sibling updates | Quarterdeck reports (upward flow) | send_message + fetch_inbox (directed) | coord:interface label on bus channel |
| Conflict detection | Prevention via exclusive ownership | Reservation conflicts reported | Orchestrator reads coord messages during checkpoint |
| Escalation | Crew → Captain → Admiral → Admiralty | importance levels (urgent) + ack_required | coord:blocker → orchestrator intervenes → human channel post |
| Anti-patterns | 11 standing orders | Contact policies (block_all etc.) | Standing orders block in worker prompt |
| Checkpoints | Quarterdeck rhythm (15-30 min fixed cadence) | Not applicable (no orchestrator) | Checkpoint loop with decision framework |
| Re-scoping | Admiral re-scopes at checkpoint | Not applicable | Orchestrator RESCOPE decision during checkpoint |

## Open Questions

1. **How often should workers poll bus?** Every 5 minutes? Before each file edit? Only when explicitly prompted by the orchestrator? Trade-off: more polling = better coordination but more tokens spent on bus queries.

2. **Should the orchestrator relay ALL coord:interface messages or only those affecting specific siblings?** Full relay is simpler but noisier. Targeted relay requires understanding the file dependency graph.

3. **How do we eval coordination?** E11-L5 needs a project where workers MUST coordinate (shared module, API contract). What's the minimal project design that forces this?
