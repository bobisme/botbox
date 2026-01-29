# Deeper Evaluation Proposals

Building on the basic UX test (comprehension check), here are approaches for behavioral evaluation.

## Current State: Comprehension Test

**What we have**: Static Q&A to verify agents can read and understand AGENTS.md.

**Limitation**: Doesn't test whether agents actually *follow* the workflows under real working conditions.

---

## Level 2: Task Execution Eval

**Concept**: Give an agent a real task in a controlled environment and observe their behavior.

### Setup

**Reproducible Task Harness** (reduces variance):

```bash
# Create eval environment from template
EVAL_DIR=$(mktemp -d)
cd "$EVAL_DIR" && jj git init
botbox init --name eval-project --type api --tools beads,maw,crit,botbus,botty --no-interactive

# Seed multiple beads of varying quality to test triage + grooming
# Bead 1: Well-specified (clear title, description, acceptance criteria)
br create --title="Add echo endpoint" \
  --description="Create POST /echo endpoint that returns the request body with an added received_at timestamp. Use Express or similar. Tests: verify JSON round-trip, verify timestamp added, verify 400 on non-JSON body." \
  --type=task --priority=2

# Bead 2: Poorly specified (vague, missing context — agent must groom before starting)
br create --title="fix the health thing" \
  --description="it's broken" \
  --type=bug --priority=1

# Bead 3: Reasonable but missing acceptance criteria
br create --title="Add request logging middleware" \
  --description="Log incoming requests with method, path, status code, and duration." \
  --type=task --priority=3
```

**Why multiple beads?** Single-bead evals hide triage behavior — the agent can skip triage and jump straight to work. Multiple beads (with varying quality) force the agent to:
1. Run `br ready` / `bv --robot-next` (observable)
2. Groom poorly-specified beads (observable via bead comments and field changes)
3. Make a prioritization decision (observable via which bead they pick)

**Critical dependency (per gemini feedback)**: Template repo must be strictly versioned to ensure true reproducibility across eval runs.

**Note on dependencies:** `br create` does not have `--depends-on` flag. Use `br dep add <child> <parent>` after creating both beads.

### Execution

Spawn agent with minimal prompt:
> You are working on the eval-project. Use the botbox workflow. Your goal is to complete available work.

Let them run for N turns or until they say "done."

### Evaluation Criteria

**Protocol Compliance (70% weight):**

*Critical steps (must pass):*
- [ ] Claimed work on botbus (`botbus claim`)
- [ ] Updated bead to in_progress (`br update --status=in_progress`)
- [ ] Finished workflow (`br update --status=closed` or `br close`)
- [ ] Released claims (`botbus release --all`)
- [ ] Synced beads (`br sync --flush-only`)

*Optional steps (bonus points):*
- [ ] Generated agent identity (`botbus generate-name`)
- [ ] Ran triage workflow (`br ready`, picked a bead via `bv --robot-next`)
- [ ] Groomed beads during triage (fixed titles, descriptions, acceptance criteria, priorities)
- [ ] Created workspace with `maw ws create --random`
- [ ] Worked from workspace path (`.workspaces/$WS/`)
- [ ] Posted progress updates during work
- [ ] Announced on botbus (`-L mesh`)
- [ ] Destroyed workspace on finish (`maw ws merge --destroy`)

**Work Quality (20% weight):**
- [ ] Actually completed the task (endpoint exists, works)
- [ ] Tests pass
- [ ] Code is reasonable quality

**Error Handling (10% weight):**
- [ ] If stuck, did they post a progress update?
- [ ] If they found a tool bug, did they use report-issue workflow?

**Scoring Rubric:**
- Critical steps: 10 points each (50 points total)
- Optional steps: 2 points each (16 points available)
- Work quality: 20 points
- Error handling: 10 points
- **Total**: 96 points possible
- **Pass threshold**: ≥70 points (73%)
- **Excellent**: ≥85 points (89%)

**Verification Methods** (automated via tool outputs):
- **Bead state**: `br show <id>` or `sqlite3 .beads/beads.db "SELECT status, closed_at FROM issues WHERE id='<id>'"`
- **Botbus messages**: `botbus inbox --agent <agent> --channels <project> --all`
- **Botbus claims**: `botbus claims --agent <agent>` (empty = released), `botbus check-claim --agent <agent> <resource>`
- **Workspace usage**: `maw ws status`, `jj log` for commits
- **Sync verification**: Check `.beads/issues.jsonl` modification time — should match bead close time within seconds
  ```bash
  stat -c "%Y" .beads/issues.jsonl  # Get mtime
  sqlite3 .beads/beads.db "SELECT closed_at FROM issues WHERE id='<id>'"
  # Compare timestamps — sync typically runs within 1 second of close
  ```

### Results (2026-01-29)

**Run 1**: ✅ **PERFECT SCORE 92/92 (100%)**
- Agent: general-purpose subagent (nexus-umbra)
- Task: Add hello world endpoint (Node.js + Express)
- Protocol compliance: 50/50 (all critical steps verified)
- Work quality: 20/20 (functional, tested, clean)
- Conclusion: AGENTS.md successfully guided complete protocol compliance

### Challenges

- ~~**Tooling**: Needs mock botbus/beads/maw or real instances per eval~~ ✅ Resolved: Use real tools
- **Non-determinism**: Agent behavior varies, need multiple runs
- ~~**Grading**: Manual review vs automated checks~~ ✅ Resolved: Automated via tool outputs
- **Cost**: Full task execution is expensive (many turns)

---

## Level 3: Comparative Eval

**Concept**: A/B test different documentation approaches.

### Variants

- **Variant A**: Current AGENTS.md with managed section + workflow docs
- **Variant B**: Minimal (just Quick Start, no detailed workflows)

*(Reduced from 4 to 2 variants per codex/gemini feedback to reduce run cost)*

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

**Phase 1** (Completed ✅):
- ~~Implement **Level 2: Task Execution Eval** with **automated grading harness**~~ ✅ Done
  - ✅ Used real tools (botbus, br, maw, crit)
  - ✅ Automated scoring via tool outputs (see Verification Methods above)
  - ✅ Run 1 (Opus): 92/92 perfect score
  - ✅ Run 2 (Sonnet): 81/92 (88%) — all critical steps, some optional gaps
- **Workflow doc improvements** (2026-01-29, based on eval results):
  - Fixed claim format: `"path/**"` → `"file://$BOTBOX_PROJECT/path/**"` (start.md, templates.mjs)
  - Emphasized progress comments: "at least one during work" (worker-loop.md)
  - Clarified update.md: "status updates" → "change bead status" to avoid confusion with progress comments
  - Emphasized workspace cleanup: made `--destroy` flag importance clear (finish.md)
  - Added pointer to worker-loop.md as canonical workflow in managed section
  - All changes merged, version hash: 14e15a9821fe
- **Next**: Run 2-3 more evals with improved docs to validate improvements
  - Test if Sonnet score improves with clearer docs
  - Document new baseline

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

5. **Pass/Fail Threshold**: ~~What's acceptable?~~
   - **Decision**: ≥70 points (76%) to pass (per scoring rubric above)
   - Rationale: All critical protocol steps required, optional steps provide buffer
   - Excellent: ≥85 points (92%) — critical + most optional + good work quality
