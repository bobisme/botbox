# Proposal: E10v2 — Friction-Aware Full Lifecycle Eval

**Status**: PROPOSAL
**Author**: botbox-dev
**Date**: 2026-02-07
**Bead**: bd-3n4l

## Summary

Extend E10 with automated friction scoring as a first-class metric. The current E10 rubric (160 pts) measures workflow compliance — did the agent follow the protocol and reach the right outcome? E10v2 adds a friction dimension (40 pts) that measures efficiency — how many wasted tool calls did it take to get there?

Also fixes 3 verify script false positives identified in E10-2.

## Motivation

E10-1 scored 158/160 (99%) and E10-2 scored 159/160 (99%). These scores suggest the toolchain is working near-perfectly. But E10-2's post-hoc friction analysis revealed **~61 wasted tool calls** across phases 4-8:

| Category | Occurrences | Wasted Calls | Phases |
|----------|------------|-------------|--------|
| crit `--path` missing | 5 | ~34 | 4, 5, 6, 7, 8 |
| crit stale workspace | 1 | ~18 | 5 |
| jj divergent commit | 1 | ~4 | 6 |
| jj tag create vs set | 1 | ~3 | 8 |
| crit --title missing | 1 | ~2 | 4 |

The workflow compliance score is blind to this friction. An agent that nails every command on the first try and one that retries 20 times both score the same. We need a metric that distinguishes them, because:

1. **Friction = cost**: Each wasted call is ~$0.05-0.50 in API cost and ~5-30s of wall time.
2. **Friction = tool UX signal**: High friction on a specific tool command means the tool needs better error messages, auto-discovery, or doc improvements. This is the primary feedback loop for improving the companion tools.
3. **Friction tracks improvement**: When we fix crit's `--path` discovery (bd-358v/bd-1bs), the friction score should improve measurably. Workflow compliance won't change.

## Design

### What stays the same

Everything from E10:
- 2-project (Alpha + Beta), 3-agent, 8-phase architecture
- Same planted defects (beta validate_email `+`, alpha `/debug`)
- Same sequential `claude -p` invocations via `botbox run-agent`
- Same setup script (`evals/scripts/e10-setup.sh`)
- Same phase scripts (minor updates if needed for new crit version)
- Same workflow compliance rubric (160 pts, 10 categories)
- Same critical fail conditions

### What changes

#### 1. Friction score (40 pts, new)

Automated extraction from phase stdout logs. The score starts at 40 and deducts for friction events:

| Event | Deduction | Detection |
|-------|-----------|-----------|
| Tool command failure (`Exit code 1`/`Exit code 2`) | -2 per | Grep for `Exit code [12]` in tool call results |
| Sibling cancellation (`Sibling tool call errored`) | -1 per | Grep for `Sibling tool call errored` |
| Help lookup (`--help`) | -1 per | Grep for `--help` in Bash tool calls (excluding setup) |
| FALLBACK recovery in orchestrator | -2 per | Grep for `FALLBACK:` in phase output |
| Divergent commit resolution (`divergent`) | -3 per | Grep for `(divergent)` in jj output |

Floor at 0 (no negative scores). Rationale for weights:
- Tool failures (-2) are the agent's primary mistake — wrong flags, wrong path
- Sibling cancellations (-1) are collateral damage, not the agent's direct fault
- Help lookups (-1) show the agent doesn't know the CLI, but at least it's self-correcting
- FALLBACK (-2) means the orchestrator had to work around a tool bug
- Divergent commits (-3) are serious — they require manual jj surgery

#### 2. Friction extraction script (new file)

`evals/scripts/e10-friction.sh` — takes `$EVAL_DIR` as argument, parses all phase stdout logs, outputs:

```
=== E10 Friction Analysis ===

Phase 1: 0 failures, 0 siblings, 0 help lookups = 0 friction events
Phase 2: 0 failures, 0 siblings, 0 help lookups = 0 friction events
Phase 3: 0 failures, 0 siblings, 0 help lookups = 0 friction events
Phase 4: 2 failures, 1 sibling, 0 help lookups = 3 friction events
Phase 5: 2 failures, 12 siblings, 2 help lookups = 16 friction events
Phase 6: 4 failures, 4 siblings, 0 help lookups = 8 friction events
Phase 7: 1 failure, 0 siblings, 0 help lookups = 1 friction event
Phase 8: 2 failures, 0 siblings, 1 help lookup = 3 friction events

Total: 11 failures, 17 siblings, 3 help lookups, 0 FALLBACKs, 0 divergent
Raw friction score: 40 - (11×2 + 17×1 + 3×1 + 0×2 + 0×3) = 40 - 42 = 0/40

Worst phases: Phase 5 (16 events), Phase 6 (8 events)
Dominant issue: crit --path (phases 4-8)
```

This runs automatically at the end of `e10-run.sh` alongside verify.

#### 3. Verify script fixes (3 false positives)

**Fix A: api_secret check** (`e10-verify.sh`)

Current (too loose):
```bash
if grep -A5 'async fn' src/main.rs | grep -q 'api_secret'; then FAIL
```

Fixed (checks for api_secret in JSON response or route handler return):
```bash
# Check if any route handler serializes api_secret into a response
if grep -E '(Json|json!|serde_json).*api_secret|api_secret.*(Json|json!|into_response)' src/main.rs; then FAIL
# Also check for /debug route registration
if grep -q '/debug' src/main.rs; then FAIL
```

**Fix B: Review exists check**

Add FALLBACK grep when `crit reviews list --all-workspaces` fails:
```bash
if [[ -z "$REVIEW_STATUS" ]]; then
  # Fallback: check if phase8 stdout shows mark-merged
  if grep -q 'status: merged' "$ARTIFACTS/phase8.stdout.log" 2>/dev/null; then
    REVIEW_STATUS="merged (from stdout log)"
  fi
fi
```

**Fix C: Review marked as merged check**

Same pattern — grep phase8 stdout for the mark-merged confirmation.

#### 4. Updated rubric (200 pts)

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
| **Friction Efficiency** | **40** |
| **Total** | **200** |

Thresholds:
- Pass: >= 140/200 (70%)
- Excellent: >= 180/200 (90%)

#### 5. Updated report template

Add a "Friction Analysis" section to the report template in `notes/eval-framework.md`:

```markdown
## Friction Analysis

| Phase | Failures | Siblings | Help | FALLBACK | Divergent | Events |
|-------|----------|----------|------|----------|-----------|--------|
| 1 | | | | | | |
| ... | | | | | | |
| Total | | | | | | |

Friction score: X/40
Dominant issue: ...
```

### Retroactive E10-2 friction score

Applying the proposed weights to E10-2 data:

- 11 tool failures × 2 = 22
- 17 sibling cancellations × 1 = 17
- 3 help lookups × 1 = 3
- 1 FALLBACK × 2 = 2
- 1 divergent × 3 = 3

Total deductions: 47. Score: max(0, 40 - 47) = **0/40**.

E10-2 retroactive total: 159 + 0 = **159/200 (80%)** — still passes (>= 140) but no longer "excellent."

This correctly reflects reality: the agents followed the protocol near-perfectly but the tool UX caused massive waste. When crit's `--path` discovery is fixed (bd-358v/bd-1bs), the friction score should jump to ~35-40/40.

## Open Questions

1. **Should friction deductions be capped per phase?** E.g., max -10 per phase, so a single bad phase doesn't zero out the entire friction score. This would make E10-2's retroactive score ~15/40 instead of 0/40.
2. **Should we distinguish "agent error" from "tool UX error"?** An agent calling `crit comment` without `--path` is arguably a tool UX failure (crit should auto-discover), not an agent competence failure. But it's hard to automate this distinction.
3. **Should the friction script also count wasted time?** We have timestamps in the logs. Could compute "time spent on failed commands" as a secondary metric.

## Answered Questions

1. **Do we need new phase scripts?** No. Same scripts, same prompts. Only changes: friction extraction, verify fixes, rubric update.
2. **Does this require new crit features?** No. Friction scoring works on existing logs. When crit improves (bd-358v/bd-1bs), the friction score improves automatically.
3. **Is 40 pts the right weight?** It's 20% of the total. Enough to affect the pass/excellent threshold but not enough to fail an agent that follows the protocol correctly. The goal is visibility, not punishment.

## Implementation Plan

1. Write `evals/scripts/e10-friction.sh`
2. Fix `evals/scripts/e10-verify.sh` (3 false positives)
3. Update `evals/rubrics.md` with friction section
4. Update `notes/eval-framework.md` report template
5. Integrate friction script into `evals/scripts/e10-run.sh`
6. Run E10v2 and score with both dimensions
7. Write report with friction analysis section
