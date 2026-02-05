# Proposal: Multi-Project Coordination Patterns

**Status**: PROPOSAL
**Bead**: bd-2jws
**Author**: botbox-dev
**Date**: 2026-02-05

## Summary

The current per-project agent model works well: each project has its own beads, workspaces, and channel, with cross-project communication via the #projects registry and report-issue.md workflow. This proposal examines whether additional coordination patterns are needed for shared libraries, upstream/downstream dependencies, and cross-repo refactoring. **Conclusion**: The current model is sufficient; gaps can be addressed through documentation and minor tooling enhancements rather than architectural changes.

## Motivation

As the botbox ecosystem grows, questions arise about multi-project coordination:

1. **Shared libraries**: If botbus adds a feature, do downstream projects (botbox, maw, crit) need coordinated updates?
2. **Upstream/downstream dependencies**: When a bug is found in a library, how do agents coordinate the fix and downstream consumption?
3. **Cross-repo refactoring**: Can agents perform coordinated changes across multiple repositories?

These questions matter because poor coordination leads to:
- Duplicate work (multiple agents discovering the same issue)
- Integration failures (downstream projects breaking on upstream changes)
- Context loss (agents not knowing why a change was made)

## Proposed Design

### Current Model Works Well

The per-project model already handles most coordination needs:

| Scenario | Current Solution | Status |
|----------|------------------|--------|
| Bug in external tool | report-issue.md: file bead in upstream, announce on their channel | Tested (R5 eval: 100%) |
| Feature request | Same as bug: create bead, announce with @mention | Works |
| Waiting for upstream fix | Mark own bead as blocked, monitor upstream channel | Works |
| Consuming new version | Update dependency, test, file bug if issues | Standard dev |

**Evidence**: The R5 eval demonstrates cross-project coordination working perfectly. An agent discovered an off-by-one bug in r5-utils, filed it in the correct project via #projects lookup, announced with -L feedback, and continued its own work with a correct implementation.

### Patterns to Document (Not Build)

Rather than building new infrastructure, document these patterns:

#### Pattern 1: Upstream Bug Discovery
```
1. Discover bug in library
2. Query #projects for upstream project
3. cd to upstream repo, create bead with repro steps
4. Announce on upstream channel with -L feedback and @lead
5. Return to own work, implement workaround if needed
6. Mark own bead as blocked if dependent on fix
```

#### Pattern 2: Consuming Upstream Changes
```
1. Monitor upstream channel (subscribe if high-traffic)
2. When relevant release announced:
   a. Update dependency version
   b. Run tests
   c. File bugs if breakage found (Pattern 1)
3. Unblock any beads that were waiting on the fix
```

#### Pattern 3: Coordinated Feature Work
```
When a feature requires changes in multiple projects:
1. Create epic bead in primary project
2. Create linked beads in each affected project
3. Wire dependencies: downstream beads blocked by upstream
4. Work upstream first, then downstream
5. Cross-reference bead IDs in descriptions
```

### Minor Tooling Enhancements (Optional)

These could help but are not required:

1. **Cross-project bead references**: Allow `br show <project>:<bead-id>` to show beads from other projects (requires knowing the repo path). Could be built on top of #projects registry.

2. **Dependency declarations**: A `.botbox.json` field listing upstream projects. Used for:
   - `botbox doctor` warnings about stale dependencies
   - Subscribing to upstream channels on init

3. **Release announcements**: Convention for version bump messages: `bus send <project> "Released v1.2.3: <changes>" -L release`. Downstream agents can filter for these.

### What NOT To Build

1. **Distributed beads**: Beads stay project-scoped. Cross-referencing uses text (bead IDs in descriptions).

2. **Global claims**: Claims are already global (botbus-wide). No change needed.

3. **Multi-repo workspaces**: Each agent works in one repo at a time. For multi-repo changes, work on them sequentially.

4. **Automated dependency updates**: Agents update dependencies manually when consuming new versions.

## Open Questions

1. **Is subscribing to upstream channels worth the noise?** If botbox subscribes to botbus, maw, crit, and botty channels, that's a lot of traffic. Maybe only subscribe to specific labels like `release` or `breaking-change`?

2. **How should agents handle breaking changes?** When an upstream project makes a breaking change, how do downstream agents discover and handle it? Current answer: they break, file a bug, and either pin the old version or adapt.

3. **Should there be a "botbox update-deps" command?** To check for new versions of companion tools and update them?

## Answered Questions

1. **Q:** Is the current model sufficient? **A:** Yes. The R5 eval proves cross-project coordination works with report-issue.md. Agents can file bugs, wait for fixes, and continue work. No new infrastructure needed.

2. **Q:** How do agents discover related projects? **A:** Via the #projects channel registry. Each project registers on init with repo path, lead agent, and tools. Query with `bus history projects --format text | grep <toolname>`.

3. **Q:** How to handle conflicting changes across repos? **A:** Work sequentially. Upstream first, downstream second. If concurrent work creates conflicts, the downstream agent files a bug in upstream (or just adapts).

4. **Q:** Do we need cross-project claims? **A:** No. Claims are already global (botbus-wide namespace). A claim on `bead://botbus/bd-xxx` is visible to all agents in the botbus data directory.

## Alternatives Considered

### Alternative 1: Shared Beads Database

One central beads database for all projects. Rejected because:
- Breaks project isolation
- Complicates permissions and ownership
- Makes per-project workflows harder
- Current cross-referencing by text works fine

### Alternative 2: Federated Issue Tracking

Beads could reference beads in other databases with special syntax. Rejected because:
- Adds significant complexity
- Current pattern (mention bead ID in description) is simple and works
- Not worth the implementation cost for marginal benefit

### Alternative 3: Orchestrator Agent

A meta-agent that coordinates work across projects. Rejected because:
- Adds a single point of failure
- Current model of peer agents with async communication is simpler
- Would require complex arbitration logic

## Implementation Plan

**Recommendation: No new infrastructure needed.**

The following documentation and minor improvements are sufficient:

1. **Document coordination patterns** (2 hours)
   - Add "Cross-Project Patterns" section to worker-loop.md or create dedicated doc
   - Cover: upstream bug filing, consuming changes, coordinated features

2. **Add release announcement convention** (30 min)
   - Document the `-L release` label convention
   - Update finish.md to suggest announcing releases

3. **Optional: dependency declarations** (low priority)
   - Add `upstreamProjects` field to `.botbox.json`
   - Use in `botbox doctor` to warn about stale versions
   - Future: auto-subscribe to release labels

If this proposal is accepted, the implementation work is purely documentation updates, not code changes.
