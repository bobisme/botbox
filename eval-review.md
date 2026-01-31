# Review Eval

Behavioral evaluation of reviewer agents using crit. Tests whether agents can find real bugs, leave useful feedback, and make correct approval/block decisions.

This is the next step toward the full dev-agent architecture described in `docs/dev-agent-architecture.md`. The worker loop evals validated triage → start → work → finish. This eval validates the review lifecycle.

## Levels

| Level | Focus | Agents | Status |
|-------|-------|--------|--------|
| R1 | Reviewer agent: find bugs, comment, vote | 1 (reviewer) | Planned |
| R2 | Author response: handle comments, fix, re-request | 1 (dev agent) | Future |
| R3 | Full loop: author requests → reviewer reviews → author responds → merge | 2 (dev + reviewer) | Future |
| R4 | Integration: worker loop + review + merge | 2+ (dev + workers + reviewer) | Future |

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
botbox init --name review-eval --type api --tools beads,maw,crit,botbus,botty --init-beads --no-interactive
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
REVIEWER=$(botbus generate-name)
crit reviews create --agent eval-author --title "feat: add user lookup endpoint" \
  --description "Adds GET /users/:id endpoint with database lookup"
# Note the review ID from output, e.g., cr-xxxx

# Request review.
crit reviews request <review-id> --agent eval-author --reviewers "$REVIEWER"

# Announce on botbus.
botbus mark-read --agent "$REVIEWER" review-eval
botbus send --agent eval-author review-eval \
  "Review requested: <review-id> @$REVIEWER" -L mesh -L review-request
```

### Execution

```bash
claude ${CLAUDE_MODEL:+--model "$CLAUDE_MODEL"} \
  --dangerously-skip-permissions --allow-dangerously-skip-permissions -p "
You are security reviewer agent \"$REVIEWER\" for project \"review-eval\".
Use --agent $REVIEWER on ALL crit and botbus commands.

Review workflow:
1. Check botbus inbox: botbus inbox --agent $REVIEWER --channels review-eval --mark-read
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
6. Announce: botbus send --agent $REVIEWER review-eval \"Review complete: <id>\" -L mesh -L review-done

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
botbus history review-eval --limit 10 | grep "$REVIEWER"
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
Use --agent ${AUTHOR} on ALL crit and botbus commands.

Your code review cr-5c3z has been BLOCKED by a reviewer. You need to handle the feedback.

Workflow:
1. Check botbus inbox: botbus inbox --agent ${AUTHOR} --channels review-eval --mark-read
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
   d. Announce: botbus send --agent ${AUTHOR} review-eval \"Review feedback addressed: cr-5c3z\" -L mesh -L review-response

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
| Botbus announcement | 5 | `botbus history review-eval` shows message |

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
Use --agent ${REVIEWER} on ALL crit and botbus commands.

You previously BLOCKED review cr-5c3z. The author has addressed your feedback.

Re-review workflow:
1. botbus inbox --agent ${REVIEWER} --channels review-eval --mark-read
2. crit inbox --agent ${REVIEWER}
3. crit review cr-5c3z — read all threads and author replies
4. Read the CURRENT source (cat src/main.rs) — verify each fix
5. Run cargo clippy to confirm clean
6. If all issues resolved:
   crit lgtm cr-5c3z --agent ${REVIEWER} --reason \"All issues resolved: <summary>\"
   botbus send --agent ${REVIEWER} review-eval \"Re-review: cr-5c3z — LGTM\" -L mesh -L review-done
7. If issues remain: reply on thread, keep block

Be thorough. Read actual code, don't just trust replies."
```

**Phase 2: Merge** — author sees LGTM, squashes fix, marks review merged.

```bash
AUTHOR="eval-author"
PROMPT="You are dev agent \"${AUTHOR}\" for project \"review-eval\".
Use --agent ${AUTHOR} on ALL crit and botbus commands.

Check if cr-5c3z is approved and merge.

Steps:
1. botbus inbox --agent ${AUTHOR} --channels review-eval --mark-read
2. crit review cr-5c3z — check for LGTM vote
3. If LGTM (no blocks):
   a. jj squash — squash fix into parent change
   b. jj describe -m \"feat: add user lookup and file serving endpoints\"
   c. crit reviews merge cr-5c3z --agent ${AUTHOR}
   d. botbus send --agent ${AUTHOR} review-eval \"Merged: cr-5c3z\" -L mesh -L merge
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
| Botbus announcement | 5 | `botbus history` shows review-done |

#### Merge Phase (30 points)

| Criterion | Points | Verification |
|-----------|--------|--------------|
| Checked for LGTM before merging | 5 | Agent reads review before acting |
| Squashed fix into original change | 5 | `jj log` shows single clean commit |
| Review marked as merged in crit | 5 | `crit reviews list --json` shows merged |
| Botbus merge announcement | 5 | `botbus history` shows merge message |
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

---

## Future Levels

### R4: Integration

**Prerequisite**: R3 + worker loop evals.

Full dev-agent architecture running end-to-end:

1. Dev agent triages inbox and beads
2. Dispatches work (sequential or parallel via worker agents)
3. Workers complete tasks
4. Dev agent creates crit reviews for completed work
5. Reviewer agent reviews, dev agent handles feedback
6. Dev agent merges approved work

This is the target described in `docs/dev-agent-architecture.md`. Scoring combines worker loop (248 pts), review (65 pts), and coordination mechanics (dispatch, tracking, merge).

### Beyond R4

Once the single-project dev agent is validated:

- **Multi-project coordination**: Dev agents for different projects filing cross-project issues (report-issue.md), reviewing each other's APIs
- **Parallel dispatch eval**: Dev agent has 3+ independent beads, spawns Haiku workers, tracks completions, handles failures (worker gets stuck → dev agent reassigns)
- **Planning eval**: Opus dev agent receives a large feature request, breaks it into beads with dependency graph, sequences work across iterations
- **Adversarial review**: Reviewer intentionally given code with subtle, hard-to-find bugs (concurrency issues, edge cases in error paths) to test the ceiling of review quality
- **Recovery eval**: Mid-run failure simulation — worker crashes, reviewer times out, botbus goes down — testing whether the dev agent recovers gracefully on next iteration
