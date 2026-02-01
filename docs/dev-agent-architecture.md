# Dev Agent Architecture

The target architecture for a project-level dev agent (e.g., `terseid-dev`). This agent owns a project's development lifecycle — triaging work, executing tasks, coordinating parallel workers, and managing code review.

## Roles

| Agent | Role | Model | Lifecycle |
|-------|------|-------|-----------|
| `<project>-dev` | Lead developer. Triages, grooms, dispatches, reviews, merges. | Opus or Sonnet | Long-running loop |
| `<random-name>` | Worker. Claims one bead, implements, finishes. | Haiku (routine), Sonnet (moderate), Opus (complex) | Spawned per-task, exits when done |
| `security-reviewer` | Reviews code for security issues via crit. | Opus | Spawned on demand via botty |

### Model Selection

- **Opus**: Planning, design, architecture decisions, code review, complex implementation. The lead dev agent uses Opus for triage/grooming and any task requiring judgment across the codebase.
- **Sonnet**: General implementation, moderate complexity tasks, lead dev fallback when Opus budget is a concern.
- **Haiku**: Routine, well-specified tasks with clear acceptance criteria. Best for pre-groomed beads where the work is straightforward (94% eval score on v2.1).

## Main Loop

`<project>-dev` runs in a loop similar to `scripts/agent-loop.sh`. Each iteration:

### 1. Inbox

Check `bus inbox --agent $AGENT --channels $PROJECT --mark-read`. Handle each message by type:
- **Task requests**: Create beads or merge into existing.
- **Status checks**: Reply on botbus.
- **Review responses**: Handle reviewer comments (see Review Lifecycle below).
- **Worker announcements**: Track progress, note completions.
- **Feedback**: Triage referenced beads, reply.

### 2. Triage

Check `br ready`. Groom each bead (title, description, acceptance criteria, testing strategy, priority). Use `bv --robot-next` to decide what to work on.

### 3. Dispatch

Decide between sequential and parallel execution:

**Sequential** (default): The dev agent does the work itself — claim, start, work, finish. This is the flow validated by the agent-loop evals (Sonnet 99%, Haiku 94%).

**Parallel** (when multiple independent beads are ready): Spin up worker agents for each bead:

```bash
# For each independent bead:
botty spawn --name <random-name> -- \
  claude -p "You are worker <name> for <project>. Complete bead <id>. ..." \
  --dangerously-skip-permissions --allow-dangerously-skip-permissions
```

Each worker:
- Claims the bead and workspace via botbus
- Implements the task in its workspace
- Runs `br close`, `maw ws merge --destroy`, releases claims
- Announces completion on `#<project>`

The dev agent doesn't wait — it continues its loop. On subsequent iterations it sees worker completions in botbus and bead closures in `br ready`.

### 4. Review Lifecycle

After work is complete (either by the dev agent or a worker), if review is enabled:

**Request review:**
1. Create a crit review: `crit reviews create --title "..." --change <jj-change-id>`
2. Request reviewer: `crit reviews request <review-id> --reviewers security-reviewer`
3. Announce on botbus: `bus send --agent $AGENT $PROJECT "Review requested: <review-id> @security-reviewer" -L mesh -L review-request`

**Ensure reviewer is running:**
1. Check if reviewer is active: `bus check-claim --agent $AGENT "agent://security-reviewer"`
2. If not running, spawn it: `botty spawn --name security-reviewer -- <reviewer-script>`

**Wait for review:**
The dev agent doesn't block. It continues its loop. Options:
- Sleep briefly and check next iteration (simplest)
- Use `bus wait --agent $AGENT -L review-done -t 120` for event-driven notification
- Check `crit inbox --agent $AGENT` each iteration for completed reviews

**Handle review response:**
On the next iteration where a review response is visible:

1. Read review: `crit review <review-id>`
2. For each thread/comment:
   - **Fix**: Make the code change in a workspace, commit, comment "Fixed in <change>"
   - **Address**: Reply explaining why the current approach is correct (won't-fix with rationale)
   - **Defer**: Create a bead for future work, comment "Filed <bead-id> for follow-up"
3. Re-request review: `bus send --agent $AGENT $PROJECT "Re-review requested: <review-id> @security-reviewer" -L mesh -L review-request`
4. Repeat until LGTM or all blockers resolved.

**Merge:**
1. Verify approval: `crit review <review-id>` — confirm LGTM, no blocks
2. Merge workspace: `maw ws merge $WS --destroy -f`
3. Close bead, release claims, sync, announce

### 5. Cleanup

Same as the current agent-loop finish:
- `br comments add <id> "Completed by $AGENT"`
- `br close <id> --reason="Completed" --suggest-next`
- `bus release --agent $AGENT --all`
- `br sync --flush-only`
- `bus send --agent $AGENT $PROJECT "Completed <id>" -L mesh -L task-done`

## Coordination Model

Agents coordinate through two channels:

**botbus** — real-time messaging. Announcements, mentions, review requests. Agents check inbox each iteration. Labels (`-L review-request`, `-L task-done`, `-L review-done`) enable filtering.

**beads + crit** — persistent state. Bead status (open/in_progress/closed), crit reviews (pending/approved/blocked), comments and threads. This is the source of truth; botbus messages are notifications.

Claims (`bus claim`) prevent conflicts:
- `agent://<name>` — agent lease (one instance at a time)
- `bead://<project>/<id>` — bead ownership
- `workspace://<project>/<ws>` — workspace ownership

## Eval Coverage

What's validated today and what remains:

| Capability | Eval Status | Best Score |
|-----------|-------------|------------|
| Worker loop (sequential) | ✅ 10 runs | Sonnet 99%, Haiku 94% |
| Inbox triage | ✅ 5 runs | Sonnet 99% (v3) |
| Grooming | ✅ Observed in all runs | Consistent |
| `has_work()` gating | ✅ Validated | br sync fix confirmed |
| Parallel dispatch | ❌ Not tested | — |
| Review request (create + announce) | ❌ Not tested | — |
| Review loop (reviewer agent) | ❌ Not tested | — |
| Review response handling (fix/address/defer) | ❌ Not tested | — |
| Cross-agent spawning (botty) | ❌ Not tested | — |
| Multi-iteration coordination | ❌ Not tested | — |

## Incremental Eval Plan

Build on the existing eval framework, one capability at a time:

**Next: Review request** — Extend the worker loop eval so the agent creates a crit review after finishing work and announces it on botbus. Score: did it create the review? Did it mention the reviewer? This is a small addition to the existing finish flow.

**Then: Review loop** — Standalone eval for the reviewer agent. Seed a crit review with intentional issues (one real bug, one style nit, one false alarm). Score: did it find the bug? Did it LGTM or block appropriately?

**Then: Review response** — The worker agent sees reviewer comments on its next iteration. Score: did it fix the blocking issue? Did it push back on the false positive? Did it re-request review?

**Then: Parallel dispatch** — The dev agent has 3 independent beads. Score: did it spawn workers? Did it track completions? Did it avoid dispatching the same bead twice?

**Then: Full integration** — End-to-end run with triage, dispatch, review, and merge across multiple iterations. This is the target architecture running as a real eval.
