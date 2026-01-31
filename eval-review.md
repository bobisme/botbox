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
- Bug: `GET /files/:name` reads files using user input in path without sanitization (`format!("data/{}", name)` — allows `../etc/passwd`)
- Quality: Error handler returns raw error string to client (leaks internals)
- Clean: Uses `unsafe` for a zero-copy buffer optimization with a correct safety comment

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

## Future Levels

### R2: Author Response

**Prerequisite**: R1 validates that reviewers produce useful feedback.

The dev agent sees reviewer comments on its next loop iteration and must handle each one:

- **Fix**: Make a code change, commit, reply "Fixed in <change>"
- **Address**: Reply explaining why the current approach is correct (won't-fix)
- **Defer**: Create a bead, reply "Filed <bead-id> for follow-up"

**Setup**: Seed a crit review with pre-written reviewer comments (from an R1 run or manually authored). Run the dev agent's loop. Score whether it correctly categorizes each comment and takes the right action.

**Key question**: Can the agent distinguish "must fix before merge" from "acknowledged, won't fix" from "good idea, but not now"?

### R3: Full Review Loop

**Prerequisite**: R1 + R2 validated independently.

Two agents, coordinating across iterations:

1. Dev agent finishes work, creates crit review, announces on botbus
2. Reviewer agent picks up review, comments, blocks
3. Dev agent sees block, fixes the issue, re-requests review
4. Reviewer verifies fix, LGTMs
5. Dev agent merges

This tests the full back-and-forth. The scoring combines R1 (reviewer quality) and R2 (author response) plus coordination mechanics (did the re-request work? did the reviewer re-check?).

**Execution**: Either two concurrent `claude -p` sessions coordinating via botbus/crit, or sequential (dev → reviewer → dev → reviewer) with state persisted in crit between runs.

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
