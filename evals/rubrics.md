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
| R6 | Parallel dispatch: dev agent dispatches Haiku workers, monitors, merges | 1 (dev) + 3 (workers) | ✅ Done |
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
- Release claims: `bus claims release --agent $DEV --all`
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
| `br close` + `bus claims release --all` | 2 | Bead closed, no active claims |
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
bash evals/scripts/r7-setup.sh
# Creates eval dir, Cargo.toml (no SQLite crate), minimal main.rs, feature request bead.
# Outputs EVAL_DIR, DEV_AGENT, PARENT_BEAD.
# Source .eval-env in the eval dir before running phases.
```

### Execution

```bash
# Phase 1: Decomposition (triage only, no coding)
cd $EVAL_DIR && source .eval-env
bash evals/scripts/r7-phase1.sh

# Phase 2: Execute subtasks via worker loop
cd $EVAL_DIR && source .eval-env
bash evals/scripts/r7-phase2.sh
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
bash evals/scripts/r8-setup.sh
# Creates eval dir, fixture, crit review. Outputs EVAL_DIR, REVIEWER, REVIEW_ID.
# Source .eval-env in the eval dir before running.
```

### Execution

```bash
cd $EVAL_DIR && source .eval-env
bash evals/scripts/r8-run.sh
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

## R6: Parallel Dispatch Eval

### Concept

Test whether a dev agent can dispatch Haiku workers in parallel for independent beads, monitor their progress via botbus, and merge completed work — rather than doing tasks sequentially. This is the core capability that separates a "lead dev" agent from a "worker" agent.

### Setup

```bash
bash evals/scripts/r6-setup.sh
# Creates eval dir with Rust/Axum project and 3 independent beads.
# Outputs EVAL_DIR, DEV_AGENT, BEAD1-3.
# Source .eval-env in the eval dir before running.
```

The environment includes:
- Rust/Axum skeleton with `AppState` (request counter) and `/health` endpoint
- 3 pre-groomed, independent P2 beads:

| Bead | Task | Complexity |
|------|------|------------|
| 1 | `GET /version` → `{"name":"r6-eval","version":"0.1.0"}` | Trivial |
| 2 | `POST /echo` → `{"echo":"<body>"}` | Trivial |
| 3 | `GET /metrics` + request counter middleware | Easy |

All beads have acceptance criteria and testing strategy pre-written. No grooming needed — the dev agent should recognize these as dispatch-ready.

### Execution

```bash
cd $EVAL_DIR && source .eval-env
bash evals/scripts/r6-run.sh
# WORKER_MODEL=haiku by default (set WORKER_MODEL=sonnet to override)
# CLAUDE_MODEL controls the dev agent model (Opus recommended)
```

The dev agent is prompted to:
1. Triage `br ready` — recognize 3 independent beads
2. For each: create workspace, generate worker identity, launch `claude --model haiku -p "..." &`
3. Dispatch ALL 3 before waiting for any to complete
4. Monitor via botbus for completion announcements
5. Merge each workspace, close beads, announce

Workers implement tasks but do NOT close beads or merge workspaces (the dev agent handles coordination).

### Scoring (70 points)

#### Dispatch (30 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Recognizes multiple independent beads | 5 | `br ready`, identifies all 3 |
| Creates separate workspace for each bead | 5 | `maw ws create` × 3 |
| Generates worker identities | 3 | `bus generate-name` × 3 |
| Constructs correct worker prompts (bead ID, workspace path, agent identity) | 5 | Prompt includes all 3 fields |
| Launches all workers before any completes — true parallelism | 7 | All 3 backgrounded before any polling |
| Workers use correct model (haiku or configured) | 5 | `--model haiku` in launch command |

#### Monitoring (15 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Polls for worker completions | 5 | `bus inbox` or bead comment checks |
| Detects worker completion announcements | 5 | Recognizes `-L task-done` messages |
| Tracks which beads are done vs pending | 5 | Doesn't try to merge unfinished work |

#### Merge (15 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Verifies worker changes exist | 3 | `maw ws jj <ws> diff` or similar |
| Merges workspaces correctly | 4 | `maw ws merge <ws> --destroy` × completed |
| Closes beads | 4 | `br close` × completed |
| Announces each completion | 4 | `bus send -L task-done` × completed |

#### Protocol (10 points)

| Criterion | Points | Verification |
|-----------|--------|-------------|
| Uses `--agent` consistently on all commands | 5 | Dev agent uses own identity throughout |
| Correct botbus labels (mesh, task-done, task-claim) | 5 | Labels present on all announcements |

```
Dispatch:    30 points
Monitoring:  15 points
Merge:       15 points
Protocol:    10 points
             ──────────
Total:       70 points

Pass: ≥49 (70%)
Excellent: ≥60 (86%)
```

### Expected Results

| Model | Expected | Reasoning |
|-------|----------|-----------|
| Opus | 50-70 (71-100%) | Strong at coordination. May dispatch in parallel if prompted clearly. Risk: might default to sequential out of caution. |
| Sonnet | 30-50 (43-71%) | Can follow dispatch instructions but may serialize. Less reliable at background process management. |

### Verification

```bash
source .eval-env
br ready                    # should be empty (all 3 closed)
br show $BEAD1 && br show $BEAD2 && br show $BEAD3  # all closed
jj log --no-graph -n 10     # worker commits merged
bus history --agent $DEV_AGENT r6-eval  # dispatch + merge timeline
ls .workspaces/ 2>/dev/null  # should be empty (all destroyed)
cargo check                  # merged code still compiles
```

### Results

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| R6-1 | Opus (dev) + Haiku (workers) | 69/70 (99%) | Perfect parallel dispatch: 3 workers launched in 2s, all completed in 85s. Dev agent pre-wrote implementation code in worker prompts. Only deduction: jj merge conflict markers in commit tree (cosmetic). |

### v2 Ideas

- **Failure handling**: Add a 4th bead that's impossible (e.g., "Add PostgreSQL pooling" with no pg crate). Score: does the dev agent detect the stuck worker and move on?
- **Worker timeout**: Kill a worker process mid-task. Score: does the dev agent notice and reassign?
- **Code review**: Dev agent reviews worker output before merging. Score: does it catch obvious issues?

---

## R9: Crash Recovery (bd-3sy)

### Concept

Test whether an agent can resume mid-task after a session crash by reading bead comments and not duplicating completed work. The agent inherits a crashed session's identity, discovers the state from claims and bead comments, and completes all remaining work.

### Test Code

Rust/Axum items CRUD API. Setup script (`evals/scripts/r9-setup.sh`) creates:

- **Baseline**: `/health` endpoint, `Item` struct, `AppState` with `Arc<Mutex<Vec<Item>>>` and `AtomicU64` ID counter
- **Parent bead**: "Build items CRUD API" with 5 subtask children in a linear dependency chain
- **Subtasks 1-2 (closed, merged)**: `GET /items` (src/list.rs) and `POST /items` (src/create.rs) — code is in main branch, beads closed with progress comments
- **Subtask 3 (crash state)**: `GET /items/:id` — bead in_progress, workspace exists with partial `src/get_item.rs` (handler stub that unwraps instead of returning 404, not wired into router). Agent holds bead and workspace claims. Bead comments describe what was done and what remains.
- **Subtasks 4-5 (ready, blocked)**: `DELETE /items/:id` and `PUT /items/:id` — blocked by dependency chain

The agent receives the same identity as the crashed session and a prompt saying "you are resuming after a previous session ended unexpectedly" — but is NOT told which bead, which subtask, or what's already done.

### Execution

```bash
# Setup
bash evals/scripts/r9-setup.sh
cd $EVAL_DIR && source .eval-env

# Run (single session, agent discovers crash state)
bash evals/scripts/r9-run.sh
```

### Rubric (70 points)

#### State Detection (20 points)

| Item | Points | How to verify |
|------|--------|---------------|
| Checks claims before acting | 5 | Agent runs `bus claims --agent` as first action |
| Reads bead comments on claimed bead | 5 | Agent runs `br comments <s3>` or `br show <s3>` |
| Identifies subtasks 1-2 as completed | 5 | Agent acknowledges they're closed/done (doesn't attempt to redo) |
| Identifies subtask 3 as in-progress with workspace | 5 | Agent finds the existing workspace and partial code |

#### No Duplication (15 points)

| Item | Points | How to verify |
|------|--------|---------------|
| Doesn't recreate subtask 1 work | 5 | No new `src/list.rs` write, no re-implementation of GET /items |
| Doesn't recreate subtask 2 work | 5 | No new `src/create.rs` write, no re-implementation of POST /items |
| Uses existing workspace for subtask 3 | 5 | Doesn't `maw ws create` a new workspace when one already exists for S3 |

#### Recovery Execution (25 points)

| Item | Points | How to verify |
|------|--------|---------------|
| Completes subtask 3 (GET /items/:id) | 8 | Handler works with 404 handling, wired into router, bead closed |
| Completes subtask 4 (DELETE /items/:id) | 6 | Handler works, new workspace created, bead closed |
| Completes subtask 5 (PUT /items/:id) | 6 | Handler works, new workspace created, bead closed |
| All code compiles (`cargo check`) | 5 | Final `cargo check` passes with all endpoints |

#### Protocol Compliance (10 points)

| Item | Points | How to verify |
|------|--------|---------------|
| --agent on bus and crit commands | 3 | Grep session transcript for bus/crit commands |
| Progress comments on each subtask | 3 | `br comments` shows progress for S3, S4, S5 |
| Bus announcements | 2 | Sends task-claim and task-done messages |
| Parent bead closed | 2 | Parent bead status=closed after all subtasks done |

**Pass**: ≥49 (70%), **Excellent**: ≥60 (86%)

**Expected**: Opus 55-65 (79-93%), Sonnet 40-55 (57-79%)

### Verification

```bash
source .eval-env
br ready                                        # should be empty
br show $PARENT_BEAD                             # closed
br show $S3 && br show $S4 && br show $S5        # all closed
jj log --no-graph -n 15                          # subtask commits merged
bus history --agent $AGENT r9-eval               # resume + completion announcements
ls .workspaces/ 2>/dev/null                      # should be empty (all destroyed)
cargo check                                      # merged code compiles
```

### Results

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| R9-1 | Opus | 69/70 (99%) | Perfect crash recovery: detected claims, read bead comments, completed S3 in existing workspace without redoing S1/S2, then finished S4+S5. All code compiles, all beads closed, parent closed. Only deduction: no progress comment added to S3 after completing the resumed work (pre-crash comments only). Total time ~6 min for 3 subtasks. |

### v2 Ideas

- **Reviewer timeout**: Review requested but never completed — agent should re-request or escalate
- **Conflicting workspace**: Workspace has merge conflicts from concurrent work
- **Lost bus message**: Claim exists but completion announcement never sent — agent must infer from bead status

---

## R5: Cross-Project Coordination

**Bead**: bd-2s1 · **What it tests**: Agent discovers a bug in an external project, follows report-issue.md to file it cross-project via the #projects registry, and completes its own task.

**Scenario**: Agent works in r5-app on a POST /users bead that references r5-utils's validate_name() function. The function has an off-by-one bug (checks `< 1` instead of `< 2` for minimum length). The bead explicitly asks the agent to verify correctness and follow report-issue.md if issues are found.

**Key difference from other evals**: Two separate project repos, isolated botbus (BOTBUS_DATA_DIR), tests the report-issue.md protocol end-to-end.

**Scripts**: `evals/scripts/r5-setup.sh`, `evals/scripts/r5-run.sh`

### Rubric (70 points)

#### Issue Discovery (15 points)

| Item | Points | How to verify |
|------|--------|---------------|
| Reads r5-utils validate_name() source code | 5 | Agent reads $UTILS_DIR/src/lib.rs |
| Identifies the off-by-one bug (< 1 vs < 2) | 5 | Agent mentions the discrepancy in comments or output |
| Decides to file a cross-project issue | 5 | Agent follows report-issue.md rather than silently fixing |

#### Project Discovery (15 points)

| Item | Points | How to verify |
|------|--------|---------------|
| Queries #projects channel | 5 | Agent runs `bus inbox --channels projects` or `bus history projects` |
| Parses repo path and lead agent for r5-utils | 5 | Agent extracts correct path and "r5-utils-dev" |
| Navigates to r5-utils repo | 5 | Agent cds to or reads from $UTILS_DIR |

#### Issue Filing (20 points)

| Item | Points | How to verify |
|------|--------|---------------|
| Creates bead in r5-utils (correct project) | 8 | `br ready` in $UTILS_DIR shows new bug bead |
| Bead has clear title and description | 6 | Title describes the bug, description has details |
| Includes reproduction info or code reference | 6 | Description mentions the < 1 vs < 2 discrepancy |

#### Bus Announcement (10 points)

| Item | Points | How to verify |
|------|--------|---------------|
| Sends message on r5-utils channel | 4 | `bus history r5-utils` shows the message |
| Uses -L feedback label | 3 | Message has feedback label |
| Tags @r5-utils-dev | 3 | Message mentions the lead agent |

#### Own Task Completion (10 points)

| Item | Points | How to verify |
|------|--------|---------------|
| Implements POST /users endpoint in r5-app | 5 | Endpoint code exists, cargo check passes |
| Uses correct validation (min 2 chars, not the bug) | 5 | Agent implements correct check, not the buggy one |

**Pass**: >= 49 (70%), **Excellent**: >= 60 (86%)

**Expected**: Opus 50-65 (71-93%), Sonnet 35-50 (50-71%)

### Runs

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| R5-1 | Opus | 70/70 (100%) | Perfect cross-project coordination: read r5-utils code, identified off-by-one bug, queried #projects registry, filed bd-31f in r5-utils with detailed repro, announced on r5-utils channel with -L feedback and @r5-utils-dev mention. Implemented correct validation (< 2) in r5-app. Bead left in_progress (correct: requested crit review, no reviewer available). |

### v2 Ideas

- **Round-trip fix**: After filing, a second agent in r5-utils picks up the bug and fixes it
- **Multiple bugs**: r5-utils has 2-3 bugs of varying severity; agent should file appropriate priorities
- **Ambiguous ownership**: Bug could be in r5-utils or r5-app — agent must reason about which project to file in

---

## E10: Full Lifecycle

**Type**: Integration (multi-project, multi-agent, 8 phases)

**What it tests**: Complete end-to-end workflow across two Rust projects (Alpha API + Beta library) with 3 agents (alpha-dev/Opus, alpha-security/Opus, beta-dev/Sonnet). Tests triage, cross-project discovery, workspace management, code review with security block/fix/LGTM cycle, finish protocol, and release.

**Setup**: `evals/scripts/e10-setup.sh` creates isolated eval environment with shared botbus, both projects, planted defects (Beta: validate_email rejects `+`; Alpha: `/debug` endpoint exposes `api_secret`), and seeds work.

**Run**: `evals/scripts/e10-run.sh` (orchestrator) or individual phase scripts.

### Phase 1: Alpha Triage + Implementation + Cross-Project Discovery (30 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Reads inbox, finds task request | 3 | `bus inbox` called with correct agent |
| Claims bead (update status + stake claim) | 4 | `br show` shows in_progress, `bus claims list` shows bead claim |
| Creates workspace, uses absolute paths | 4 | `maw ws list` shows workspace, no `cd` into workspace |
| Implements POST /users handler | 4 | Handler exists in workspace, accepts JSON, returns 201/400 |
| Calls beta's validate_email | 3 | Import or call to beta validation in code |
| Writes test with user+tag@, discovers failure | 4 | Test file exists, evidence of test failure in session |
| Reads beta source code, identifies the bug | 3 | Reads beta/src/lib.rs, identifies whitelist issue |
| Discovers beta via #projects registry | 3 | `bus history projects` called |
| Communicates with beta-dev via bus | 2 | `bus send beta "..." -L feedback` with discussion tone |

### Phase 2: Beta Investigates + Responds (15 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Reads inbox, finds alpha-dev's question | 3 | `bus inbox` with --mentions |
| Investigates own code before responding | 3 | Reads src/lib.rs |
| Responds with domain expertise | 3 | Response references RFC or explains the rationale |
| Creates bug bead to track the fix | 3 | `br create` in beta dir |
| Sends response to alpha channel | 3 | `bus send alpha "..." -L feedback` |

### Phase 3: Beta Fix + Release (15 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Creates workspace for fix | 2 | `maw ws create` |
| Correct fix (allows + in local part) | 4 | validate_email("user+tag@example.com") returns Ok |
| Adds test coverage for + | 2 | Test exists and passes |
| cargo test passes | 2 | All tests green |
| Merges workspace, closes bead | 3 | `maw ws merge --destroy`, `br close` |
| Announces fix on alpha channel | 2 | `bus send alpha "..." -L task-done` |

### Phase 4: Alpha Resumes + Review Request (20 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Reads beta's fix announcement from inbox | 3 | `bus inbox` shows fix message |
| Verifies tests now pass | 3 | `cargo test` in workspace succeeds |
| Completes implementation | 4 | POST /users works correctly |
| Creates crit review from workspace | 4 | `maw exec $WS -- crit reviews create` |
| Requests alpha-security reviewer | 3 | `crit reviews request ... --reviewers alpha-security` |
| Announces review request with @mention | 3 | `bus send alpha "... @alpha-security" -L review-request` |

### Phase 4.5: Hook Verification (5 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Mention hook registered for alpha-security | 3 | `bus hooks list` output contains alpha-security mention hook |
| Hook command is well-formed (botty spawn, --pass-env) | 2 | Hook command parses correctly |

### Phase 5: Security Review (20 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Discovers review via crit inbox | 3 | `crit inbox --all-workspaces` |
| Reads code from workspace path (not project root) | 3 | File reads use ws/$WS/ path |
| Finds /debug endpoint secret exposure | 5 | crit comment references /debug and api_secret |
| Correct severity (CRITICAL or HIGH) | 3 | Comment includes CRITICAL/HIGH tag |
| Blocks the review | 3 | `crit block` called |
| Announces result on bus | 3 | `bus send alpha "..." -L review-done` |

### Phase 6: Alpha Fixes Feedback (15 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Reads review feedback from crit | 3 | `crit review` called |
| Removes/secures /debug endpoint | 4 | /debug route gone or secret stripped from response |
| Code still compiles | 2 | `cargo check` passes |
| Replies on crit thread | 3 | `crit reply` with explanation of fix |
| Re-requests review | 3 | `crit reviews request` + bus send with @mention |

### Phase 7: Re-review + LGTM (10 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Reads from workspace path (not main) | 3 | File reads use ws/$WS/ path |
| Verifies /debug is removed | 4 | Session shows verification |
| LGTMs | 3 | `crit lgtm` called |

### Phase 8: Merge + Finish + Release (15 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Merges workspace | 3 | `maw ws merge --destroy`, workspace gone from `maw ws list` |
| Marks review merged (from default, after merge) | 2 | `maw exec default -- crit reviews mark-merged` |
| Closes bead | 2 | `br show` status=closed |
| Releases all claims | 2 | `bus claims list --agent $ALPHA_DEV` is empty |
| Syncs beads | 1 | `br sync --flush-only` |
| Version bump + tag | 3 | Cargo.toml version updated, `jj tag set v0.2.0` |
| Completion announcement | 2 | `bus send alpha "..." -L task-done` |

### Communication Throughout (15 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Progress comments on beads | 5 | `br comments` shows updates at key milestones |
| Bus messages use correct labels | 5 | feedback, review-request, review-done, task-done used appropriately |
| Agent identity consistent | 5 | `--agent`/`--actor` on mutating commands (reads like `br ready`, `crit review` are exempt) |

### Friction Efficiency (40 pts) — E10v2

Automated extraction from phase stdout logs via `e10-friction.sh`. Measures how efficiently agents use the tools — wasted calls from failures, retries, sibling cancellations, and --help lookups.

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Zero friction (0 wasted calls) | 40 | `e10-friction.sh` reports 0 total wasted |
| Minor friction (1-5 wasted calls) | 30 | Occasional flag discovery or single retry |
| Moderate friction (6-15 wasted calls) | 20 | Multiple tool failures, some sibling amplification |
| Significant friction (16-30 wasted calls) | 10 | Persistent friction source (e.g., missing --path across phases) |
| Severe friction (31+ wasted calls) | 0 | Major tool usability issues |

**What counts as a wasted call:**
- `Exit code 1` / `Exit code 2` on tool commands (wrong flags/args)
- `Sibling tool call errored` (parallel call cancelled by sibling failure)
- `--help` lookups mid-phase (agent didn't know the CLI)
- Retries of the same command with corrected flags

**What does NOT count:**
- Intentional --help at start of session (exploratory, not recovery)
- Tool calls that succeed but produce unexpected output
- FALLBACK lines in orchestrator output (script-level, not agent-level)

**Sibling amplification note:** Claude Code's parallel tool calling means 1 failure in a batch of N cancels N-1 siblings. A single missing flag on 7 parallel crit comments costs 7 calls, not 1. This amplification is intentionally captured because it reflects real cost.

### Scoring Summary

| Category | Points |
|----------|--------|
| Phase 1: Triage + Implement + Discovery | 30 |
| Phase 2: Beta Investigates | 15 |
| Phase 3: Beta Fix + Release | 15 |
| Phase 4: Alpha Resume + Review | 20 |
| Phase 4.5: Hook Verification | 5 |
| Phase 5: Security Review | 20 |
| Phase 6: Fix Feedback | 15 |
| Phase 7: Re-review | 10 |
| Phase 8: Merge + Finish | 15 |
| Communication | 15 |
| Friction Efficiency | 40 |
| **Total** | **200** |

### Critical Fail Conditions (override score)

Any of the following results in overall **FAIL**, regardless of point total:
1. Alpha merges or closes bead while review is BLOCKED (no LGTM).
2. No cross-project peer message from alpha-dev to beta channel in Phase 1.
3. `/debug` endpoint still exposes `api_secret` after Phase 6.
4. Mutating `bus`/`br`/`crit` commands missing identity flags (`--agent`/`--actor`). Read-only commands (`br ready`, `crit review`, `bus history`) are exempt.
5. Claims remain unreleased after Phase 8.

**Pass**: >= 140 (70%), **Excellent**: >= 180 (90%)

### Runs

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| E10-1 | Opus+Sonnet | 158/160 (99%) | Near-perfect. Security reviewer found 7 issues (2 CRITICAL). All agents followed full protocol. |
| E10-2 | Opus+Sonnet | 159/160 (99%) | Reproducible. Clean run with no setup workarounds. crit FK constraint persists. |

---

## E11-L1: Botty-Native End-to-End (Single Agent)

**Type**: Integration (single project, single agent, botty-native)

**What it tests**: The full botbox spawn chain end-to-end: message arrives on channel, hook fires, botty spawns dev-loop, agent triages/claims/implements/merges/closes autonomously. No hand-crafted phase prompts or sequential `claude -p` invocations -- the system runs itself.

**Setup**: `evals/scripts/e11-l1-setup.sh` creates an isolated eval environment with one Rust/Axum project ("echo"), one bead ("Add GET /version endpoint"), and registered hooks. The task-request is NOT sent during setup -- it is sent by the run script to trigger the hook chain.

**Run**: `evals/scripts/e11-l1-run.sh` (orchestrator) -- sends task-request, polls for bead completion with 15-minute timeout and 5-minute stuck detection, captures artifacts, runs verification.

### Scoring (50 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Hook fired and agent spawned | 5 | bus history shows agent activity, botty tail has content |
| Bead claimed (in_progress at some point) | 5 | `br show` status is in_progress or closed |
| Workspace created | 5 | `maw ws list` showed non-default ws, or channel history mentions workspace |
| Code implemented and compiles | 10 | `cargo check` passes AND /version endpoint exists in source |
| Workspace merged | 5 | No non-default workspaces remain |
| Bead closed | 5 | `br show` status=closed |
| Claims released | 5 | No bead:// or workspace:// claims for echo-dev |
| Agent exited cleanly | 5 | botty list shows no running echo agents |
| Bus labels correct | 5 | Channel history has task-claim and task-done labels |

### Key Differences from E10

- **No phase scripts**: One message triggers the entire workflow autonomously
- **Tests loop scripts**: dev-loop.mjs drives agent behavior, not hand-written prompts
- **Tests hook chain**: botbus hook registration, firing, botty spawn, env forwarding
- **Tests iteration control**: maxLoops, pause, timeout from `.botbox.json`
- **Polling-based observation**: 30-second polling with stuck detection instead of sequential phases

### Verification

```bash
source $EVAL_DIR/.eval-env
BOTBUS_DATA_DIR=$BOTBUS_DATA_DIR bus history echo -n 50     # channel timeline
cat $EVAL_DIR/artifacts/agent-echo-dev.log                  # agent output
cd $PROJECT_DIR && maw exec default -- br show $BEAD        # bead state
cd $PROJECT_DIR && maw ws list                              # workspace state
BOTBUS_DATA_DIR=$BOTBUS_DATA_DIR bus claims list             # claims
cd $PROJECT_DIR && maw exec default -- cargo check           # code compiles
```

**Pass**: >= 35 (70%), **Excellent**: >= 45 (90%)

### Runs

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| (none yet) | | | |

---

## E11-L2: Botty-Native Review Cycle (Dev + Reviewer)

**Type**: Integration (single project, two agents, botty-native)

**What it tests**: The full review spawn chain: dev agent requests review with @mention, reviewer hook fires, botty spawns reviewer, both agents coordinate asynchronously through crit + botbus. Tests whether the planted defect is found, blocked, fixed, re-reviewed, and LGTMd — all through the real hook/spawn infrastructure, not hand-crafted prompts.

**Prerequisite**: E11-L1 validates the core spawn chain. L2 adds the reviewer hook and review cycle.

**Setup**: `evals/scripts/e11-l2-setup.sh` creates an isolated eval environment with one Rust/Axum project, one bead ("Add file serving endpoint at GET /files/:name"), registered dev-loop AND reviewer hooks, planted defect (path traversal likely). The task-request is sent by the run script to trigger the dev-loop spawn.

**Run**: `evals/scripts/e11-l2-run.sh` (orchestrator) — sends task-request, polls for bead completion with 20-minute timeout and 5-minute stuck detection, captures artifacts from both agents, runs verification.

### Scoring (95 pts)

#### Spawn Chain (20 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Router hook fired (respond.mjs spawned) | 4 | bus history shows spawn activity, respond log exists |
| respond.mjs triaged as work (not chat/question) | 4 | dev-loop spawned, not conversational mode |
| dev-loop spawned by respond.mjs | 4 | botty tail shows dev agent content, channel history shows dev start |
| Reviewer hook fired on @mention | 4 | botty tail shows reviewer content, channel history shows reviewer spawn |
| Both agents exited cleanly | 4 | botty list empty after timeout, final-status.txt shows "completed" for both |

#### Protocol Compliance (30 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Bead status transitions (open → in_progress → closed) | 5 | `br show` status=closed, channel history shows claims |
| Progress comments posted to bead | 3 | `br show` comment count > 1 |
| Workspace created with maw ws create | 3 | `maw ws list` showed non-default ws during run, or bead closed (merged) |
| Claims staked (bead:// and workspace://) | 4 | Channel history or bead state shows claims |
| Claims released after work | 5 | `bus claims list --agent $DEV` shows no bead:// or workspace:// claims |
| br sync called | 2 | Dev agent log shows `br sync` |
| Bus labels correct (task-claim, review-request, review-done, task-done) | 4 | `bus history` shows all 4 labels |
| Channel announcements (start, progress, completion) | 4 | Channel history shows lifecycle messages |

#### Review Cycle (30 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| crit reviews create from workspace diff | 3 | Dev log shows `crit reviews create` |
| crit reviews request with @reviewer mention | 3 | Dev log shows `crit reviews request`, channel has @mention |
| Bus message contains @mention (triggers hook) | 2 | Channel history has @reviewer |
| Reviewer read code from workspace path (ws/$WS/) | 3 | Reviewer log shows workspace path reads |
| Reviewer identified planted defect | 5 | Reviewer log mentions defect (path traversal, security, etc.) |
| Reviewer BLOCKed review | 3 | Reviewer log shows `crit block` |
| Dev addressed feedback in workspace | 3 | Dev log shows fix, reply to thread |
| Dev re-requested review after fix | 2 | Dev log shows re-request |
| Reviewer re-reviewed from workspace (not cached) | 3 | Reviewer log shows re-read of source |
| Reviewer LGTMd after fix | 2 | Reviewer log shows `crit lgtm` |
| crit reviews mark-merged after merge | 1 | Dev log shows mark-merged |

#### Code Correctness (15 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| cargo check passes on main | 5 | `maw exec default -- cargo check` succeeds |
| Endpoint exists and is wired | 3 | src/main.rs has /files route |
| Planted defect fixed in final code | 5 | src/main.rs has canonicalize or path validation |
| Response format matches spec | 2 | StatusCode 404/500 handling present |

#### Friction Efficiency (10 pts)

Scored from agent logs. Friction = wasted tokens, wasted time. Counts are summed across both agents.

| Check | Full | Partial | Zero | How to extract |
|-------|------|---------|------|---------------|
| Tool errors (exit code 1/2) | 0 errors (5 pts) | 1-5 errors (3 pts) | >5 errors (0 pts) | `grep -c "Exit code [12]" agent-*.log` |
| --help lookups (mid-session) | 0 lookups (3 pts) | 1-2 lookups (2 pts) | >2 lookups (0 pts) | `grep -c "\-\-help" agent-*.log` |
| Retry attempts | 0 retries (2 pts) | 1-2 retries (1 pt) | >2 retries (0 pts) | `grep -c "retry\|again" agent-*.log` |

Additional diagnostics (not scored, but tracked for improvement priorities):

| Metric | How to extract |
|--------|---------------|
| Path confusion instances | `grep -c "No such file\|path.*not found" agent-*.log` |
| Duplicate operations | `grep -c "already.*exists" agent-*.log` |
| Iteration counts | `grep -c "iteration\|loop.*start" agent-*.log` per agent |
| Time per phase | Timestamps from run script (spawn, first claim, review request, LGTM, merge) |
| Total elapsed time | Run script timeout vs actual completion time |

**Summary:**
```
Spawn Chain:          20 pts
Protocol Compliance:  30 pts
Review Cycle:         30 pts
Code Correctness:     15 pts
Friction Efficiency:  10 pts
                     ───────
Total:               105 pts

Pass: ≥70 (67%)
Excellent: ≥89 (85%)
```

### Key Differences from E10

- **No phase scripts**: One message triggers the entire dev + review workflow autonomously
- **Tests loop scripts**: dev-loop.mjs AND reviewer-loop.mjs drive behavior
- **Tests both hook types**: Router hook (claim-based) spawns dev, mention hook spawns reviewer
- **Tests async coordination**: Dev must wait for reviewer to complete (separate botty session)
- **Polling-based observation**: 30-second polling with stuck detection instead of sequential phases
- **Friction scoring**: Tool errors, --help lookups, and retries are scored (10 pts) to create pressure for CLI discoverability improvements

### Expected Results

| Model | Dev Agent | Reviewer | Expected Score | Reasoning |
|-------|-----------|----------|----------------|-----------|
| Opus | Opus | Opus | 75-90 (79-95%) | Strong at coordination and security review. May hit context limits on complex fixes. |
| Sonnet | Sonnet | Opus | 65-85 (68-89%) | Dev may struggle with re-review loop. Opus reviewer should catch defect. |
| Haiku | Haiku | Sonnet | 40-60 (42-63%) | Likely misses subtleties in both dev and review. May rubber-stamp or over-block. |

### Verification

```bash
source $EVAL_DIR/.eval-env
BOTBUS_DATA_DIR=$BOTBUS_DATA_DIR bus history "$(basename "$PROJECT_DIR")" -n 100
cat $EVAL_DIR/artifacts/agent-$DEV_AGENT.log | tail -100
cat $EVAL_DIR/artifacts/agent-$REVIEWER.log | tail -100
cd $PROJECT_DIR && maw exec default -- br show $BEAD
cd $PROJECT_DIR && maw ws list
BOTBUS_DATA_DIR=$BOTBUS_DATA_DIR bus claims list
cd $PROJECT_DIR && maw exec default -- cargo check
```

**Pass**: >= 66 (69%), **Excellent**: >= 81 (85%)

### Runs

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| L2-1 | Opus | 82/95 (86%) | First run — friction scoring drove prompt improvements |
| L2-2 | Opus | 97/105 (92%) | Post-prompt-fix run — zero friction review cycle |

---

## E11-L3: Botty-Native Full Lifecycle (Two Projects, Three Agents)

**Type**: Integration (multi-project, multi-agent, botty-native)

**What it tests**: The complete botbox system end-to-end across two projects with three agents, all spawned via real hooks/botty/loop-scripts. Same scenario as E10 but through the real system — one task-request triggers everything autonomously.

**Three agents:**
- `alpha-dev` — Dev-loop on alpha channel (router hook)
- `alpha-security` — Reviewer on alpha channel (mention hook)
- `beta-dev` — Dev-loop on beta channel (router hook)

**Two planted defects:**
- **Beta**: `validate_email` rejects `+` in email local part (overly strict whitelist)
- **Alpha**: `/debug` endpoint exposes `api_secret` in JSON response

**Expected flow:**
1. Router hook fires → respond.mjs → spawns alpha-dev via dev-loop
2. Alpha-dev triages, claims bead, implements POST /users
3. Alpha-dev discovers beta validate_email rejects +, posts to beta channel
4. Beta router hook fires → beta-dev investigates, fixes, announces on alpha channel
5. Alpha-dev resumes, creates crit review, @mentions alpha-security
6. Alpha-security mention hook fires → reviews, finds /debug vulnerability, BLOCKs
7. Alpha-dev fixes /debug, re-requests review
8. Alpha-security re-reviews, LGTMs
9. Alpha-dev merges, closes bead, releases claims

**Setup**: `evals/scripts/e11-l3-setup.sh`
**Run**: `evals/scripts/e11-l3-run.sh` (45 min timeout)
**Verify**: `evals/scripts/e11-l3-verify.sh`

### Scoring (~150 pts)

#### Spawn Chain (25 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Alpha router hook fired (respond → dev-loop) | 5 | Dev agent log exists with content |
| Beta-dev spawned via cross-project communication | 5 | Beta-dev log exists, beta channel activity |
| Alpha-security spawned via @mention hook | 5 | Reviewer log exists with content |
| Agents spawned in expected order | 5 | Phase timing from run script |
| All agents exited cleanly | 5 | final-status.txt shows "completed" for all |

#### Cross-Project Coordination (30 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Alpha-dev discovered beta validate_email bug | 5 | Dev log references validate_email/plus/reject |
| Alpha-dev queried #projects registry | 3 | Dev log shows `bus history projects` |
| Alpha-dev sent message to beta channel | 5 | Beta channel has alpha-dev message |
| Beta-dev investigated and responded | 5 | Beta-dev log shows lib.rs read |
| Beta-dev fixed validate_email to allow + | 5 | Beta src/lib.rs allows '+' |
| Beta-dev announced fix on alpha channel | 4 | Alpha channel has beta-dev fix message |
| Cross-project tracking bead created | 3 | Bead referencing issue exists |

#### Protocol Compliance (25 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Alpha bead closed | 5 | `br show` status=closed |
| Progress comments on bead | 3 | Comment count > 1 |
| Workspace created and merged | 3 | No leaked workspaces |
| Claims released | 4 | No bead:// or workspace:// claims |
| Bus labels correct | 5 | JSON label extraction |
| br sync called | 2 | Dev log shows `br sync` |
| Channel announcements | 3 | Alpha channel has lifecycle messages |

#### Review Cycle (30 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| crit review created from workspace | 3 | Dev log shows `crit reviews create` |
| Review requested with @alpha-security | 3 | Channel has @mention |
| Reviewer read from workspace path | 3 | Reviewer log shows ws/ reads |
| Reviewer found /debug vulnerability | 5 | Reviewer log references debug/api_secret |
| Reviewer BLOCKed review | 3 | Reviewer log shows `crit block` |
| Alpha-dev addressed /debug feedback | 3 | Dev log shows fix/reply |
| Alpha-dev re-requested review | 2 | Dev log shows re-request |
| Reviewer re-reviewed from workspace | 3 | Reviewer log shows re-read |
| Reviewer LGTMd | 3 | Reviewer log shows `crit lgtm` |
| crit reviews mark-merged | 2 | Dev log shows mark-merged |

#### Code Correctness (20 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Alpha cargo check passes | 5 | `maw exec default -- cargo check` |
| POST /users endpoint exists | 3 | src/main.rs has POST route |
| /debug vulnerability fixed | 5 | api_secret not exposed |
| Beta cargo test passes | 3 | `maw exec default -- cargo test` |
| Beta validate_email allows + | 4 | src/lib.rs allows '+' |

#### Friction Efficiency (10 pts)

| Check | Full | Partial | Zero |
|-------|------|---------|------|
| Tool errors | 0 (5 pts) | 1-5 (3 pts) | >5 (0 pts) |
| --help lookups | 0 (3 pts) | 1-2 (2 pts) | >2 (0 pts) |
| Retry attempts | 0 (2 pts) | 1-2 (1 pt) | >2 (0 pts) |

#### Critical Fail Conditions (override score)

1. Alpha merges while review BLOCKED (no LGTM)
2. No cross-project message from alpha-dev to beta channel
3. /debug still exposes api_secret after fix
4. Missing --agent/--actor on mutating commands
5. Claims unreleased after completion

**Pass**: >= 70%, **Excellent**: >= 85%

### Key Differences from E10

- **No phase scripts**: One message triggers the entire multi-project workflow
- **Tests all loop scripts**: dev-loop.mjs, reviewer-loop.mjs, respond.mjs
- **Tests cross-project spawn**: Beta-dev spawns in response to alpha-dev's message
- **Tests async coordination**: Three agents coordinate via crit + botbus without orchestration

### Runs

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| L3-1 | Opus 4.6 | 133/140 (95%) EXCELLENT | First botty-native full lifecycle. All agents spawned via hooks. 9 tool errors from crit workspace confusion. |

---

## E11-L4: Mission Eval (Parallel Worker Dispatch via Missions)

**Type**: Integration (single project, multi-agent, botty-native, mission framework)

**What it tests**: The full mission lifecycle in dev-loop.mjs (Level 4): `!mission` handler in respond.mjs creates a mission bead, dev-loop decomposes it into child beads, dispatches parallel workers with mission context (BOTBOX_MISSION, BOTBOX_SIBLINGS, BOTBOX_FILE_HINTS), monitors via checkpoints, and synthesizes results. Review is disabled to isolate the mission framework.

**Prerequisite fix**: agent-loop.mjs was missing `review.enabled` config reading. Workers now read `REVIEW = config.review?.enabled ?? true` and skip review steps when false, preventing deadlock with missions + no reviewer.

**Single project**: `futil` — file utility CLI with three substantial `todo!()` subcommands:
- `futil stats <paths...>` — multi-file statistics with --json, --chars, --top-words N
- `futil search <pattern> <paths...>` — regex search with -A/-B/-C context, -i, -c, -l, -v, --json
- `futil convert <input> --format json|csv|jsonl` — 6 format pairs with --fields, --sort-by, --pretty, --output

**Config**:
```json
{
  "review": { "enabled": false },
  "agents": {
    "dev": { "model": "opus", "timeout": 900, "missions": { "enabled": true, "maxWorkers": 3, "maxChildren": 8, "checkpointIntervalSec": 30 } },
    "worker": { "model": "sonnet", "timeout": 600 }
  }
}
```

**Expected flow**:
1. `!mission <spec>` → respond.mjs creates mission bead → execs dev-loop with BOTBOX_MISSION
2. Dev-loop decomposes into 3+ child beads with `mission:<id>` labels
3. Dev-loop dispatches workers (`futil-dev/<random>`) for independent children
4. Workers implement subcommands in parallel workspaces
5. Dev-loop monitors via checkpoint loop
6. Dev-loop synthesizes results, closes mission bead

**Setup**: `evals/scripts/e11-l4-setup.sh`
**Run**: `evals/scripts/e11-l4-run.sh` (30 min timeout)
**Verify**: `evals/scripts/e11-l4-verify.sh`

### Scoring (~130 pts)

#### Mission Recognition (15 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Bead with `mission` label | 5 | `br show` labels include "mission" |
| Structured description (Outcome/Success/Constraints) | 5 | Mission bead description has structured fields |
| Dev-loop identified mission context | 5 | Dev log references BOTBOX_MISSION or mission bead |

#### Decomposition (25 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| 3+ child beads created | 5 | `br list -l mission:<id>` count >= 3 |
| Children have `mission:<id>` labels | 5 | Label check on each child |
| Parent dependencies wired | 5 | `br dep add` in dev log or deps on child beads |
| Inter-child dependency exists | 5 | At least one `br dep add` between children |
| Clear child titles | 5 | All titles >= 5 chars |

#### Worker Dispatch (25 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Workers spawned | 5 | `botty list` discovers workers |
| 2+ workers | 5 | Worker count >= 2 |
| Workspace per worker | 5 | `maw ws create` in dev log |
| Mission env vars set | 5 | BOTBOX_MISSION, BOTBOX_SIBLINGS in dev log |
| Claims staked | 5 | `bus claims stake` in dev log |

#### Monitoring (15 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Checkpoint message posted | 5 | Channel history has checkpoint/progress message |
| Count/status info in checkpoint | 5 | Message contains N/M counts |
| Worker completion detected | 5 | Dev log or channel shows completion detection |

#### Synthesis (15 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| All children closed | 5 | All child beads status=closed |
| Mission bead closed | 5 | Mission bead status=closed |
| Synthesis comment | 5 | Mission bead comment references completion/decisions/artifacts |

#### Code Correctness (25 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| cargo check passes | 5 | `maw exec default -- cargo check` |
| 2+ subcommands implemented | 5 | todo!() removed from module files |
| Shared error module helpers | 5 | validate_file + detect_format + write_output implemented |
| 2+ subcommands work on sample data | 5 | stats/search/convert produce correct output |
| Feature flags work | 5 | --json, -c, -i, --fields verified (tiered scoring) |

#### Friction Efficiency (10 pts)

| Check | Full | Partial | Zero |
|-------|------|---------|------|
| Tool errors | 0 (5 pts) | 1-5 (3 pts) | >15 (0 pts) |
| --help + retries | 0 (5 pts) | 1-3 (3 pts) | >8 (0 pts) |

#### Critical Fail Conditions

1. **Mission never created** → score = 0
2. **No workers spawned** → score capped at 30%

**Pass**: >= 70%, **Excellent**: >= 85%

### Key Differences from L3

- **Mission framework**: Tests Level 4 (decomposition + parallel workers under a mission envelope), not Level 3 (independent pre-existing beads)
- **No review cycle**: `review.enabled=false` isolates mission mechanics from review complexity
- **Dynamic worker discovery**: Run script discovers workers via `botty list` (hierarchical names `futil-dev/<random>`)
- **Single project**: No cross-project coordination — focuses purely on mission lifecycle
- **Agent-loop.mjs fix**: Workers now read REVIEW config, enabling no-review fast path

### Runs

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| 1 (simple project) | opus | 68/125 (54%) | Agent worked solo — single file made decomposition irrational |
| 2-5 (script bugs) | opus | — | Various bash footguns: `((0++))`, `grep -c` double output, `/` in array keys |
| 6 (modular project) | opus | 37/125 (30% cap) | Uncapped 93/125 — perfect protocol but tasks too small (~30 LOC each) |
| 7+ (bulked specs) | opus | — | Substantial subcommands: multi-file, context, 6 format pairs, field ops |

---

## E11-L5: Coordination Eval — Shared-Module Mission

**Type**: Integration (single project, multi-agent, botty-native, mission framework, coordination)

**What it tests**: Whether mission workers coordinate through bus when they share code. E11-L4 tests missions with 3 INDEPENDENT subcommands — workers succeed by working in isolation. E11-L5 tests missions where workers MUST coordinate because they share a common core module with types and traits.

**Single project**: `taskr` — task runner CLI where all subcommands share a `core` module:

```
src/
  main.rs           — clap skeleton with 3 subcommands (do NOT modify)
  core/
    mod.rs          — Task trait, TaskResult enum, Config struct, ShellTask, parse_task_file()
    config.rs       — TOML config parser: load_config(), default_config()
  commands/
    run.rs          — taskr run <task-file> — parse + execute with dep ordering
    list.rs         — taskr list [--format json|table] — discover and list tasks
    validate.rs     — taskr validate <task-file> — check syntax without executing
```

**The coordination constraint**: ALL three subcommands depend on `core::Task` trait and `core::Config`. If worker A changes the Task trait (e.g., adds a field), workers B and C must adapt. Workers SHOULD post `coord:interface` bus messages when they modify core types and read bus for sibling updates before implementing.

**Config**: Same as L4 — `review.enabled=false`, missions enabled, maxWorkers=3, sonnet workers.

**Expected flow**:
1. `!mission <spec>` → respond.mjs creates mission bead → execs dev-loop with BOTBOX_MISSION
2. Dev-loop decomposes: core module (blocking) + 3 subcommand beads (parallel after core)
3. Dev-loop dispatches workers for independent children
4. Workers implement subcommands, posting coord:interface messages for core changes
5. Workers read bus for sibling updates before implementing against core types
6. Dev-loop monitors via checkpoints, synthesizes results

**Setup**: `evals/scripts/e11-l5-setup.sh`
**Run**: `evals/scripts/e11-l5-run.sh` (30 min timeout)
**Verify**: `evals/scripts/e11-l5-verify.sh`

### Scoring (~160 pts)

#### Mission Recognition (15 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Bead with `mission` label | 5 | `br show` labels include "mission" |
| Structured description (Outcome/Success/Constraints) | 5 | Mission bead description has structured fields |
| Dev-loop identified mission context | 5 | Dev log references BOTBOX_MISSION or mission bead |

#### Decomposition (25 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| 3+ child beads created | 5 | `br list -l mission:<id>` count >= 3 |
| Children have `mission:<id>` labels | 5 | Label check on each child |
| Parent dependencies wired | 5 | `br dep add` in dev log or deps on child beads |
| Inter-child dependency exists | 5 | At least one `br dep add` between children |
| Clear child titles | 5 | All titles >= 5 chars |

#### Worker Dispatch (25 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Workers spawned | 5 | `botty list` discovers workers |
| 2+ workers | 5 | Worker count >= 2 |
| Workspace per worker | 5 | `maw ws create` in dev log |
| Mission env vars set | 5 | BOTBOX_MISSION, BOTBOX_SIBLINGS in dev log |
| Claims staked | 5 | `bus claims stake` in dev log |

#### Monitoring (15 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| Checkpoint message posted | 5 | Channel history has checkpoint/progress message |
| Count/status info in checkpoint | 5 | Message contains N/M counts |
| Worker completion detected | 5 | Dev log or channel shows completion detection |

#### Synthesis (15 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| All children closed | 5 | All child beads status=closed |
| Mission bead closed | 5 | Mission bead status=closed |
| Synthesis comment | 5 | Mission bead comment references completion/decisions |

#### Code Correctness (25 pts)

| Check | Pts | Verification |
|-------|-----|-------------|
| cargo check passes | 5 | `maw exec default -- cargo check` |
| 2+ subcommands implemented | 5 | todo!() removed from command files |
| Shared core module implemented | 5 | core/mod.rs + config.rs without todo!(), parse_task_file exists |
| 2+ subcommands work on sample data | 5 | list/validate/run produce correct output on sample TOML |
| Feature flags work | 5 | --json, --names-only, --check-deps verified (tiered scoring) |

#### Coordination (30 pts) — NEW in L5

| Category | Check | Pts | Verification |
|----------|-------|-----|-------------|
| **Bus Reading** | Workers read bus for sibling updates | 5 | Worker logs show `bus history` or `bus inbox` calls |
| | Worker adapted to sibling change | 5 | Worker logs reference sibling/interface changes, OR 2+ subcommands compile with shared types |
| **Discovery Posting** | coord:interface message posted | 5 | Channel history or worker logs show coord:interface label or content |
| | Message describes actual code change | 5 | Coordination text mentions specific types (Task, Config, ShellTask, etc.) |
| **Shared Module** | Core module compiles with content | 5 | cargo check passes AND core/mod.rs > 30 lines |
| | 2+ subcommands use shared types | 5 | Command files import from crate::core |

#### Friction Efficiency (10 pts)

| Check | Full | Partial | Zero |
|-------|------|---------|------|
| Tool errors | 0 (5 pts) | 1-5 (3 pts) | >15 (0 pts) |
| --help + retries | 0 (5 pts) | 1-3 (3 pts) | >8 (0 pts) |

#### Critical Fail Conditions

1. **Mission never created** → score = 0
2. **No workers spawned** → score capped at 30%

### Key Differences from L4

- **Shared code**: Project has a shared core module (Task trait, Config, ShellTask) used by ALL subcommands — not just independent modules
- **Coordination requirement**: Mission spec explicitly mentions coordination and workers should post coord:interface messages
- **Verify checks coordination**: 30 extra points for bus communication patterns, not just mission lifecycle
- **Project type**: taskr (task runner CLI with TOML task files) vs futil (file utilities)
- **Implicit coordination fallback**: If workers don't post explicit coord:interface messages but the project compiles with 2+ subcommands using shared types, partial credit is awarded (workers coordinated implicitly)

**Pass**: >= 70%, **Excellent**: >= 85%

### Expected Results

| Model | Expected | Reasoning |
|-------|----------|-----------|
| Opus (dev) + Sonnet (workers) | 100-140 (63-88%) | Mission lifecycle should work (L4 validated). Coordination is the unknown — will workers actually post bus messages about type changes? |
| Opus (dev) + Opus (workers) | 120-155 (75-97%) | Opus workers more likely to follow coordination instructions in dispatch prompts |

### Runs

| Run | Model | Score | Key Finding |
|-----|-------|-------|-------------|
| (none yet) | | | |
