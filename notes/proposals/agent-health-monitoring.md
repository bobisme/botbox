# Proposal: Agent Health Monitoring (Stuck Detection)

**Status**: PROPOSAL
**Bead**: bd-288
**Author**: botbox-dev
**Date**: 2026-02-05

## Summary

Agent loops can get stuck in various ways: hitting rate limits, making no progress despite burning tokens, entering infinite retry loops, or simply becoming unresponsive. Currently, the system has no automated way to detect or recover from these states. This proposal outlines a health monitoring system that observes agent behavior and takes corrective action when agents are stuck.

## Motivation

The pain points addressed by this proposal:

1. **Wasted resources**: A stuck agent burns API tokens and compute without making progress. In a multi-agent setup, this can be expensive and blocks work that could be reassigned.

2. **Silent failures**: Rate limits and API errors are detected in loop scripts but only logged. There's no centralized visibility or alerting when an agent goes offline.

3. **No automatic recovery**: When an agent gets stuck, human intervention is required to notice, diagnose, and restart it. This breaks the autonomous workflow promise.

4. **Crash recovery is reactive**: The existing crash recovery (checking for in_progress beads with claims) only works on next startup. There's no proactive detection of a live-but-stuck agent.

Inspiration: WezTerm Automata (from the flywheel ecosystem) demonstrates terminal observation for agent state detection. The key insight is that PTY output patterns reveal agent health better than process-level metrics.

## Proposed Design

### Where Does This Feature Belong?

**Recommendation: botty (with botbox integration hooks)**

The core health monitoring should live in **botty** because:

1. **PTY access**: botty already manages agent PTYs via `botty spawn`. It has direct access to terminal output streams, which are the richest signal source.

2. **Process control**: botty can kill and respawn agents. Health monitoring needs this capability to take action.

3. **Runtime concern**: Health monitoring is a runtime observation feature, not a project bootstrap feature. botty is the agent runtime; botbox is the project setup tool.

**botbox's role**: Provide configuration for health policies and integrate with botbus for alerting. The `.botbox.json` config could include health thresholds, and botbox hooks could trigger alerts.

### Signals That Indicate "Stuck"

| Signal | Detection Method | Confidence | Notes |
|--------|------------------|------------|-------|
| **No output** | PTY idle timeout | High | Agent process alive but producing no terminal output for N minutes |
| **Rate limit errors** | Pattern matching on stderr/stdout | High | Look for "rate limit", "429", "overloaded" in output |
| **Repeated identical errors** | Output deduplication with count | Medium | Same error message N times in M minutes suggests infinite retry |
| **Token burn without progress** | Compare bead comments over time | Medium | Agent working but no `br comments add` for extended period |
| **Completion signal timeout** | Missing `<promise>COMPLETE</promise>` | High | Claude invocation finished but no structured completion signal |
| **No claim activity** | botbus claims API | Medium | Agent claimed work but no claim refresh or new claims for extended period |
| **Process exit** | botty process monitoring | High | Agent process died (already partially handled) |
| **Spinning on same file** | PTY output pattern | Low | Repeated read/edit on same file without change (possible infinite loop) |

**Recommended initial implementation**: Start with the high-confidence signals (no output, rate limits, completion signal timeout). Add medium-confidence signals in v2.

### Data Flow

```
+------------------+     +------------------+     +------------------+
|   botty spawn    | --> |  health-monitor  | --> |  botbus alerts   |
|   (PTY output)   |     |  (pattern match) |     |  (notifications) |
+------------------+     +------------------+     +------------------+
                               |
                               v
                    +------------------+
                    |  action handler  |
                    |  (kill/reassign) |
                    +------------------+
```

### Actions to Take

| Condition | Action | Rationale |
|-----------|--------|-----------|
| Rate limit detected | Pause, backoff, then retry | Temporary condition, don't kill |
| Idle timeout (no output) | Kill agent, post to botbus, release claims | Agent is stuck, clean up and allow reassignment |
| Repeated error (> threshold) | Kill agent, mark bead blocked, post to botbus | Infinite retry loop, needs human attention |
| Token burn without progress | Alert on botbus, wait for human decision | May be working on hard problem, don't auto-kill |
| Completion signal timeout | Kill agent, leave bead in_progress for crash recovery | Agent finished but didn't signal properly |

**Default policy**: Alert first, auto-kill only for clear stuck states (idle timeout, completion signal timeout). Token burn is a soft alert because the agent might be legitimately working on something complex.

### Configuration

Proposed `.botbox.json` schema additions:

```json
{
  "agents": {
    "health": {
      "enabled": true,
      "idle_timeout_minutes": 15,
      "completion_timeout_minutes": 10,
      "rate_limit_backoff_seconds": 60,
      "repeated_error_threshold": 5,
      "auto_kill_on_idle": true,
      "auto_kill_on_repeated_error": false,
      "alert_channel": "ops"
    }
  }
}
```

### API Surface (botty)

```bash
# Start agent with health monitoring
botty spawn --name worker-1 --health-policy default -- claude -p "..."

# Query health status
botty health worker-1
# Output: { "agent": "worker-1", "status": "healthy", "last_output": "2026-02-05T10:30:00Z", "errors": [] }

# List unhealthy agents
botty health --filter unhealthy

# Manually trigger recovery
botty recover worker-1  # Kills and respawns
```

### Integration with Existing Loop Scripts

The loop scripts (`agent-loop.mjs`, `dev-loop.mjs`, etc.) already have some error handling:

```javascript
// Current pattern in agent-loop.mjs
const isFatalError =
  err.message.includes('API Error') ||
  err.message.includes('rate limit') ||
  err.message.includes('overloaded');

if (isFatalError) {
  // Post to botbus and exit
}
```

With health monitoring, this becomes:

1. **Loop scripts** continue to handle errors they can recover from (transient failures).
2. **botty health-monitor** observes from outside and handles cases where the script itself is stuck.
3. **Coordination**: If botty kills an agent, it posts to botbus. The next agent to pick up work sees the in_progress bead via crash recovery.

## Open Questions

1. **MCP integration**: Should health status be exposed via MCP server (like WezTerm Automata does)? This would let external tools query agent health.

2. **Multi-machine**: How does this work when agents run on different machines? Does each machine run its own botty health-monitor, or is there centralized monitoring?

3. **Token tracking**: Can we get token usage per agent to implement "token burn without progress" accurately? This may require API-level integration.

4. **Respawn semantics**: When botty respawns an agent, should it resume the same bead or let crash recovery handle it? Resuming requires preserving the workspace state.

5. **False positive handling**: What happens if health monitoring incorrectly kills a working agent? Do we need a "confirm unhealthy" timeout before action?

## Answered Questions

### Q: Is this a botty feature or botbox feature?

**A: Primarily botty, with botbox config integration.**

- **botty** owns the runtime monitoring and action execution (PTY observation, kill, respawn).
- **botbox** owns the configuration schema and helps set up alerting channels during `botbox init`.
- **botbus** provides the coordination layer (alerts, claims release, reassignment signals).

### Q: What signals indicate 'stuck'?

**A: Multiple signals with different confidence levels (see table above).**

The most reliable: no output for extended period, rate limit errors, completion signal timeout.
Less reliable but still useful: repeated errors, token burn, claim staleness.

### Q: What action to take?

**A: Graduated response based on signal type (see actions table).**

Default policy: Alert on botbus first. Auto-kill only for clear stuck states where the agent cannot recover itself.

## Alternatives Considered

### 1. Loop script self-monitoring

Each loop script could track its own health (heartbeats, output timestamps) and self-terminate when stuck.

**Rejected because**: If the script is truly stuck (infinite loop, hanging syscall), it can't monitor itself. External observation is necessary.

### 2. botbus heartbeat protocol

Agents periodically send heartbeat messages to botbus. A separate monitor watches for missing heartbeats.

**Partially adopted**: This is complementary to PTY observation. We can add heartbeats to loop scripts as an additional signal, but PTY observation catches cases where the agent process is alive but not reaching heartbeat code.

### 3. Process-level monitoring only

Monitor CPU, memory, and process state. High CPU with no progress = stuck.

**Rejected because**: AI agents have bursty CPU patterns. A quiet agent might be waiting for API response (normal) or stuck in a blocking call (abnormal). PTY output distinguishes these cases.

### 4. Centralized health service (separate binary)

A new tool (`bothealth` or similar) that queries botty, botbus, and beads to compute agent health.

**Rejected for now**: Adds another tool to maintain. Better to put health monitoring in botty where PTY access already exists. Can revisit if multi-machine becomes common.

## Implementation Plan

If accepted, this proposal breaks down into the following beads:

1. **botty: Add PTY output buffering and timestamps** - Store last N lines of output with timestamps for pattern matching.

2. **botty: Implement idle timeout detection** - Flag agents with no output for > configured timeout.

3. **botty: Add rate limit pattern detection** - Scan PTY output for rate limit error patterns.

4. **botty: Health status API** - `botty health <agent>` and `botty health --filter unhealthy`.

5. **botty: Auto-recovery actions** - Kill agent, release claims via botbus, post alert.

6. **botbox: Health config schema** - Add `agents.health` section to `.botbox.json` schema.

7. **botbox: Health policy migration** - Migration to add default health config to existing projects.

8. **Integration testing** - Test stuck detection and recovery in eval framework.

Estimated effort: 2-3 weeks for core functionality (beads 1-5), 1 week for botbox integration (beads 6-7), 1 week for testing (bead 8).
