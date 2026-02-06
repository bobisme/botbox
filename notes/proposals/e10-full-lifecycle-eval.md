# Proposal: E10 Full Lifecycle Eval

**Status**: PROPOSAL
**Author**: botbox-dev
**Date**: 2026-02-06

## Summary

Design a heavyweight eval that simulates a complete multi-project agent ecosystem in isolation, exercising the full botbox workflow end-to-end: triage, workspace management, cross-project coordination via bus, code review cycle, merge, and release. Two projects share a botbus instance, with agents communicating as peers to discover and resolve a dependency bug before completing their own work.

## Motivation

After 27 eval runs across 11 eval types (L2, Agent Loop, R1-R9), individual workflow stages are well-tested. But no eval tests the **full chain** from task request to release across multiple projects. Gaps:

1. **No eval tests cross-project peer communication** — R5 tested filing a bug unilaterally. Real agents need to ask questions, discuss, reach consensus, and wait for fixes.
2. **No eval tests the full review→block→fix→re-review→LGTM→merge flow** in a single continuous scenario.
3. **No eval tests release detection** (feat/fix commits triggering version bumps).
4. **No eval exercises all companion tools in one run** — individual evals touch subsets.
5. **No eval tests hook registration verification** — hooks are set up during init but never checked.

This eval is intentionally heavyweight. The goal is to simulate the whole world in isolation and expose bugs or gaps in the tool suite.

## The World

### Projects

Two projects running on a shared, isolated botbus instance:

**Project Alpha** (`$EVAL_DIR/alpha/`) — Rust/Axum REST API
- Tools: beads, maw, crit, botbus, botty
- Agents: `alpha-dev` (lead developer), `alpha-security` (security reviewer)
- Cargo path dependency on Beta
- Has a pre-existing `GET /debug` endpoint that exposes `AppState` including a hardcoded `api_secret` (planted security vulnerability for reviewer to find)

**Project Beta** (`$EVAL_DIR/beta/`) — Rust utility library
- Tools: beads, maw, crit, botbus
- Agents: `beta-dev` (lead developer)
- Provides `validate_email()` with a planted bug: rejects `+` in the local part via an overly restrictive character whitelist

### Shared Infrastructure

```
$EVAL_DIR/
├── .botbus/           # Isolated BOTBUS_DATA_DIR (initialized before everything)
├── alpha/             # Project Alpha (Axum REST API)
│   ├── .beads/
│   ├── .workspaces/
│   ├── .crit/
│   ├── .botbox.json
│   ├── .agents/botbox/
│   ├── Cargo.toml     # depends on beta via path
│   └── src/main.rs    # /health + /debug (vulnerability)
├── beta/              # Project Beta (utility library)
│   ├── .beads/
│   ├── .workspaces/
│   ├── .crit/
│   ├── .botbox.json
│   └── src/lib.rs     # validate_email (buggy)
└── .eval-env          # Saved env vars for phase scripts
```

All temp dirs kept for forensics. `$EVAL_DIR` path printed at setup and never cleaned up.

### Agent Identities

| Agent | Project | Role | Model |
|-------|---------|------|-------|
| `alpha-dev` | Alpha | Lead developer | Opus |
| `alpha-security` | Alpha | Security reviewer | Opus |
| `beta-dev` | Beta | Lead developer | Sonnet |

Identities are deterministic for scoring reproducibility: `alpha-dev`, `alpha-security`, `beta-dev`. (`bus generate-name` can be used in a future live-mode variant.)

## Planted Defects

### Beta: Email Validation Bug

`validate_email()` uses a character whitelist for the local part that excludes `+`:

```rust
pub fn validate_email(email: &str) -> Result<(), String> {
    let parts: Vec<&str> = email.splitn(2, '@').collect();
    if parts.len() != 2 {
        return Err("Invalid email: missing @".to_string());
    }
    let local = parts[0];
    let domain = parts[1];
    if local.is_empty() || domain.is_empty() {
        return Err("Invalid email: empty local or domain part".to_string());
    }
    // Only allow alphanumeric, dots, hyphens, underscores in local part
    if !local.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_') {
        return Err(format!("Invalid character in email local part: {}", local));
    }
    if !domain.contains('.') {
        return Err("Invalid email: domain must contain a dot".to_string());
    }
    Ok(())
}
```

Existing tests pass (none cover `+`). Alpha's bead description explicitly requires subaddressing support (`user+tag@example.com`).

### Alpha: Debug Endpoint Vulnerability

Setup writes `src/main.rs` with a `GET /debug` endpoint that returns the full `AppState` as JSON, including a hardcoded `api_secret: String` field. This is present from the start — the agent doesn't create it. The security reviewer should catch it during review.

```rust
#[derive(Clone, Serialize)]
pub struct AppState {
    pub users: Arc<Mutex<Vec<User>>>,
    pub next_id: Arc<AtomicU64>,
    pub api_secret: String,  // "E10_SENTINEL_SECRET_NOT_REAL"
}

async fn debug(State(state): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "user_count": state.users.lock().unwrap().len(),
        "next_id": state.next_id.load(std::sync::atomic::Ordering::Relaxed),
        "api_secret": state.api_secret,
    }))
}
```

## Scenario

Alpha receives a task: "Add user registration endpoint with email validation." During implementation, alpha-dev discovers beta's `validate_email()` rejects valid emails with `+`. Rather than working around it or filing a unilateral bug, alpha-dev reaches out to beta-dev as a peer via bus to discuss the behavior. They collaborate to reach consensus, beta-dev fixes the library, and alpha-dev resumes. Alpha then goes through security review, handles blocking feedback, and releases.

The cross-project interaction is **collaborative, not directive**. Alpha-dev relies on beta-dev's domain expertise rather than just pushing beads onto their backlog.

## Phases

### Phase 0: Setup (automated script)

Creates the entire world from scratch.

```bash
set -euo pipefail

# --- Preflight: fail fast on missing dependencies ---
REQUIRED_CMDS=(botbox bus br bv maw crit botty jj cargo claude jq)
for cmd in "${REQUIRED_CMDS[@]}"; do
  command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd" >&2; exit 1; }
done

# --- Paths and identities ---
EVAL_DIR=$(mktemp -d)
ALPHA_DIR="$EVAL_DIR/alpha"
BETA_DIR="$EVAL_DIR/beta"
mkdir -p "$ALPHA_DIR" "$BETA_DIR" "$EVAL_DIR/artifacts"

ALPHA_DEV="alpha-dev"
ALPHA_SECURITY="alpha-security"
BETA_DEV="beta-dev"

export BOTBUS_DATA_DIR="$EVAL_DIR/.botbus"
bus init

# --- Capture tool versions for forensics ---
{
  echo "timestamp=$(date -Iseconds)"
  for cmd in botbox bus br bv maw crit botty jj cargo; do
    echo "$cmd=$($cmd --version 2>/dev/null || echo unknown)"
  done
  echo "model_alpha=opus"
  echo "model_beta=sonnet"
} > "$EVAL_DIR/artifacts/tool-versions.env"

# --- Beta ---
cd "$BETA_DIR"
jj git init
botbox init --name beta --type library --tools beads,maw,crit,botbus --init-beads --no-interactive
cargo init --lib
# Write Cargo.toml, src/lib.rs (buggy validate_email + passing tests)
crit init && maw init
jj describe -m "beta: validation library" && jj new

# --- Alpha ---
cd "$ALPHA_DIR"
jj git init
botbox init --name alpha --type api --tools beads,maw,crit,botbus,botty --review-security --init-beads --no-interactive
cargo init
# Write Cargo.toml (path dep on beta), src/main.rs (/health + /debug vulnerability)
cargo check  # verify compiles with beta dependency
crit init && maw init
jj describe -m "alpha: initial API with health and debug endpoints" && jj new

# --- Hooks (verify they were registered by botbox init) ---
bus hooks list  # capture output for Phase 4.5 verification

# --- Seed work ---
BEAD=$(br create --actor setup --owner "$ALPHA_DEV" \
  --title="Add user registration with email validation" \
  --description="Implement POST /users with beta::validate_email. Must support plus-addressing (user+tag@example.com)." \
  --type=feature --priority=2 2>&1 | grep -oP 'bd-\w+')
bus send --agent setup alpha "New task: Add POST /users registration endpoint. Must support standard email formats including subaddressing (user+tag@example.com). Use beta's validate_email for validation." -L task-request

# --- Projects registry ---
bus send --agent "$BETA_DEV" projects "project: beta  repo: $BETA_DIR  lead: $BETA_DEV  tools: validation, parsing"
bus send --agent "$ALPHA_DEV" projects "project: alpha  repo: $ALPHA_DIR  lead: $ALPHA_DEV  tools: api, users"

# --- Mark setup messages read for agents ---
bus inbox --agent "$ALPHA_DEV" --channels alpha --mark-read >/dev/null 2>&1
bus inbox --agent "$ALPHA_DEV" --channels projects --mark-read >/dev/null 2>&1
bus inbox --agent "$BETA_DEV" --channels beta --mark-read >/dev/null 2>&1
bus inbox --agent "$BETA_DEV" --channels projects --mark-read >/dev/null 2>&1

# --- Save env ---
cat > "$EVAL_DIR/.eval-env" << EOF
export EVAL_DIR="$EVAL_DIR"
export BOTBUS_DATA_DIR="$EVAL_DIR/.botbus"
export ALPHA_DIR="$ALPHA_DIR"
export BETA_DIR="$BETA_DIR"
export ALPHA_DEV="$ALPHA_DEV"
export ALPHA_SECURITY="$ALPHA_SECURITY"
export BETA_DEV="$BETA_DEV"
export BEAD="$BEAD"
EOF
```

### Phase 1: Alpha Triage + Implement + Discover Issue (alpha-dev, Opus)

**Prompt essence**: You are alpha-dev. Read inbox, triage, claim the bead, create a workspace, implement POST /users with email validation using beta's `validate_email()`. Write tests including `user+tag@example.com`. When the test fails, investigate beta's code. Ask beta-dev about the behavior via bus — don't just file a bug. Stop after sending the question.

**Expected agent behavior**:
1. `bus inbox --agent $ALPHA_DEV --channels alpha --mark-read` → sees task request
2. `br ready` → finds registration bead
3. `br show $BEAD` → reads requirements (mentions subaddressing support)
4. `br update --actor $ALPHA_DEV $BEAD --status=in_progress`
5. `bus claims stake --agent $ALPHA_DEV "bead://alpha/$BEAD"`
6. `maw ws create --random` → gets workspace name + absolute path
7. `bus claims stake --agent $ALPHA_DEV "workspace://alpha/$WS"`
8. Implements POST /users handler in workspace using absolute paths
9. Calls `beta::validate_email()` in handler
10. Writes test with `user+tag@example.com` → `cargo test` fails
11. Reads beta's `src/lib.rs` → sees the character whitelist excluding `+`
12. `bus history projects` → discovers beta project
13. `bus send --agent $ALPHA_DEV beta "Hey @beta-dev — I'm using validate_email() in alpha's new registration endpoint and hit an issue: it rejects user+tag@example.com. We need subaddressing support (plus addressing). Is the + exclusion intentional? The local-part whitelist in validate_email only allows alphanumeric, dots, hyphens, underscores." -L feedback`
14. `br comments add --actor $ALPHA_DEV --author $ALPHA_DEV $BEAD "Blocked: beta validate_email rejects + in local part. Asked beta-dev about it on bus."`

**Tools exercised**: `bus inbox`, `bus send`, `bus history`, `bus claims stake`, `br ready`, `br show`, `br update`, `br comments add`, `maw ws create`, `maw ws jj`, `cargo test`, `cargo check`

### Phase 2: Beta Investigates + Responds (beta-dev, Sonnet)

**Prompt essence**: You are beta-dev for the beta validation library. Check your inbox. Alpha-dev has a question about validate_email behavior. Investigate your own code, consider the question, and respond on their channel. If they're right, say you'll fix it and create a bead. If not, explain why.

**Expected agent behavior**:
1. `bus inbox --agent $BETA_DEV --channels beta --mentions --mark-read` → sees alpha-dev's question
2. Reads own `src/lib.rs` → examines the character whitelist
3. Considers: RFC 5321 allows `+` in local-part; major email providers support it
4. Decides alpha-dev is right — the whitelist is overly restrictive
5. `br create --actor $BETA_DEV --owner $BETA_DEV --title="validate_email: allow + in local part" --description="..." --type=bug --priority=2`
6. `bus send --agent $BETA_DEV alpha "Good catch @alpha-dev — the + exclusion was overly conservative. RFC 5321 allows printable characters including + in the local part. I'll fix this and add test coverage. Created bead <id> to track it." -L feedback`

**Tools exercised**: `bus inbox --mentions`, `bus send` (cross-project response), `br create`, `br show`

### Phase 3: Beta Fixes + Releases (beta-dev, Sonnet)

**Prompt essence**: You are beta-dev. You have a bead to fix validate_email to allow + in the local part. Create a workspace, fix the code, add tests, merge, close the bead, and announce the fix to alpha.

**Expected agent behavior**:
1. `br update --actor $BETA_DEV $BUG_BEAD --status=in_progress`
2. `maw ws create --random` → workspace
3. Fixes the character whitelist to include `+` (and possibly other valid chars)
4. Adds test: `validate_email("user+tag@example.com")` → Ok
5. `cargo test` → all pass
6. `maw ws jj $WS describe -m "fix: allow + in email local part"`
7. `maw ws merge $WS --destroy`
8. `br close --actor $BETA_DEV $BUG_BEAD`
9. `bus send --agent $BETA_DEV alpha "@alpha-dev Fixed: validate_email now allows + in the local part. Should unblock your registration endpoint." -L task-done`
10. `bus send --agent $BETA_DEV beta "Closed $BUG_BEAD: validate_email + support" -L task-done`

**Tools exercised**: `br update`, `br close`, `maw ws create`, `maw ws merge --destroy`, `maw ws jj`, `bus send` (fix announcement across projects), `cargo test`, `jj describe`

### Phase 4: Alpha Resumes + Completes + Requests Review (alpha-dev, Opus)

**Prompt essence**: You are alpha-dev, continuing work on the registration bead. Beta-dev fixed the email validation issue. Check your inbox, verify your tests now pass, finish the implementation, create a crit review, and request review from alpha-security.

**Expected agent behavior**:
1. `bus inbox --agent $ALPHA_DEV --channels alpha --mark-read` → sees beta-dev's fix announcement
2. `cargo test` in workspace → tests now pass (beta's fix was merged to main in Phase 3, and alpha's Cargo.toml uses `path = "../beta"` which resolves to beta's main worktree)
3. Finishes any remaining implementation work
4. `maw ws jj $WS describe -m "feat: add POST /users registration with email validation"`
5. `br comments add --actor $ALPHA_DEV --author $ALPHA_DEV $BEAD "Beta fixed validate_email. Tests pass. Implementation complete, requesting review."`
6. `crit reviews create --agent $ALPHA_DEV --path $WS_PATH`
7. `crit reviews request $REVIEW_ID --reviewers $ALPHA_SECURITY --agent $ALPHA_DEV`
8. `bus send --agent $ALPHA_DEV alpha "Review requested: $REVIEW_ID @alpha-security" -L review-request`

**Tools exercised**: `bus inbox`, `cargo test`, `crit reviews create --path`, `crit reviews request`, `bus send` (with @mention), `br comments add`, `maw ws jj`

### Phase 4.5: Hook Verification (eval script, automated)

Between Phase 4 and Phase 5, the eval script checks whether the review-request @mention would trigger the correct hook:

```bash
# Verify hooks are registered correctly
bus hooks list | grep "alpha-security"  # mention hook exists?

# Check if hook command is well-formed
# Expected: botty spawn ... --mention alpha-security ... --pass-env ...

# Optionally: check if botty actually spawned (if hooks fired)
botty list 2>/dev/null | grep "alpha-security" || echo "Hook did not fire (expected in phased mode)"
```

This phase is scored but doesn't invoke an agent. It validates that `botbox init` set up hooks correctly.

**Tools exercised**: `bus hooks list`, `botty list` (verification)

### Phase 5: Security Review (alpha-security, Opus)

**Prompt essence**: You are alpha-security, a security reviewer for the alpha project. Check crit inbox for pending reviews. Review the code in the workspace path. Look for security vulnerabilities, focusing on input validation, data exposure, and access control. Leave comments with severity tags. Block if you find CRITICAL or HIGH issues.

**Expected agent behavior**:
1. `crit inbox --agent $ALPHA_SECURITY --all-workspaces` → finds pending review
2. `crit review $REVIEW_ID` → reads diff (workspace path is embedded in the review)
3. Reads source files **from workspace path** (not project root)
4. Finds the `/debug` endpoint exposing `api_secret` → CRITICAL
5. Reviews registration endpoint for other issues
6. `crit comment --file src/main.rs --line N $REVIEW_ID "CRITICAL: /debug endpoint exposes api_secret in response body. This leaks the application secret to any unauthenticated caller. Remove the endpoint or strip sensitive fields."`
7. `crit block $REVIEW_ID --reason "CRITICAL: secret exposure via /debug endpoint"`
8. `bus send --agent $ALPHA_SECURITY alpha "Review $REVIEW_ID: BLOCKED — /debug endpoint exposes api_secret. See crit thread for details. @alpha-dev" -L review-done`

**Tools exercised**: `crit inbox --all-workspaces`, `crit review`, `crit comment --file --line`, `crit block`, `bus send` (review result with @mention)

### Phase 6: Alpha Fixes Review Feedback (alpha-dev, Opus)

**Prompt essence**: You are alpha-dev. The security reviewer blocked your review. Read the feedback, fix the issue in your workspace, reply on the crit thread, and re-request review.

**Expected agent behavior**:
1. `bus inbox --agent $ALPHA_DEV --channels alpha --mark-read` → sees block notification
2. `crit review $REVIEW_ID` → reads threads, sees CRITICAL on /debug endpoint
3. Removes or secures the `/debug` endpoint in workspace
4. `cargo check` in workspace → passes
5. `crit reply $THREAD_ID "Removed the /debug endpoint entirely. The api_secret field is still in AppState for internal use but is no longer exposed via any route."`
6. `maw ws jj $WS describe -m "feat: add POST /users registration with email validation\n\nRemoved /debug endpoint (security: exposed api_secret)"`
7. `crit reviews request $REVIEW_ID --reviewers $ALPHA_SECURITY --agent $ALPHA_DEV`
8. `bus send --agent $ALPHA_DEV alpha "Fixed review feedback, re-requesting review @alpha-security" -L review-request`

**Tools exercised**: `crit review`, `crit reply`, `crit reviews request` (re-request), `bus send`, `maw ws jj`, `cargo check`

### Phase 7: Re-review + LGTM (alpha-security, Opus)

**Prompt essence**: You are alpha-security. Alpha-dev has addressed your review feedback. Re-review the code from the workspace path. Verify the /debug endpoint is removed and no new issues were introduced. LGTM if the fix is satisfactory.

**Expected agent behavior**:
1. `crit inbox --agent $ALPHA_SECURITY --all-workspaces` or `bus inbox --mentions`
2. `crit review $REVIEW_ID --since <timestamp>` → sees changes since last review
3. Reads source files **from workspace path** — verifies /debug is gone
4. Verifies registration endpoint is still correct
5. `crit lgtm $REVIEW_ID -m "Security issue resolved. Registration endpoint looks good."`
6. `bus send --agent $ALPHA_SECURITY alpha "Review $REVIEW_ID: LGTM @alpha-dev" -L review-done`

**Tools exercised**: `crit review --since`, `crit lgtm`, `bus send`, reading from workspace path

### Phase 8: Merge + Finish + Release (alpha-dev, Opus)

**Prompt essence**: You are alpha-dev. Your review has been approved. Complete the full finish protocol: mark review merged, merge workspace, close bead, release claims, sync, check for version bump, announce.

**Expected agent behavior**:
1. `bus inbox --agent $ALPHA_DEV --channels alpha --mark-read` → sees LGTM
2. `crit reviews mark-merged $REVIEW_ID`
3. `maw ws merge $WS --destroy`
4. `br close --actor $ALPHA_DEV $BEAD`
5. `bus claims release --agent $ALPHA_DEV --all`
6. `br sync --flush-only`
7. Version bump: detect `feat:` commit → bump minor version in Cargo.toml
8. `jj describe -m "feat: add POST /users registration with email validation"`
9. `jj new`
10. `jj tag create v0.2.0 -r @-`
11. `bus send --agent $ALPHA_DEV alpha "Closed $BEAD: user registration endpoint. Released v0.2.0." -L task-done`

**Tools exercised**: `crit reviews mark-merged`, `maw ws merge --destroy`, `br close`, `bus claims release --all`, `br sync --flush-only`, `jj describe`, `jj new`, `jj tag create`, `bus send`

## Tool Coverage Matrix

| Tool | Command | Phases | Notes |
|------|---------|--------|-------|
| **bus** | `init` | 0 | Isolated BOTBUS_DATA_DIR |
| | `send` (with labels) | 0,1,2,3,4,5,6,7,8 | Cross-project, review-request, task-done, feedback |
| | `inbox` (--mentions, --mark-read) | 1,2,4,5,6,7,8 | Both channel-scoped and mention-scoped |
| | `history` (projects channel) | 1 | Cross-project discovery |
| | `claims stake` | 1 | bead:// and workspace:// URIs |
| | `claims release --all` | 8 | Cleanup |
| | `claims list` | verify | Forensics |
| | `hooks list` | 4.5 | Verify hook registration |
| | `inbox --mark-read` | 0 | Setup cleanup |
| **beads** | `create` | 0,1,2 | In both alpha and beta dirs |
| | `ready` | 1 | Triage |
| | `show` | 1,2 | Bead details |
| | `update --status` | 1,3 | open → in_progress |
| | `close` | 3,8 | In both projects |
| | `comments add` | 1,4 | Progress tracking |
| | `sync --flush-only` | 8 | Final sync |
| | `bv --robot-next` | 1 | Triage recommendation |
| **maw** | `ws create --random` | 1,3 | In both projects |
| | `ws merge --destroy` | 3,8 | In both projects |
| | `ws jj ... describe` | 1,3,4,6 | Commit messages |
| | `ws list` | verify | Forensics |
| | `ws status` | verify | Forensics |
| **crit** | `reviews create --path` | 4 | Workspace-aware review creation |
| | `reviews request` | 4,6 | Initial + re-request |
| | `review` | 5,6,7 | Read review with threads |
| | `review --since` | 7 | Changes since last review |
| | `comment --file --line` | 5 | Line-level comments |
| | `reply` | 6 | Thread replies |
| | `block` | 5 | Blocking vote |
| | `lgtm` | 7 | Approval vote |
| | `reviews mark-merged` | 8 | Post-merge bookkeeping |
| | `inbox --all-workspaces` | 5,7 | Reviewer discovers work |
| **botty** | `list` | 4.5 | Verify spawned agents |
| | Hook spawning | 4.5 | Verify hook→spawn chain |
| **jj** | `git init` | 0 | Both projects |
| | `describe` | 0,3,8 | Commit messages |
| | `new` | 0,8 | Finalize commits |
| | `tag create` | 8 | Release tagging |
| | `log` | verify | Forensics |

## Scoring Rubric (~160 points)

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
| Communicates with beta-dev via bus (not just filing a bead) | 2 | `bus send beta "..." -L feedback` with question/discussion tone |

### Phase 2: Beta Investigates + Responds (15 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Reads inbox, finds alpha-dev's question | 3 | `bus inbox` with --mentions |
| Investigates own code before responding | 3 | Reads src/lib.rs |
| Responds with domain expertise (not just "ok I'll fix it") | 3 | Response references RFC or explains the rationale |
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
| Creates crit review with --path | 4 | `crit reviews create --path $WS_PATH` |
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
| Reads code from workspace path (not project root) | 3 | File reads use .workspaces/ path |
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
| Reads from workspace path (not main) | 3 | File reads use .workspaces/ path |
| Verifies /debug is removed | 4 | Session shows verification |
| LGTMs | 3 | `crit lgtm` called |

### Phase 8: Merge + Finish + Release (15 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Marks review merged | 2 | `crit reviews mark-merged` |
| Merges workspace | 3 | `maw ws merge --destroy`, workspace gone from `maw ws list` |
| Closes bead | 2 | `br show` status=closed |
| Releases all claims | 2 | `bus claims list --agent $ALPHA_DEV` is empty |
| Syncs beads | 1 | `br sync --flush-only` |
| Version bump + tag | 3 | Cargo.toml version updated, `jj tag create v0.2.0` |
| Completion announcement | 2 | `bus send alpha "..." -L task-done` |

### Communication Throughout (15 pts)

| Criterion | Pts | Verification |
|-----------|-----|-------------|
| Progress comments on beads | 5 | `br comments` shows updates at key milestones |
| Bus messages use correct labels | 5 | feedback, review-request, review-done, task-done used appropriately |
| Agent identity consistent (--agent/--actor on mutating commands) | 5 | No bare br/bus/crit mutation commands without --agent/--actor (reads like `br ready`, `crit review` don't require it) |

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
| **Total** | **160** |

### Critical Fail Conditions (override score)

Any of the following results in overall **FAIL**, regardless of point total:
1. Alpha merges or closes bead while review is BLOCKED (no LGTM).
2. No cross-project peer message from alpha-dev to beta channel in Phase 1.
3. `/debug` endpoint still exposes `api_secret` after Phase 6.
4. Mutating `bus`/`br`/`crit` commands missing identity flags (`--agent`/`--actor`). Read-only commands (`br ready`, `crit review`, `bus history`) are exempt.
5. Claims remain unreleased after Phase 8.

**Pass**: >= 112 (70%)
**Excellent**: >= 144 (90%)

## Verification Script (e10-verify.sh)

Post-run automated checks:

```bash
source $EVAL_DIR/.eval-env

echo "=== E10 Verification ==="

# --- Alpha state ---
cd $ALPHA_DIR
echo "Alpha beads:" && br ready          # should be empty
echo "Alpha bead:" && br show $BEAD      # should be closed
echo "Alpha workspaces:" && maw ws list  # should be empty
echo "Alpha claims:" && bus claims list --agent $ALPHA_DEV  # should be empty
echo "Alpha cargo:" && cargo check       # should compile
echo "Alpha jj:" && jj log --no-graph -n 5

# --- Beta state ---
cd $BETA_DIR
echo "Beta beads:" && br ready           # should be empty (or just backlog items)
echo "Beta cargo:" && cargo test         # should pass including + test
echo "Beta jj:" && jj log --no-graph -n 5

# --- Cross-project communication ---
echo "Alpha channel:" && bus history alpha -n 20
echo "Beta channel:" && bus history beta -n 20
echo "Projects registry:" && bus history projects -n 10

# --- Review state ---
cd $ALPHA_DIR
echo "Alpha reviews:" && crit reviews list 2>/dev/null || echo "(no reviews command, check manually)"

# --- Hook state ---
echo "Hooks:" && bus hooks list

echo ""
echo "=== Forensics ==="
echo "EVAL_DIR=$EVAL_DIR"
echo "BOTBUS_DATA_DIR=$BOTBUS_DATA_DIR"
echo "Run 'bus history <channel>' or 'br show <id>' for details"
```

## Script Structure

```
evals/scripts/
├── e10-setup.sh          # Phase 0: preflight + create world
├── e10-phase1.sh         # Alpha triage + implement + discover
├── e10-phase2.sh         # Beta investigates + responds
├── e10-phase3.sh         # Beta fixes + releases
├── e10-phase4.sh         # Alpha resumes + review request
├── e10-phase5.sh         # Security review
├── e10-phase6.sh         # Alpha fixes feedback
├── e10-phase7.sh         # Re-review + LGTM
├── e10-phase8.sh         # Merge + finish + release
└── e10-verify.sh         # Automated verification
```

Each phase script:
1. Sources `$EVAL_DIR/.eval-env` (which exports `BOTBUS_DATA_DIR` for tool isolation)
2. Auto-discovers dynamic state (review IDs, workspace names) from tool output
3. Builds prompt with concrete values
4. Invokes `claude --model <model> -p "$PROMPT" --dangerously-skip-permissions --allow-dangerously-skip-permissions` with a `timeout` guard
5. Saves prompt and stdout/stderr to `$EVAL_DIR/artifacts/phaseN.{prompt.md,stdout.log,stderr.log}`
6. Saves any new state to `.eval-env` for subsequent phases

Phase script template:

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$1"  # .eval-env (exports EVAL_DIR, BOTBUS_DATA_DIR, etc.)

PHASE="phaseN"
ARTIFACTS="$EVAL_DIR/artifacts"
mkdir -p "$ARTIFACTS"

# ... discover dynamic state ...
# ... build $PROMPT ...

echo "$PROMPT" > "$ARTIFACTS/$PHASE.prompt.md"
timeout 900 claude --model opus -p "$PROMPT" \
  --dangerously-skip-permissions --allow-dangerously-skip-permissions \
  > "$ARTIFACTS/$PHASE.stdout.log" 2> "$ARTIFACTS/$PHASE.stderr.log" \
  || echo "PHASE $PHASE exited with code $?"

# ... save new state to .eval-env ...
```

### State Discovery Between Phases

Some state is created dynamically and must be discovered by subsequent phases:

| State | Created in | Discovered by | Method |
|-------|-----------|---------------|--------|
| Workspace name/path | Phase 1 | Phase 4,5,6,7 | `maw ws list --format json` |
| Beta bug bead ID | Phase 2 | Phase 3 | `br ready` in beta dir |
| Review ID | Phase 4 | Phase 5,6,7,8 | `crit inbox` or grep crit output |
| Thread ID | Phase 5 | Phase 6 | `crit review $REVIEW_ID` → parse threads |

Phase scripts use tool output parsing (grep, jq) to extract IDs and inject them into prompts for subsequent phases.

## Design Decisions

### Phased execution (not live hooks)

Live hook firing (bus message → hook → botty spawn → agent runs) would be the ultimate test but creates problems:
- **Non-deterministic timing**: agents start asynchronously, hard to score individual phases
- **Observability**: can't easily pause between phases to inspect state
- **Debugging**: when something fails, unclear which agent caused it
- **Cost control**: can't choose model per agent if hooks spawn with fixed config

**Decision**: Use phased `claude -p` invocations for all agent turns. Verify hooks are correctly registered (Phase 4.5) but don't let them fire. This gives us full control, observability, and scoring while still testing that the hook setup is correct.

**Future**: A v2 could add a "live mode" flag that lets hooks fire and uses `botty tail` to observe agents organically.

### Cross-project communication style

The key design choice: alpha-dev **asks** beta-dev about the behavior rather than filing a bug and demanding a fix. This tests:
- Agent ability to communicate as a peer
- Bus-based discussion (not just bead filing)
- Domain expertise in responses
- Collaborative resolution

This is closer to how real multi-project teams work — you ask the maintainer before assuming something is a bug.

### Planted vulnerability in existing code (not agent-generated)

The /debug endpoint is in the codebase from setup, not introduced by the agent. This means:
- The vulnerability is deterministic (not dependent on agent mistakes)
- It tests whether reviewers look beyond the PR diff

**Important**: `crit reviews create` produces a diff-based review. The /debug endpoint is pre-existing code, so it won't appear in the diff unless the agent modifies that section. The Phase 5 prompt should instruct the reviewer to "review the full codebase accessible at the workspace path, not just the diff" to ensure the vulnerability is discoverable. The reviewer-security prompt template already encourages full-file review, but the eval prompt should reinforce this.

### Sonnet for beta-dev, Opus for alpha agents

Beta's tasks are simpler (investigate code, fix a bug, merge). Sonnet is sufficient and cheaper. Alpha's tasks require complex coordination (cross-project discovery, review handling, release protocol) — Opus is better suited.

## Estimated Cost and Runtime

| Phase | Model | Est. input tokens | Est. output tokens | Est. time |
|-------|-------|-------------------|--------------------|-----------|
| 1 | Opus | ~15k | ~5k | 5-8 min |
| 2 | Sonnet | ~8k | ~3k | 2-3 min |
| 3 | Sonnet | ~8k | ~3k | 3-5 min |
| 4 | Opus | ~12k | ~4k | 4-6 min |
| 5 | Opus | ~10k | ~4k | 3-5 min |
| 6 | Opus | ~10k | ~4k | 3-5 min |
| 7 | Opus | ~8k | ~3k | 2-4 min |
| 8 | Opus | ~8k | ~3k | 3-5 min |
| **Total** | | ~79k | ~29k | **25-41 min** |

Setup and verification scripts add ~2-3 min.

## v1 Scope Decisions

1. **`bv --robot-next` included, `bv --robot-triage` deferred.** Phase 1 uses `bv --robot-next` for triage. Full `--robot-triage` parsing/scoring deferred to v2.
2. **No beta-side crit review in v1.** Beta bugfix remains single-agent to keep runtime bounded. Dual-project review threads deferred to v2.
3. **`bus statuses` not scored.** Agents may set status messages but it's informational — not in the rubric.
4. **Version tag required.** Phase 8 includes `jj tag create v0.2.0 -r @-`.
5. **No `bus wait` in phased mode.** Alpha's session ends after Phase 1; beta responds in a separate invocation. `bus wait` belongs in a responder-focused eval.

### Deferred to v2

- Live hook-fired execution mode with `botty tail` observation.
- Beta reviewer loop and dual-project review threads.
- Full `bv --robot-triage` parsing and scoring.
- `bus generate-name` for random agent identities.

## Relationship to Existing Evals

| Existing Eval | What E10 Supersedes | What E10 Adds |
|--------------|---------------------|---------------|
| R4 (Integration) | Same review→block→fix→LGTM→merge flow | Cross-project, release, hook verification |
| R5 (Cross-Project) | Same #projects discovery | Peer communication (ask, don't just file), resolution |
| R1-R3 (Review) | Same review mechanics | Integrated with full lifecycle, not standalone |
| Agent Loop | Same triage→work→finish | Multi-project, review cycle, release |

E10 does NOT replace these evals — they remain valuable for targeted regression testing. E10 is the integration/system test that exercises everything together.
