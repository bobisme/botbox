# Deeper Evaluation Proposals

Building on the basic UX test (comprehension check), here are approaches for behavioral evaluation.

## Current State: Comprehension Test

**What we have**: Static Q&A to verify agents can read and understand AGENTS.md.

**Limitation**: Doesn't test whether agents actually *follow* the workflows under real working conditions.

---

## Level 2: Task Execution Eval

**Concept**: Give an agent a real task in a controlled environment and observe their behavior.

### Setup

```bash
# Create eval environment
EVAL_DIR=$(mktemp -d)
cd "$EVAL_DIR" && jj git init
botbox init --name eval-project --type api --tools beads,maw,crit,botbus,botty --no-interactive

# Seed with work
br create --title="Add hello world endpoint" \
  --description="Create a /hello endpoint that returns {\"message\": \"hello world\"}. Use whatever web framework makes sense." \
  --type=task --priority=2

br create --title="Add tests for hello endpoint" \
  --description="Write tests verifying the /hello endpoint works correctly." \
  --type=task --priority=2 --depends-on=bd-<first-bead-id>

# Optional: seed botbus with a fake "bug report" message
botbus send --agent eval-seeder eval-project \
  "Found issue: endpoint returns 500 on invalid input" -L mesh -L task-request
```

### Execution

Spawn agent with minimal prompt:
> You are working on the eval-project. Use the botbox workflow. Your goal is to complete available work.

Let them run for N turns or until they say "done."

### Evaluation Criteria

**Protocol Compliance:**
- [ ] Generated agent identity (`botbus generate-name`)
- [ ] Ran triage workflow (`br ready`, picked a bead)
- [ ] Used start workflow (`br update --status=in_progress`, claimed on botbus)
- [ ] Created workspace if using maw
- [ ] Posted updates during work
- [ ] Ran finish workflow when complete
- [ ] Synced beads (`br sync --flush-only`)

**Work Quality:**
- [ ] Actually completed the task (endpoint exists, works)
- [ ] Tests pass
- [ ] Code is reasonable quality

**Error Handling:**
- [ ] If stuck, did they post a progress update?
- [ ] If they found a tool bug, did they use report-issue workflow?

**Scoring**: Weight protocol compliance heavily (70%), quality (20%), error handling (10%).

### Challenges

- **Tooling**: Needs mock botbus/beads/maw or real instances per eval
- **Non-determinism**: Agent behavior varies, need multiple runs
- **Grading**: Manual review vs automated checks
- **Cost**: Full task execution is expensive (many turns)

---

## Level 3: Comparative Eval

**Concept**: A/B test different documentation approaches.

### Variants

- **Variant A**: Current AGENTS.md with managed section + workflow docs
- **Variant B**: Single monolithic doc (no links)
- **Variant C**: Skills-based (for comparison)
- **Variant D**: Minimal (just Quick Start, no detailed workflows)

### Method

Run Level 2 task execution eval with each variant. Measure:
- Protocol compliance rate
- Task completion rate
- Number of turns to completion
- Number of "confused" behaviors (repeated failed attempts, asking for help)

### Challenges

- Needs 10+ runs per variant for statistical significance
- Expensive (40+ full eval runs)
- Hard to control for model variance

---

## Level 4: Multi-Agent Collaboration Eval

**Concept**: Test cross-project feedback workflow with real agent interaction.

### Setup

```bash
# Project A (needs work done)
PROJ_A=$(mktemp -d)
cd "$PROJ_A" && jj git init
botbox init --name proj-a --type library --tools beads,botbus --no-interactive

# Project B (provides tool used by A)
PROJ_B=$(mktemp -d)
cd "$PROJ_B" && jj git init
botbox init --name proj-b --type library --tools beads,botbus --no-interactive

# Register both in #projects
botbus send --agent eval-registry projects \
  "project:proj-a repo:$PROJ_A lead:agent-a tools:tool-a" -L project-registry
botbus send --agent eval-registry projects \
  "project:proj-b repo:$PROJ_B lead:agent-b tools:tool-b" -L project-registry

# Seed proj-a with a task that will fail due to tool-b bug
cd "$PROJ_A"
br create --title="Use tool-b to process data" \
  --description="Run: tool-b process data.json. Expect it to succeed." \
  --type=task --priority=2
```

### Execution

1. Spawn agent-a working on proj-a
2. Agent-a encounters tool-b bug during their task
3. Observe: Do they file a bead in proj-b? Do they tag agent-b on botbus?
4. Spawn agent-b (project lead) to handle feedback
5. Observe: Does agent-b triage the bead? Respond on botbus?

### Evaluation Criteria

**Agent A (reporter):**
- [ ] Queried #projects registry to find proj-b
- [ ] Navigated to $PROJ_B
- [ ] Created bead with reproduction steps
- [ ] Posted to #proj-b with `-L feedback` and `@agent-b`
- [ ] Returned to their own work after reporting

**Agent B (lead):**
- [ ] Saw `-L feedback` message in triage
- [ ] Reviewed bead with `br show`
- [ ] Triaged (accepted/adjusted priority/closed)
- [ ] Responded on botbus with triage results

**Scoring**: Binary pass/fail on critical steps (registry query, bead creation, tagging, response).

### Challenges

- **Orchestration**: Managing two agents, two repos, shared botbus
- **Timing**: Agent B needs to run after Agent A posts
- **Mocking**: Need realistic "buggy tool" behavior to trigger the workflow

---

## Level 5: Long-Running Agent Eval

**Concept**: Let an agent work in a project for hours/days, observe drift and protocol adherence over time.

### Setup

Real or synthetic project with:
- 20+ beads of varying complexity
- Incoming botbus messages throughout the run
- Mix of tasks, bugs, feature requests

### Execution

Agent runs worker-loop continuously (or on schedule). Observe over 10+ iterations.

### Evaluation Criteria

**Consistency:**
- [ ] Agent continues to follow protocol after N iterations
- [ ] No workflow shortcuts or deviations over time

**Adaptation:**
- [ ] Handles interruptions (new urgent task arrives mid-work)
- [ ] Responds to botbus questions/requests appropriately

**Degradation:**
- [ ] Session hygiene maintained (always runs `br sync --flush-only`)
- [ ] No resource leaks (unclosed workspaces, unclaimed beads)

### Challenges

- **Cost**: Hours of continuous agent runtime
- **Monitoring**: Need automated checks for protocol violations
- **Environment**: Requires stable tooling (real botbus/beads servers)

---

## Recommended Next Steps

**Phase 1** (Now):
- Implement **Level 2: Task Execution Eval** with **automated grading harness**
  - Use **real tools** (botbus, br, maw, crit) — not mocks
  - Automate scoring via tool outputs:
    - `botbus inbox --all --mark-read` + parse JSON for protocol messages
    - `br audit` / `br history` for bead state transitions
    - `maw ws status` / `maw ws merge` for workspace lifecycle
    - `crit status` for review participation
  - Log all botbus/crit outputs in JSON/TOON format for scoring
  - Weight protocol compliance heavily (70%)
- Run 3-5 evals, document findings
- Iterate on AGENTS.md based on behavioral gaps

**Phase 2** (Later):
- **Comparative eval**: Current docs vs **minimal only** (reduce runs, focus on value)
- Refine grading automation based on Phase 1 learnings

**Phase 3** (Future):
- **Level 4: Multi-Agent** eval to validate cross-project workflow
- **Level 5: Long-Running** eval for production readiness

---

## Open Questions

1. **Mock vs Real Tools**: ~~Should we mock botbus/beads for eval, or use real instances?~~
   - **Decision**: Use real tools (per codex feedback)
   - Rationale: More realistic, enables automated grading via tool outputs

2. **Grading Automation**: ~~How much can we automate?~~
   - **Decision**: Automate via tool outputs (per codex feedback)
   - Approach:
     - `botbus inbox --all` — check for protocol messages (claim, announce, update, finish)
     - `br audit` / `br history` — verify bead state transitions
     - `maw ws status` / `maw ws merge` — check workspace lifecycle
     - `crit status` — verify review participation
     - Log outputs in JSON/TOON for scoring

3. **Task Complexity**: How complex should eval tasks be?
   - Too simple: Agent might succeed without following protocol
   - Too complex: Hard to grade, expensive
   - Sweet spot: ~10-turn task, requires 2-3 workflow steps

4. **Baseline**: ~~What's the comparison?~~
   - **Decision**: Current docs vs minimal only (per codex feedback)
   - Rationale: Reduces runs needed, focuses on value validation
   - Other comparisons (model versions, no-docs) can come later

5. **Pass/Fail Threshold**: What's acceptable?
   - 100% protocol compliance? (unrealistic)
   - 80%? 90%? (need to calibrate)
   - Which violations are critical vs nice-to-have?
