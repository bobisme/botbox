# Proposal: Surface Past Learnings During Triage

**Status**: PROPOSAL
**Bead**: bd-6gm
**Author**: botbox-dev
**Date**: 2026-02-05

## Summary

When agents triage beads, they often encounter problems they (or other agents) have solved before. Currently, this institutional knowledge is locked in 64K+ indexed session messages, inaccessible during the critical moment of work selection. This proposal adds a lightweight cass integration to triage that surfaces relevant past sessions without requiring full cm (playbook) integration. The agent sees "Similar problems solved in sessions X, Y" with one-line summaries, helping them estimate effort and avoid known pitfalls.

## Motivation

**The problem**: Agents repeatedly solve similar problems without learning from past attempts. An agent picking up "fix jj divergent commits in maw" doesn't know that another agent already documented the exact solution (`jj abandon <change-id>/0`) in a previous session.

**Why triage?**: This is the decision point where learnings are most valuable. Knowing that a problem was solved before (and how long it took, what approach worked) directly informs:
- Whether to claim a bead (already solved? just apply the fix)
- Effort estimation (took 2 hours last time vs. quick fix)
- Approach selection (avoid paths that failed before)

**Why not full cm?**: The cm playbook layer requires manual rule curation, effectiveness tracking setup, and ongoing maintenance. cass search is zero-config after initial indexing - just search and get results. This proposal extracts 80% of the value with 20% of the complexity.

## Proposed Design

### Integration Point

Enhance `triage.mjs` to optionally query cass after displaying bead recommendations. The flow becomes:

```
1. Run bv --robot-triage (existing)
2. Display summary, picks, recommendations (existing)
3. NEW: For top 3-5 picks, search cass for relevant sessions
4. Display compact learnings section (if any hits)
```

### Relevance Criteria

A session is "relevant" when cass returns a score >= 40 (based on testing in notes/cass.md where useful results scored 45-55). The search query combines:

1. **Bead title** (primary) - e.g., "fix jj divergent commits"
2. **Bead type + labels** (boost) - e.g., "bug maw jj"
3. **Description keywords** (secondary) - first 50 chars if title is generic

Example query construction:
```javascript
let query = `${bead.title} ${bead.type} ${bead.labels?.join(' ') || ''}`
```

### Presentation

Learnings appear in a dedicated section, limited to prevent context bloat:

```
▸ Past Learnings
   bd-abc (fix jj divergent): 2 relevant sessions
      → Session 2026-01-15: Solution: jj abandon <change-id>/0
      → Session 2026-01-12: Root cause: concurrent edits to same commit
   bd-def (add cass to doctor): 1 relevant session
      → Session 2026-02-01: Tested cass health check, took ~30min

   → Expand: cass search "fix jj divergent" --robot --limit 10
```

**Format constraints**:
- Max 3 beads with learnings shown
- Max 2 sessions per bead
- One-line summary per session (extracted from first matching message)
- Include expand command for agents who want more

### Automatic vs On-Demand

**Recommendation: Automatic with opt-out**

Rationale:
- Learnings are most valuable when agents don't know to look for them
- The overhead is small (3-5 cass searches, ~100ms each)
- Opt-out via `--no-learnings` flag for agents who want minimal output

The cost is ~500ms added latency and 5-10 extra lines of output. This is acceptable for triage (not a hot path).

### Fallback Behavior

If cass is not installed or index is empty:
- Skip learnings section silently
- No error, no warning (don't nag about optional tools)

Detection:
```javascript
let cassAvailable = await commandExists('cass') && await cassHasIndex()
```

## Open Questions

1. **What message to extract for the one-liner?** Options:
   - First message in the matching turn
   - Message with highest score
   - Attempt to extract a "solution" message (heuristic: contains "fixed", "solved", "the issue was")

2. **Should we cache results?** Triage often runs multiple times per session. Cache cass results for 5 minutes to avoid repeated searches?

3. **Project filtering?** Should we filter cass results to current project only, or show cross-project learnings? Cross-project might surface more hits but less relevant.

4. **Score threshold tuning**: 40 is based on limited testing. Need more data on what scores produce useful vs. noisy results.

## Answered Questions

**Q: Why not use cm context instead of raw cass search?**
A: cm context returns structured rules, not session history. We want "what happened" not "what rule was extracted." Also, cm requires more setup (playbook initialization, categories).

**Q: Should this be a separate script or triage enhancement?**
A: Enhancement to triage.mjs. A separate script would require agents to remember to run it. Inline makes it automatic.

**Q: What if there are many hits?**
A: Hard limit of 3 beads x 2 sessions = 6 lines max. More aggressive filtering is better than information overload.

## Alternatives Considered

### Alternative 1: Full cm Integration

Use `cm context "bead title"` to get both rules and session history.

**Rejected because**:
- Requires cm to be installed and initialized (more setup)
- Returns structured rules that need formatting
- Overkill for triage use case

### Alternative 2: Separate `learnings.mjs` Script

Create a standalone script agents run before claiming work.

**Rejected because**:
- Agents must remember to run it
- Adds a step to the workflow
- Triage is the natural integration point

### Alternative 3: Show Learnings for All Beads

Query cass for every bead in the recommendations list.

**Rejected because**:
- Too slow (could be 20+ beads)
- Too much output
- Top picks are what matter

### Alternative 4: Interactive Expansion

Show a hint like "Run `triage.mjs --expand bd-abc` for past learnings"

**Rejected because**:
- Extra step reduces discoverability
- Agents won't use what they have to ask for
- Automatic is better for institutional knowledge

## Implementation Plan

### Phase 1: Core Integration (1 bead)

1. Add cass detection to triage.mjs (check if installed, has index)
2. Implement query builder from bead metadata
3. Add `searchPastLearnings(beads)` function
4. Display learnings section with hard limits
5. Add `--no-learnings` opt-out flag

### Phase 2: Polish (1 bead)

1. Tune score threshold based on testing
2. Improve one-liner extraction (solution detection heuristic)
3. Add timing metrics (ensure <1s total)
4. Consider caching if latency is a problem

### Phase 3: Documentation (0.5 bead)

1. Update triage.md workflow doc
2. Add cass to optional tools in botbox doctor
3. Document in CLAUDE.md/AGENTS.md

### Estimated Effort

- Phase 1: 2-3 hours (single session)
- Phase 2: 1-2 hours
- Phase 3: 30 minutes

Total: Half a day of focused work.
