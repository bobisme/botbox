# Review Eval

Behavioral evaluation of reviewer agents using crit. Tests whether agents can find real bugs, leave useful feedback, and make correct approval/block decisions.

This is the next step toward the full dev-agent architecture described in `docs/dev-agent-architecture.md`. The worker loop evals validated triage → start → work → finish. This eval validates the review lifecycle.

## Levels

| Level | Focus | Agents | Status |
|-------|-------|--------|--------|
| R1 | Reviewer agent: find bugs, comment, vote | 1 (reviewer) | Planned |
| R2 | Author response: handle comments, fix, re-request | 1 (dev agent) | Future |
| R3 | Full loop: author requests → reviewer reviews → author responds → merge | 2 (dev + reviewer) | Future |
| R4 | Integration: worker loop + review + merge | 2 (dev + reviewer) | ✅ Done |
| R7 | Planning: epic decomposition, dependency graph, sequential execution | 1 (dev agent) | ✅ Done |
| R8 | Adversarial review: subtle bugs requiring execution-path reasoning | 1 (reviewer) | ✅ Done |

## R1: Reviewer Eval

### Concept

Seed a project with code that has intentional issues at varying severity. Create a crit review. Run the reviewer agent. Score whether it finds the right things and makes the right decision.

### Test Code

Write a small Rust HTTP handler (or similar) with three categories of issues:

**Bug (must-find)**: A real security or correctness issue the reviewer should catch and block on.
Examples:
- SQL injection or command injection via unsanitized input
- Path traversal (user input used in file path without validation)
- Unchecked `.unwrap()` on user input that will panic on bad data
- Off-by-one in pagination that skips or duplicates records
- Race condition with shared mutable state

**Quality issue (should-comment)**: A code quality problem worth noting but not blocking.
Examples:
- Magic numbers without constants or explanation
- Error message that doesn't include context (e.g., `"failed"` instead of `"failed to parse config: {path}"`)
- Function doing too many things (violates single responsibility)
- Missing logging in error path

**Clean code (should-not-block)**: Something that looks unusual but is actually correct.
Examples:
- An `unsafe` block with a clear safety comment explaining why it's sound
- A seemingly redundant check that guards against a documented edge case
- A complex but correct algorithm with good comments

The code should be realistic — not a contrived CTF challenge. It should look like something a worker agent might produce. Use the same Rust/Axum stack from the worker loop evals for consistency.

### Setup

```bash
EVAL_DIR=$(mktemp -d)
cd "$EVAL_DIR" && jj git init
botbox init --name review-eval --type api --tools beads,maw,crit,bus,botty --init-beads --no-interactive
cargo init --name review-eval
crit init

# Write the test code with intentional issues.
# (See Test Fixtures section below for specific code.)

# Commit the baseline (empty project).
jj describe -m "initial project setup"
jj new

# Write the code under review.
# ... write src/main.rs with the seeded issues ...

# Describe the change.
jj describe -m "feat: add user lookup endpoint"

# Create the crit review.
REVIEWER=$(bus generate-name)
crit reviews create --agent eval-author --title "feat: add user lookup endpoint" \
  --description "Adds GET /users/:id endpoint with database lookup"
# Note the review ID from output, e.g., cr-xxxx

# Request review.
crit reviews request <review-id> --agent eval-author --reviewers "$REVIEWER"

# Announce on botbus.
bus mark-read --agent "$REVIEWER" review-eval
bus send --agent eval-author review-eval \
  "Review requested: <review-id> @$REVIEWER" -L mesh -L review-request
```

### Execution

```bash
claude ${CLAUDE_MODEL:+--model "$CLAUDE_MODEL"} \
  --dangerously-skip-permissions --allow-dangerously-skip-permissions -p "
You are security reviewer agent \"$REVIEWER\" for project \"review-eval\".
Use --agent $REVIEWER on ALL crit and bus commands.

Review workflow:
1. Check botbus inbox: bus inbox --agent $REVIEWER --channels review-eval --mark-read
2. Check crit inbox: crit inbox --agent $REVIEWER
3. For each pending review:
   a. Read the review and diff: crit review <id>, crit diff <id>
   b. Read the full source files changed in the diff
   c. Read Cargo.toml for edition and dependency versions
   d. Run static analysis: cargo clippy 2>&1 — cite any warnings in your comments
   e. If unsure about framework or library behavior, use web search to verify before commenting
4. For each issue found, comment with a severity level:
   - CRITICAL: Security vulnerabilities, data loss, crashes in production
   - HIGH: Correctness bugs, race conditions, resource leaks
   - MEDIUM: Error handling gaps, missing validation at boundaries
   - LOW: Code quality, naming, structure
   - INFO: Suggestions, style preferences, minor improvements
   Use: crit comment <id> \"SEVERITY: <feedback>\" --file <path> --line <line-or-range>
5. Vote:
   - crit block <id> --reason \"<reason>\" if any CRITICAL or HIGH issues exist
   - crit lgtm <id> if no CRITICAL or HIGH issues
6. Announce: bus send --agent $REVIEWER review-eval \"Review complete: <id>\" -L mesh -L review-done

Focus on security and correctness. Ground your findings in evidence — compiler
output, documentation, or source code — not assumptions about API behavior.
"
```

### Scoring (65 points)

#### Bug Detection (30 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Found the seeded bug | 10 | crit review shows comment on the buggy code |
| Comment is specific and actionable | 10 | Identifies the issue, explains the risk, suggests a fix |
| Correctly blocked the review | 10 | `crit review <id>` shows block vote, not LGTM |

#### Quality Feedback (15 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Commented on quality issue | 5 | crit review shows comment on the quality code |
| Comment is constructive (not just "this is bad") | 5 | Explains why and suggests improvement |
| Did not block solely for quality issue | 5 | Block reason references the bug, not the style issue |

#### False Positive Resistance (10 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Did not flag clean code as a bug | 5 | No comment on the clean code section, or comment acknowledges it's fine |
| Did not block for the clean code | 5 | Block reason doesn't reference the clean section |

#### Protocol Compliance (10 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Used crit commands correctly | 5 | Comments have --file and --line, vote was cast |
| Posted summary on botbus | 5 | botbus message with -L review-done |

```
Bug detection:              30 points
Quality feedback:           15 points
False positive resistance:  10 points
Protocol compliance:        10 points
                           ───────────
Total:                      65 points

Pass: ≥45 (69%)
Excellent: ≥55 (85%)
```

### Verification

```bash
# Review has comments?
crit review <review-id>

# Block or LGTM?
crit status

# Comments on the right lines?
crit threads list <review-id>

# Botbus announcement?
bus history review-eval --limit 10 | grep "$REVIEWER"
```

### Test Fixtures

Design at least 2 fixture sets so the eval isn't memorizable:

**Fixture A — Path Traversal**:
- Bug: `GET /files/:name` reads files using user input in path without sanitization (`format!("{}/{}", data_dir, name)` — allows `../etc/passwd`)
- Quality: Error handler returns raw error string to client (leaks internals); uninformative `format!("failed")` error message
- Clean: Role-based email visibility using explicit match arms with wildcard defaulting to least privilege (looks over-engineered but is deliberate defense-in-depth)
- Note: Original fixture used `static mut` with a safety comment as the clean code trap. This was flawed — `static mut` is genuinely problematic (clippy warns, deprecated pattern, unsound under tokio multi-threaded runtime). Replaced with `OnceLock` and the role-based match. **Eval fixtures must be genuinely correct.**

**Fixture B — Panic on Input**:
- Bug: `.unwrap()` on user-supplied JSON field that may be null (panics on missing field, crashes the server)
- Quality: Magic number `3600` used for cache TTL without a named constant
- Clean: A seemingly complex match expression that correctly handles all enum variants (looks over-engineered but is exhaustive)

Alternate between fixtures across runs to test generalization, not pattern matching.

### Expected Results by Model

Based on worker loop eval patterns:

| Model | Expected | Reasoning |
|-------|----------|-----------|
| Opus | 55-65 (85-100%) | Strong at security analysis, nuanced judgment. Target reviewer model. |
| Sonnet | 45-60 (69-92%) | Good at finding obvious bugs, may over-flag quality issues. |
| Haiku | 30-45 (46-69%) | Likely misses subtle bugs, may rubber-stamp or over-block. |

---

## R2: Author Response

### Concept

The dev agent sees reviewer comments on a blocked review and must handle each one:

- **Fix**: Make a code change, commit, reply "Fixed in <change>"
- **Address**: Reply explaining why the current approach is correct (won't-fix)
- **Defer**: Create a bead, reply "Filed <bead-id> for follow-up"

**Key question**: Can the agent distinguish "must fix before merge" from "should fix" from "nice to have"?

### Setup

Reuse the R1 eval environment. The review cr-5c3z is already blocked with 3 threads from R1 Run 3.

```bash
# Verify environment
cd /tmp/tmp.5ipWn3wgtK
crit review cr-5c3z

# Create a new jj change for the fixes (don't amend the reviewed change)
jj new -m "fix: address review feedback on cr-5c3z"
```

### Execution

```bash
AUTHOR="eval-author"

PROMPT="You are dev agent \"${AUTHOR}\" for project \"review-eval\".
Use --agent ${AUTHOR} on ALL crit and bus commands.

Your code review cr-5c3z has been BLOCKED by a reviewer. You need to handle the feedback.

Workflow:
1. Check botbus inbox: bus inbox --agent ${AUTHOR} --channels review-eval --mark-read
2. Read the review: crit review cr-5c3z
3. Read all threads: crit threads list cr-5c3z
4. For each thread, read the comment and decide:
   - CRITICAL/HIGH severity → MUST FIX before merge. Fix the code, then reply:
     crit comment cr-5c3z \"Fixed: <description of fix>\" --file src/main.rs --line <line> --thread <thread-id>
   - MEDIUM severity → SHOULD FIX. Fix the code or explain why not, then reply on the thread.
   - LOW/INFO severity → OPTIONAL. Fix if trivial, otherwise acknowledge or defer.
5. After handling all comments:
   a. Verify fixes compile: cargo check
   b. Describe the change: jj describe -m \"fix: address review feedback on cr-5c3z\"
   c. Re-request review: crit reviews request cr-5c3z --agent ${AUTHOR} --reviewers radiant-eagle
   d. Announce: bus send --agent ${AUTHOR} review-eval \"Review feedback addressed: cr-5c3z\" -L mesh -L review-response

Read the full source files before making changes. Verify your fixes compile with cargo check.
Do NOT use git. Use jj for all version control operations."

claude --model sonnet \
  --dangerously-skip-permissions --allow-dangerously-skip-permissions \
  -p "$PROMPT"
```

### Scoring (65 points)

#### CRITICAL Fix — Path Traversal (25 points)

| Criterion | Points | Verification |
|-----------|--------|--------------|
| Identifies as must-fix | 3 | Agent's reasoning references severity |
| Fix is secure (canonicalize + starts_with, ServeDir, etc.) | 10 | Read fixed code; string-only checks get 3/10 |
| Code compiles after fix | 5 | `cargo check` succeeds |
| Reply on thread references fix | 5 | `crit threads list cr-5c3z` shows reply on th-se3v |
| No regressions | 2 | Code inspection |

#### MEDIUM Fix — Info Disclosure (15 points)

| Criterion | Points | Verification |
|-----------|--------|--------------|
| Identifies as should-fix | 3 | Agent treats as actionable |
| Fix replaces raw error with generic message | 5 | Line 94 no longer exposes io::Error |
| Reply on thread | 5 | Thread th-yu1l has author reply |
| Fix doesn't break error handling | 2 | Proper StatusCode preserved |

#### INFO Handling — Clippy Warning (10 points)

| Criterion | Points | Verification |
|-----------|--------|--------------|
| Identifies as non-blocking | 3 | Not treated as urgent |
| Appropriate action | 4 | Fix, acknowledge, or defer — all acceptable |
| Reply on thread | 3 | Thread th-fvfx has author reply |

#### Protocol Compliance (15 points)

| Criterion | Points | Verification |
|-----------|--------|--------------|
| Proper jj commit with descriptive message | 5 | `jj log` shows new change |
| Re-requests review | 5 | `crit review cr-5c3z` shows re-request |
| Botbus announcement | 5 | `bus history review-eval` shows message |

```
CRITICAL fix:          25 points
MEDIUM fix:            15 points
INFO handling:         10 points
Protocol compliance:   15 points
                      ───────────
Total:                 65 points

Pass: ≥45 (69%)
Excellent: ≥55 (85%)
```

### Results

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| R2-1 | Sonnet | 65/65 (100%) | All 3 threads fixed correctly; canonicalize+starts_with for path traversal |

### Limitations of Current R2

R2-1 only tested the "fix" action path. All three reviewer comments had clear, correct fixes. Future runs should include:

- A comment where the author should push back ("address" path) — e.g., a reviewer misunderstanding about the framework
- A comment that's a good idea but out of scope ("defer" path) — e.g., a feature suggestion for later

---

## R3: Full Review Loop

### Concept

Two agents coordinating across sequential `claude -p` invocations:

1. ~~Dev agent finishes work, creates crit review, announces on botbus~~ (R1 setup)
2. ~~Reviewer agent picks up review, comments, blocks~~ (R1)
3. ~~Dev agent sees block, fixes the issue, re-requests review~~ (R2)
4. **Reviewer verifies fix, LGTMs** (R3 Phase 1)
5. **Dev agent merges** (R3 Phase 2)

R3 builds on the R1+R2 environment. The review already has fixes and a re-request.

### Execution

**Phase 1: Re-review** — reviewer reads fixed code, verifies each fix, LGTMs or re-blocks.

```bash
REVIEWER="radiant-eagle"
PROMPT="You are security reviewer agent \"${REVIEWER}\" for project \"review-eval\".
Use --agent ${REVIEWER} on ALL crit and bus commands.

You previously BLOCKED review cr-5c3z. The author has addressed your feedback.

Re-review workflow:
1. bus inbox --agent ${REVIEWER} --channels review-eval --mark-read
2. crit inbox --agent ${REVIEWER}
3. crit review cr-5c3z — read all threads and author replies
4. Read the CURRENT source (cat src/main.rs) — verify each fix
5. Run cargo clippy to confirm clean
6. If all issues resolved:
   crit lgtm cr-5c3z --agent ${REVIEWER} --reason \"All issues resolved: <summary>\"
   bus send --agent ${REVIEWER} review-eval \"Re-review: cr-5c3z — LGTM\" -L mesh -L review-done
7. If issues remain: reply on thread, keep block

Be thorough. Read actual code, don't just trust replies."
```

**Phase 2: Merge** — author sees LGTM, squashes fix, marks review merged.

```bash
AUTHOR="eval-author"
PROMPT="You are dev agent \"${AUTHOR}\" for project \"review-eval\".
Use --agent ${AUTHOR} on ALL crit and bus commands.

Check if cr-5c3z is approved and merge.

Steps:
1. bus inbox --agent ${AUTHOR} --channels review-eval --mark-read
2. crit review cr-5c3z — check for LGTM vote
3. If LGTM (no blocks):
   a. jj squash — squash fix into parent change
   b. jj describe -m \"feat: add user lookup and file serving endpoints\"
   c. crit reviews merge cr-5c3z --agent ${AUTHOR}
   d. bus send --agent ${AUTHOR} review-eval \"Merged: cr-5c3z\" -L mesh -L merge
4. If still blocked: read feedback and address it

Use jj, not git."
```

### Scoring (65 points)

#### Re-Review Phase (35 points)

| Criterion | Points | Verification |
|-----------|--------|--------------|
| Read current source code (not just replies) | 5 | Agent reads src/main.rs |
| Verified CRITICAL fix is secure | 10 | Confirms canonicalize + starts_with pattern |
| Verified MEDIUM fix is correct | 5 | Confirms generic error messages |
| Correctly LGTMed (not re-blocked) | 10 | `crit review cr-5c3z` shows LGTM |
| Botbus announcement | 5 | `bus history` shows review-done |

#### Merge Phase (30 points)

| Criterion | Points | Verification |
|-----------|--------|--------------|
| Checked for LGTM before merging | 5 | Agent reads review before acting |
| Squashed fix into original change | 5 | `jj log` shows single clean commit |
| Review marked as merged in crit | 5 | `crit reviews list --json` shows merged |
| Botbus merge announcement | 5 | `bus history` shows merge message |
| Code still compiles | 5 | `cargo check` clean |
| Clean execution (no retries) | 5 | First attempt succeeds |

```
Re-review phase:    35 points
Merge phase:        30 points
                   ───────────
Total:              65 points

Pass: ≥45 (69%)
Excellent: ≥55 (85%)
```

### Results

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| R3-1 | Sonnet | 60/65 (92%) | Re-review thorough (read code, ran clippy); merge timed out on first attempt (wrong crit command) |

### Full Loop Combined Score

| Phase | Run | Score |
|-------|-----|-------|
| R1 (Review) | R1-3 | 65/65 (100%) |
| R2 (Author Response) | R2-1 | 65/65 (100%) |
| R3 (Re-review + Merge) | R3-1 | 60/65 (92%) |
| **Combined** | | **190/195 (97%)** |

### Key Learnings

- Sequential `claude -p` invocations coordinate naturally via crit + botbus shared state
- Reviewer verification was thorough: read actual code, ran clippy, didn't rubber-stamp
- `crit reviews merge` (not `close`) — precise command names in prompts prevent timeouts
- Agent self-approve before merge was unnecessary but harmless
- Botbus inbox may be stale if mark-read was used in a previous phase — agents should fall through to checking crit directly
- **R4 addendum**: Reviewer re-review prompts must include workspace path — fixes live in `.workspaces/$WS/` until merge, not on main branch. R4-1 Phase 4 failed its first attempt because the reviewer read main branch code.

---

## R4: Integration Eval — Full Worker Loop + Review Lifecycle

### Concept

Test the full dev-agent architecture end-to-end: triage → start → work → request review → handle feedback → merge. Sequential `claude -p` invocations coordinated via crit + botbus. Bug seeded via task description (path traversal likely), with flexible scoring for both blocked and LGTM paths.

**Prerequisite**: R3 + worker loop evals.

### Setup

```bash
EVAL_DIR=$(mktemp -d) && cd "$EVAL_DIR"
jj git init
botbox init --name r4-eval --type api --tools beads,maw,crit,bus,botty --init-beads --no-interactive
cargo init --name r4-eval
crit init && maw init

DEV_AGENT=$(bus generate-name)
REVIEWER=$(bus generate-name)
bus mark-read --agent "$DEV_AGENT" r4-eval
bus mark-read --agent "$REVIEWER" r4-eval

br create --title="Add file serving endpoint at GET /files/:name" \
  --description="Create a GET /files/:name endpoint that reads files from ./data and returns contents. Return 404 if not found, 500 on read errors." \
  --type=task --priority=2

mkdir -p data && echo "Hello from test file" > data/test.txt
jj describe -m "initial project setup" && jj new

cat > .eval-env << EOF
export EVAL_DIR="$EVAL_DIR"
export DEV_AGENT="$DEV_AGENT"
export REVIEWER="$REVIEWER"
EOF
```

### Phases (5 sequential `claude -p` invocations)

**Phase 1: Dev Agent — Work + Review Request**
- Triage bead, create workspace, implement endpoint
- Create crit review, request reviewer
- Do NOT close bead or merge workspace — stop after review request
- Verify: bead in_progress, workspace exists, review created, code compiles

**Phase 2: Reviewer — Review**
- Proven R1 v2 prompt (clippy, web search, severity levels, evidence-grounding)
- Discovers review via `crit inbox`
- Block or LGTM
- **Decision point**: if LGTM → skip Phase 3+4, go to Phase 5 (auto-award 25 pts)

**Phase 3: Dev Agent — Handle Feedback** (if blocked)
- Read feedback, fix issues in workspace using `maw ws jj`
- Reply on threads with `crit reply`
- Re-request review
- Verify fixes compile

**Phase 4: Reviewer — Re-review** (if blocked)
- Verify fixes in actual code (not just replies)
- Run clippy
- LGTM or re-block

**Phase 5: Dev Agent — Merge + Finish**
- Verify LGTM: `crit review <id>`
- Mark review merged: `crit reviews merge <id>` (NOT `close`)
- Merge workspace: `maw ws merge $WS --destroy` (no `-f`)
- Close bead: `br close <id>`
- Release claims: `bus release --agent $DEV --all`
- Sync: `br sync --flush-only`
- Announce: `bus send ... -L task-done`

### Scoring (95 points)

#### Phase 1: Work + Review Request (40 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Triage: found bead, groomed, claimed | 10 | `br show` shows in_progress, `bus claims` shows claim |
| Start: workspace created, announced | 5 | `maw ws list` shows workspace, bus history shows task-claim |
| Implementation: endpoint works | 10 | `cargo check` clean in workspace |
| Review created and requested | 10 | `crit reviews list` shows review, requested reviewer |
| Deferred finish: bead still open, workspace intact | 5 | `br show` still in_progress, `maw ws list` still shows workspace |

#### Phase 2: Reviewer (20 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Bug/quality assessment | 10 | Comments address real issues (path traversal if present) |
| Correct vote (block if CRITICAL/HIGH, LGTM otherwise) | 5 | `crit review <id>` shows appropriate vote |
| Protocol: crit comments + botbus announcement | 5 | Comments have --file/--line, bus history shows review-done |

#### Phase 3: Handle Feedback (15 points) — auto-award if Phase 2 was LGTM

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Read and categorized feedback | 3 | Agent processes thread severity |
| Fixed CRITICAL/HIGH issues | 5 | Code change addresses the bug |
| Replied on threads | 3 | `crit threads list` shows author replies |
| Fixes compile + re-requested review | 4 | `cargo check` clean, `crit review` shows re-request |

#### Phase 4: Re-review (10 points) — auto-award if Phase 2 was LGTM

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Read actual code (not just replies) | 3 | Agent reads source files |
| Verified fixes, LGTMed | 5 | `crit review` shows LGTM |
| Botbus announcement | 2 | bus history shows review-done |

#### Phase 5: Merge + Finish (10 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Verified LGTM before merge | 2 | Agent reads review first |
| `crit reviews merge` (not close) | 2 | `crit reviews list` shows merged |
| `maw ws merge --destroy` (no -f) | 2 | Workspace removed, code on main |
| `br close` + `bus release --all` | 2 | Bead closed, no active claims |
| `br sync --flush-only` + announce | 2 | bus history shows task-done |

```
Phase 1 (Work + Review):   40 points
Phase 2 (Reviewer):        20 points
Phase 3 (Handle Feedback): 15 points
Phase 4 (Re-review):       10 points
Phase 5 (Merge + Finish):  10 points
                           ───────────
Total:                      95 points

Pass: ≥66 (69%)
Excellent: ≥81 (85%)
```

### Key Learnings Embedded

- Shell script launcher pattern (avoids `claude -p` quoting hang)
- `crit reviews merge` not `close` (R3-1 timeout fix)
- `maw ws merge --destroy` without `-f` (maw v0.15.0)
- `maw ws jj $WS` for jj commands in workspace
- Run `br` from project root, not inside workspace
- All commands use `--agent`
- Do NOT cd into workspace permanently
- Phase 3/4 auto-award if reviewer LGTMs on first pass (code may be clean)

### Results

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| R4-1 | Sonnet | 89/95 (94%) | Full lifecycle works; Phase 4 needed prompt fix for workspace visibility + crit index bug |
| R4-2 | Sonnet | 95/95 (100%) | crit v0.9.1 vote override fix confirmed; perfect score. Phase 4: 10/10 (was 4/10) |

---

## R7: Planning Eval — Epic Decomposition and Sequencing

### Concept

Single Opus agent receives a complex feature request as one bead. Must decompose it into subtasks with correct dependencies, then execute them in order following worker-loop.md. Tests planning ability — can the agent recognize a task is too large, create a non-trivial dependency graph, and systematically work through it?

2 phases: Phase 1 = triage + decompose (stop before coding), Phase 2 = execute subtasks via worker loop.

### Feature Request

**"Build task management API"** — Rust/Axum, in-memory or SQLite. The bead description mentions "Store tasks in SQLite for persistence" but Cargo.toml has no DB crate. This is the adaptability test — agent must notice the gap and make a decision.

Endpoints: CRUD for tasks, tag management, filtering + pagination, overdue query. Natural decomposition into 5-7 subtasks with a diamond dependency graph (not purely linear).

### Setup

```bash
bash scratchpad/r7-setup.sh
# Creates eval dir, Cargo.toml (no SQLite crate), minimal main.rs, feature request bead.
# Outputs EVAL_DIR, DEV_AGENT, PARENT_BEAD.
# Source .eval-env in the eval dir before running phases.
```

### Execution

```bash
# Phase 1: Decomposition (triage only, no coding)
cd $EVAL_DIR && source .eval-env
bash scratchpad/r7-phase1.sh

# Phase 2: Execute subtasks via worker loop
cd $EVAL_DIR && source .eval-env
bash scratchpad/r7-phase2.sh
```

### Scoring (95 points)

#### Phase 1 — Decomposition (45 points)

| Category | Criterion | Pts | Verification |
|----------|-----------|-----|-------------|
| **Triage** | Found bead via `br ready` / `bv --robot-next` | 3 | `br show` shows interaction |
| | Recognized bead is too large for one session | 3 | Creates child beads instead of jumping to code |
| | Groomed parent bead (acceptance criteria, labels) | 4 | `br show <parent>` updated |
| **Subtasks** | Created 4-7 child beads with distinct scopes | 5 | `br list` count |
| | Titles are actionable (imperative form) | 3 | `br show` each |
| | Descriptions include acceptance criteria | 4 | What "done" looks like per subtask |
| | Priorities reflect ordering | 3 | Foundation = higher priority than tests |
| **Deps** | Dependencies wired with `br dep add` (not just comments) | 5 | `br dep tree <parent>` shows edges |
| | Root subtask has no parents (unblocked) | 3 | `br ready` shows it first |
| | Downstream blocked by actual prerequisites | 4 | Filtering blocked by CRUD, not unrelated |
| | Graph has parallelism (not purely linear) | 3 | ≥2 tasks share same prerequisite |
| **Adapt** | Noticed SQLite vs Cargo.toml discrepancy | 2 | Comment or subtask mentions it |
| | Made explicit decision (add crate, use in-memory, or defer) | 3 | Any documented decision = full marks |

**Failure modes:**
- Skips decomposition entirely (does all in one bead): 0/45, max total 15/95 (FAIL)
- Creates subtasks but no `br dep add`: 0/15 on deps
- Purely linear chain: 2/3 on parallelism (recognizes order, misses independence)

#### Phase 2 — Execution (50 points)

| Category | Criterion | Pts | Verification |
|----------|-----------|-----|-------------|
| **Loop** | Picks subtasks respecting dep order (never starts blocked bead) | 5 | `br list --format json` timestamps |
| | Start protocol per subtask (in_progress, claim, workspace, announce) | 5 | `bus history`, `maw ws list` |
| | Progress comment per subtask | 5 | `br comments <id>` |
| | Finish protocol per subtask (close, merge ws, release, sync, announce) | 5 | `br show` closed, no leaked workspaces |
| | Completed ≥3 subtasks (partial: 2=15, 1=10, 0=0) | 5 | Count of closed children |
| **Quality** | Code compiles (`cargo check`) | 5 | Run after all merges |
| | At least CRUD endpoints exist | 5 | Route definitions in source |
| | Storage layer exists | 3 | Data model struct + HashMap/Vec/SQLite |
| | Any test passes | 2 | `cargo test` |
| **Coherence** | Later subtasks build on earlier (no reimplementation) | 4 | Code inspection |
| | Parent bead closed after all children | 3 | `br show <parent>` |
| | Final announcement references feature completion | 3 | `bus history` |

```
Phase 1 — Decomposition:     45 pts
  Triage + recognition:       10
  Subtask creation (4-7):     15
  Dependency graph (DAG):     15
  Adaptability (SQLite):       5

Phase 2 — Execution:          50 pts
  Worker loop compliance:     25
  Implementation quality:     15
  Cross-subtask coherence:    10

Pass: ≥66 (69%)
Excellent: ≥81 (85%)
```

### Verification

After Phase 1:
```bash
br dep tree $PARENT_BEAD          # dependency graph
br ready                          # first unblocked subtask(s)
br comments $PARENT_BEAD          # decomposition plan + SQLite decision
bus history r7-eval --limit 10 # planning announcement
```

After Phase 2:
```bash
br list --format json             # all beads with status
br dep tree $PARENT_BEAD          # all should be closed
cargo check && cargo test         # code quality
maw ws list                       # no leaked workspaces
bus claims --agent $DEV_AGENT  # no active claims
bus history r7-eval --limit 50 # full timeline
```

### Expected Results

| Model | Phase 1 (45) | Phase 2 (50) | Total (95) | Reasoning |
|-------|-------------|-------------|-----------|-----------|
| Opus | 38-45 | 40-50 | 78-95 (82-100%) | Strong planning, should produce good DAG. May hit context limits on later subtasks. |
| Sonnet | 25-38 | 30-45 | 55-83 (58-87%) | Will decompose but likely linear chain. May miss SQLite trap. |

### Results

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| R7-1 | Opus | 76/95 (80%) | Strong diamond DAG (7 subtasks, 3 parallel). Completed 3/7 subtasks before context limit. Code compiles, 8 tests pass. No parent grooming, flat priorities, implicit SQLite decision. |

---

## R8: Adversarial Review Eval

### Concept

Single-reviewer eval (same shape as R1) with harder bugs requiring execution-path reasoning, not pattern matching. Tests the ceiling of review quality.

**v1** (R8-1): Single-file fixture (`src/main.rs`, ~120 lines). All code in one file.
**v2** (R8-2+): Multi-file fixture (7 files, ~180 lines total). Bugs and traps spread across modules. Cross-file reasoning required to find the TOCTOU.

### Fixture Layout (v2)

| File | Content | Bugs/Traps |
|------|---------|------------|
| `src/main.rs` | Router, AppState, mod declarations | None |
| `src/config.rs` | AppConfig, OnceLock | Clean trap 1 |
| `src/upload.rs` | upload_file handler | Bug 1 (race condition) |
| `src/download.rs` | download_file handler | None (correct `&canonical`) |
| `src/delete.rs` | delete_file handler | Bug 2 (TOCTOU: `&file_path`), Quality 2 (`.ok()`) |
| `src/list.rs` | list_files handler | Bug 3 (pagination underflow), Quality 1 (unwrap) |
| `src/health.rs` | health check | Clean trap 2 |

### Bug Design

3 subtle bugs that require comparing execution paths, not just pattern matching:

1. **Race condition in upload size limit (HIGH)** — `AtomicU64` check-then-act: `load()` then `fetch_add()` is not atomic. Two concurrent uploads both pass the limit check and exceed total.
2. **TOCTOU in file delete (HIGH)** — `canonicalize()` + `starts_with()` check validates path, then `remove_file(&file_path)` uses the **original path**, not `&canonical`. Between check and delete, the file can be replaced with a symlink. Contrast: `download_file` (in a separate file) correctly uses `&canonical`. Reviewer must cross-reference two files to spot the discrepancy.
3. **Pagination usize underflow (MEDIUM)** — `(page - 1) * per_page` when `page=0` wraps to `usize::MAX`. DoS via query param.

2 quality issues:

1. `entry.file_name().to_str().unwrap()` — panics on non-UTF-8 filenames (LOW)
2. `fs::remove_file(...).await.ok()` — cleanup error silently discarded (INFO)

2 clean code traps (must NOT flag):

1. `OnceLock<AppConfig>` — correct lazy-init for runtime env vars (in `config.rs`)
2. `mode & 0o444` — permission bit check with accurate comment: "Check if any read permission bits are set" (in `health.rs`)

### Key Design Decisions

- Download (`download.rs`) has correct `&canonical` usage; delete (`delete.rs`) has `&file_path` (the TOCTOU). Reviewer must compare two separate files.
- Upload has no path traversal protection — valid observation but NOT scored. Tests whether reviewer gets distracted by the obvious pattern-match bug and misses the subtle race.
- Clippy won't catch the race condition or TOCTOU (semantic bugs, not syntactic). May catch `page - 1` underflow.
- Both clean code traps are genuinely correct (learned from R1's static mut mistake).
- v2 improved the `0o444` comment to be precise ("Check if any read permission bits are set") rather than the v1 wording ("Standard Unix permission check") which was arguably misleading.

### Setup

```bash
bash scratchpad/r8-setup.sh
# Creates eval dir, fixture, crit review. Outputs EVAL_DIR, REVIEWER, REVIEW_ID.
# Source .eval-env in the eval dir before running.
```

### Execution

```bash
cd $EVAL_DIR && source .eval-env
bash scratchpad/r8-run.sh
# v3 prompt: references .agents/botbox/review-loop.md instead of embedding workflow.
# review-loop.md now includes cross-file consistency and boundary check steps.
```

### Scoring (65 points, v2)

#### Bug Detection (30 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Bug 1 (race condition): identified check-then-act | 4 | crit comment on upload load/fetch_add |
| Bug 1: suggested atomic fix (compare_exchange or lock) | 4 | Comment includes fix suggestion |
| Bug 1: correct severity (HIGH) | 4 | Severity label is HIGH or CRITICAL |
| Bug 2 (TOCTOU delete): identified &file_path vs &canonical | 4 | crit comment on delete_file remove_file |
| Bug 2: suggested fix (use &canonical) | 4 | Comment references canonical path |
| Bug 2: correct severity (HIGH or CRITICAL) | 4 | Severity label is HIGH or CRITICAL |
| Bug 3 (pagination): identified page=0 underflow | 3 | crit comment on list_files |
| Bug 3: suggested fix (clamp or default) | 3 | Comment includes fix |

#### Blocking Decision (5 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Blocked the review (HIGH+ issues exist) | 5 | `crit review` shows block vote |

#### Quality Feedback (10 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Found unwrap on non-UTF-8 filename | 3 | crit comment on to_str().unwrap() in list.rs |
| Found silent error discard in delete | 3 | crit comment on .ok() in delete.rs |
| Comments are constructive (suggest fixes) | 4 | Not just "this is bad" |

#### Cross-File Reasoning (5 points, NEW in v2)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Explicitly compared download.rs vs delete.rs | 5 | Comment references download.rs as correct implementation when identifying TOCTOU in delete.rs |

Note: If reviewer finds Bug 2 (TOCTOU) without referencing download.rs as the correct pattern, they get Bug 2 points but NOT these 5 points. The category rewards the cross-file reasoning, not just the bug detection.

#### False Positive Resistance (5 points, reduced from 10 in v2)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Did not flag OnceLock as HIGH+ or cite in block | 2.5 | No HIGH+ comment on OnceLock in config.rs, or not cited in block reason |
| Did not flag `mode & 0o444` as HIGH+ or cite in block | 2.5 | No HIGH+ comment on permission check in health.rs, or not cited in block reason |

**v2 FP change:** Only penalize if clean trap is flagged HIGH+ or cited in the block reason. LOW/INFO comments on clean code = no penalty (author can triage).

#### Protocol Compliance (10 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Used crit commands correctly (--file, --line) | 5 | Comments have file and line references |
| Posted summary on botbus | 5 | botbus message with -L review-done |

```
Bug detection:              30 points
Blocking decision:           5 points
Quality feedback:           10 points
Cross-file reasoning:        5 points
FP resistance:               5 points
Protocol compliance:        10 points
                           ───────────
Total:                      65 points

Pass: ≥45 (69%)
Excellent: ≥55 (85%)
```

### Expected Results

| Model | Expected | Reasoning |
|-------|----------|-----------|
| Sonnet | 35-50 (54-77%) | R1-3 was 65/65 with easier (pattern-match) bugs. These require execution-path reasoning. |
| Opus | 50-65 (77-100%) | Stronger at multi-step reasoning; may catch all 3. |

### Verification

```bash
crit review $REVIEW_ID
crit threads list $REVIEW_ID
bus history r8-eval --limit 10
```

### Results

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| R8-1 | Sonnet | 54/65 (83%) | v1 single-file: found all 3 bugs; 1 FP on permission check; over-severity on quality issues |
| R8-2 | Opus | 49/65 (75%) | v2 multi-file: found race + TOCTOU but missed pagination; no cross-file reasoning; FP clean |
| R8-3 | Sonnet | 41/65 (63%) | v2 multi-file: **FAIL** — TOCTOU missed (believed delete was correct); pagination missed; quality 10/10 |

---

### Beyond R4

Once the single-project dev agent is validated:

- **Multi-project coordination**: Dev agents for different projects filing cross-project issues (report-issue.md), reviewing each other's APIs
- **Parallel dispatch eval**: Dev agent has 3+ independent beads, spawns Haiku workers, tracks completions, handles failures (worker gets stuck → dev agent reassigns)
- **Planning eval**: Opus dev agent receives a large feature request, breaks it into beads with dependency graph, sequences work across iterations
- **Adversarial review**: Reviewer intentionally given code with subtle, hard-to-find bugs (concurrency issues, edge cases in error paths) to test the ceiling of review quality
- **Recovery eval**: Mid-run failure simulation — worker crashes, reviewer times out, botbus goes down — testing whether the dev agent recovers gracefully on next iteration
