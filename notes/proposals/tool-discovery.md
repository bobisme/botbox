# Proposal: Explicit Tool Discovery in AGENTS.md

**Status**: PROPOSAL
**Bead**: bd-3jh
**Author**: botbox-dev
**Date**: 2026-02-05

## Summary

Agents currently struggle to know what tools are available without relying on MCP context injection or reading multiple workflow docs. This proposal expands the managed section of AGENTS.md with comprehensive tool documentation: expanded quick reference tables covering all ecosystem tools, a "when to use what" decision tree for common scenarios, and categorized example invocations. The goal is to make AGENTS.md a complete, self-contained reference so agents always know what tools exist and how to use them.

## Motivation

**Pain points:**

1. **Incomplete quick reference tables** - The current managed section only covers `br` (beads) and `maw` (workspaces). Missing: `bus` (messaging/claims), `crit` (code review), `jj` (version control), `botty` (agent runtime), `bv` (bead viewer), and `cass` (session search).

2. **Scattered documentation** - Tool usage is spread across 15+ workflow docs. Agents must read multiple files to understand the complete toolset. Example: claims are in the managed section but `bus inbox` is only in workflow docs.

3. **No decision guidance** - Agents don't know which tool to use for a given situation. Should I use `br ready` or `bv --robot-next`? When do I need `crit` vs just merging? When should I `bus send` vs create a bead?

4. **MCP dependency** - Current workaround is injecting tool context via MCP, but this adds overhead, requires runtime setup, and isn't available in all contexts.

**Why this matters:**

- New agents waste tokens exploring docs to find the right tool
- Crash recovery is harder without knowing the full command set
- Tool adoption suffers when agents don't know capabilities exist
- Cross-project communication patterns are non-obvious

## Proposed Design

### 1. Expand Quick Reference Tables

Add tables for all ecosystem tools in the managed section. Each table covers the most common operations for that tool.

**Bus Quick Reference (NEW)**

| Operation | Command |
|-----------|---------|
| Check inbox | `bus inbox --agent $AGENT --channels $BOTBOX_PROJECT --mark-read` |
| Send message | `bus send --agent $AGENT <channel> "<message>" -L <label>` |
| Wait for message | `bus wait --agent $AGENT -L <label> -t <seconds>` |
| Stake claim | `bus claims stake --agent $AGENT "<uri>" -m "<memo>"` |
| Check claim | `bus claims check --agent $AGENT "<uri>"` |
| List my claims | `bus claims list --agent $AGENT --mine` |
| Release all claims | `bus claims release --agent $AGENT --all` |
| Get identity | `bus whoami --agent $AGENT` |
| Find projects | `bus history projects -n 50` |

**Crit Quick Reference (NEW)**

| Operation | Command |
|-----------|---------|
| Create review | `crit reviews create --agent $AGENT --path $WS_PATH --title "..." --description "..."` |
| View review | `crit review <id> --path $WS_PATH` |
| View diff | `crit diff <id> --path $WS_PATH` |
| Check inbox | `crit inbox --agent $AGENT --all-workspaces` |
| Approve (LGTM) | `crit lgtm <id> --path $WS_PATH` |
| Block review | `crit block <id> --path $WS_PATH --reason "..."` |
| Add comment | `crit comment <id> --path $WS_PATH "..." --file <path> --line <n>` |
| Reply to thread | `crit reply <thread-id> --agent $AGENT --path $WS_PATH "..."` |
| Request reviewer | `crit reviews request <id> --reviewers <agent> --agent $AGENT --path $WS_PATH` |
| Mark merged | `crit reviews mark-merged <id> --agent $AGENT --path $WS_PATH` |

**JJ Quick Reference (NEW)**

| Operation | Command |
|-----------|---------|
| Describe change | `jj describe -m "..."` (or `maw ws jj $WS describe -m "..."`) |
| View log | `jj log` |
| View status | `jj status` |
| Create new change | `jj new` |
| Set bookmark | `jj bookmark set main -r @` |
| Push to remote | `jj git push` |
| Restore from main | `jj restore --from main <path>` |
| Abandon change | `jj abandon <change-id>` |

**Botty Quick Reference (NEW)** - only if `botty` is in tools

| Operation | Command |
|-----------|---------|
| Spawn agent | `botty spawn --name <name> -- <command>` |
| List agents | `botty list` |
| Send to agent | `botty send <name> "<message>"` |
| Kill agent | `botty kill <name>` |

**Additional Beads Commands** - expand existing table

| Operation | Command |
|-----------|---------|
| List by status | `br list --status <status> --assignee $AGENT --json` |
| View dep tree | `br dep tree <id>` |
| Add label | `br label add --actor $AGENT -l <label> <id>` |
| Get next task | `bv --robot-next` |

### 2. Add Decision Tree Section

New section in managed content: "When to Use What"

```markdown
### When to Use What

**Finding work:**
- `br ready` - See all unblocked beads (human-readable)
- `bv --robot-next` - Get exactly one recommended bead (machine-readable JSON)
- `bus inbox --agent $AGENT` - Check for messages/requests from other agents

**Coordinating with others:**
- `bus send` - Announce status, ask questions, request help
- `bus claims stake` - Prevent conflicts on resources
- `crit reviews create` - Request code review from another agent/human

**Tracking work:**
- `br create` - New task, bug, or feature
- `br update` - Change status, priority, title, description
- `br comments add` - Progress updates, context for crash recovery

**Managing changes:**
- `maw ws create` - Isolated workspace for a task
- `maw ws merge --destroy` - Complete work and clean up
- `jj describe` - Set commit message
- `crit` - When changes need review before merge

**Debugging/Search:**
- `cass search "..."` - Find similar past problems
- `bus history <channel>` - See recent channel activity
- `br comments <id>` - Understand what happened on a bead
```

### 3. Add Common Patterns Section

New section with copy-paste-ready command sequences for frequent scenarios.

```markdown
### Common Patterns

**Start working on a bead:**
```bash
br update --actor $AGENT <id> --status=in_progress
bus claims stake --agent $AGENT "bead://$BOTBOX_PROJECT/<id>" -m "<id>"
maw ws create --random  # Note $WS and $WS_PATH from output
bus claims stake --agent $AGENT "workspace://$BOTBOX_PROJECT/$WS" -m "<id>"
bus send --agent $AGENT $BOTBOX_PROJECT "Working on <id>: <title>" -L task-claim
```

**Complete and merge work:**
```bash
br comments add --actor $AGENT --author $AGENT <id> "Completed by $AGENT"
br close --actor $AGENT <id> --reason="Completed"
maw ws merge $WS --destroy
bus claims release --agent $AGENT --all
br sync --flush-only
bus send --agent $AGENT $BOTBOX_PROJECT "Completed <id>: <title>" -L task-done
```

**Request a review (with spawn):**
```bash
crit reviews create --agent $AGENT --path $WS_PATH --title "<title>" --description "For <id>: <summary>"
crit reviews request <review-id> --reviewers $BOTBOX_PROJECT-<role> --agent $AGENT --path $WS_PATH
bus send --agent $AGENT $BOTBOX_PROJECT "Review requested: <review-id> @$BOTBOX_PROJECT-<role>" -L review-request
```

**Report a bug to another project:**
```bash
cd <other-project-path>
br create --actor $AGENT --title="..." --description="..." --type=bug --priority=2
bus send --agent $AGENT <project> "Filed <id>: <summary> @<lead>" -L feedback
```
```

### 4. Implementation in templates.mjs

The managed section renderer (`renderManagedSection`) will be updated to:

1. **Accept tools config** - Know which tools are enabled for conditional sections
2. **Render expanded tables** - All tool tables, not just beads/maw
3. **Include decision tree** - Static content, always present
4. **Include common patterns** - Copy-paste sequences

Structure changes to `templates.mjs`:

```javascript
function renderManagedSection(config = {}) {
  let tools = config.tools ?? []

  let sections = [
    renderIntro(),
    renderBeadsQuickRef(),           // Expanded
    renderWorkspaceQuickRef(),       // Existing
    renderBusQuickRef(),             // NEW
    renderCritQuickRef(),            // NEW (if 'crit' in tools)
    renderJjQuickRef(),              // NEW
    renderBottyQuickRef(tools),      // NEW (if 'botty' in tools)
    renderDecisionTree(),            // NEW
    renderCommonPatterns(),          // NEW
    renderIdentitySection(),         // Existing
    renderClaimsSection(),           // Existing
    renderReviewsSection(),          // Existing
    renderCrossProjectSection(),     // Existing
    renderDesignDocs(config),        // Existing
    renderWorkflowDocs()             // Existing
  ]

  return sections.filter(Boolean).join('\n\n')
}
```

### 5. Size Considerations

The expanded managed section will be larger. Mitigations:

- **Group by frequency** - Most-used commands first
- **Collapse optional tools** - Only show botty section if enabled
- **Keep tables scannable** - No prose in tables, just command + description
- **Link to details** - Decision tree points to workflow docs for full context

Estimated size increase: ~150-200 lines. This is acceptable because:
- AGENTS.md is read at conversation start (one-time cost)
- Replaces need to read multiple workflow docs
- Net token savings over a session

## Open Questions

1. **Should the decision tree be hierarchical or flat?** A nested tree (if-then-else style) is more precise but harder to scan. A flat list with categories is easier to scan but may miss edge cases.

2. **Should we include "anti-patterns" or "don't do this" guidance?** Example: "Don't use `jj describe main -m` (causes divergent commits)". Pro: prevents common mistakes. Con: adds length and negative framing.

3. **How should we handle tool-specific sections for disabled tools?** Options:
   - Always include all tools (simpler, but shows commands that won't work)
   - Conditional rendering (accurate, but more complex templates)
   - Note at top "Tools enabled: X, Y, Z" (compromise)

4. **Should common patterns be in the managed section or a separate workflow doc?** Managed section means always visible; separate doc keeps managed section focused on reference.

## Answered Questions

*None yet - move items here as they're resolved.*

## Alternatives Considered

### A. MCP Tool Registry

Provide tool documentation via MCP resources that can be queried on demand.

**Rejected because:**
- Requires MCP setup in every environment
- Not available in all agent contexts (e.g., pure Claude Code)
- Adds latency for each tool lookup
- Doesn't help with "what tools exist" discovery

### B. Separate TOOLS.md File

Create a dedicated tools reference file alongside AGENTS.md.

**Rejected because:**
- Agents would need to read two files
- Risk of content drift between AGENTS.md and TOOLS.md
- Managed section is already the "botbox content" area

### C. CLI `--help` Only

Rely on `<tool> --help` for discovery.

**Rejected because:**
- Requires knowing the tool exists first
- Can't answer "what tool should I use for X?"
- Doesn't show ecosystem patterns (claims + bus + beads together)

### D. Minimal Expansion (Just Bus and Crit Tables)

Only add the most critical missing tables, skip decision tree and patterns.

**Considered but deferred:**
- Could be a Phase 1 if full proposal is too large
- Decision tree and patterns provide high value for discoverability

## Implementation Plan

These would become child beads if the proposal is accepted:

1. **Add bus quick reference table** - `renderBusQuickRef()` function, include in managed section
2. **Add crit quick reference table** - `renderCritQuickRef()` function, conditional on 'crit' tool
3. **Add jj quick reference table** - `renderJjQuickRef()` function
4. **Expand beads table** - Add `br list`, `br dep tree`, `br label`, `bv`
5. **Add botty quick reference** - `renderBottyQuickRef()` function, conditional on 'botty' tool
6. **Add decision tree section** - `renderDecisionTree()` function
7. **Add common patterns section** - `renderCommonPatterns()` function
8. **Pass tools config to renderManagedSection** - Update call sites
9. **Update tests** - Ensure managed section tests cover new content
10. **Sync existing botbox projects** - Run `botbox sync` to update AGENTS.md
