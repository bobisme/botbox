import { listWorkflowDocs } from "./docs.mjs"
import { listEligibleDesignDocs } from "./design-docs.mjs"

const MANAGED_START = "<!-- botbox:managed-start -->"
const MANAGED_END = "<!-- botbox:managed-end -->"

/**
 * @typedef {object} ProjectConfig
 * @property {string} name
 * @property {string} type
 * @property {string[]} tools
 * @property {string[]} reviewers
 * @property {string} [installCommand] - Command to install locally after release (e.g., "just install")
 */

/**
 * Render a full AGENTS.md for a new project.
 * @param {ProjectConfig} config
 * @returns {string}
 */
export function renderAgentsMd(config) {
  const toolList = config.tools.map((t) => `\`${t}\``).join(", ")
  const reviewerLine =
    config.reviewers.length > 0
      ? `\nReviewer roles: ${config.reviewers.join(", ")}`
      : ""

  let projectTypes = Array.isArray(config.type) ? config.type : [config.type]

  return `# ${config.name}

Project type: ${config.type}
Tools: ${toolList}${reviewerLine}

<!-- Add project-specific context below: architecture, conventions, key files, etc. -->

${MANAGED_START}
${renderManagedSection({ installCommand: config.installCommand, projectTypes })}
${MANAGED_END}
`
}

/** @type {Record<string, string>} */
const DOC_DESCRIPTIONS = {
  "triage.md": "Find work from inbox and beads",
  "start.md": "Claim bead, create workspace, announce",
  "update.md": "Change bead status (open/in_progress/blocked/done)",
  "finish.md": "Close bead, merge workspace, release claims, sync",
  "worker-loop.md": "Full triage-work-finish lifecycle",
  "planning.md": "Turn specs/PRDs into actionable beads",
  "scout.md": "Explore unfamiliar code before planning",
  "proposal.md": "Create and validate proposals before implementation",
  "review-request.md": "Request a review",
  "review-response.md": "Handle reviewer feedback (fix/address/defer)",
  "review-loop.md": "Reviewer agent loop",
  "merge-check.md": "Verify approval before merge",
  "preflight.md": "Validate toolchain health",
  "cross-channel.md": "Ask questions, report bugs, and track responses across projects",
  "report-issue.md": "Report bugs/features to other projects",
  "coordination.md": "Mission coordination labels and sibling awareness",
  "mission.md": "End-to-end mission lifecycle guide",
}

/** @type {Record<string, string>} */
const DESIGN_DOC_DESCRIPTIONS = {
  "cli-conventions.md": "CLI tool design for humans, agents, and machines",
}

/**
 * @typedef {object} ManagedSectionConfig
 * @property {string} [installCommand] - Command to install locally after release
 * @property {string[]} [projectTypes] - Project types (for design doc indexing)
 */

/**
 * Render the managed section content.
 * @param {ManagedSectionConfig} [config]
 * @returns {string}
 */
function renderManagedSection(config = {}) {
  let lifecycleLinks = listWorkflowDocs()
    .sort()
    .map((doc) => {
      let desc = DOC_DESCRIPTIONS[doc] ?? doc.replace(".md", "")
      return `- [${desc}](.agents/botbox/${doc})`
    })
    .join("\n")

  // Collect eligible design docs across all project types
  let designDocs = new Set()
  for (let projectType of config.projectTypes ?? []) {
    for (let doc of listEligibleDesignDocs(projectType)) {
      designDocs.add(doc)
    }
  }

  let designDocsSection = ""
  if (designDocs.size > 0) {
    let designDocLinks = [...designDocs]
      .sort()
      .map((doc) => {
        let desc = DESIGN_DOC_DESCRIPTIONS[doc] ?? doc.replace(".md", "")
        return `- [${desc}](.agents/botbox/design/${doc})`
      })
      .join("\n")
    designDocsSection = `
### Design Guidelines

${designDocLinks}

`
  }

  return `## Botbox Workflow

**New here?** Read [worker-loop.md](.agents/botbox/worker-loop.md) first — it covers the complete triage → start → work → finish cycle.

**All tools have \`--help\`** with usage examples. When unsure, run \`<tool> --help\` or \`<tool> <command> --help\`.

### IMPORTANT: Always Track Work in Beads

**Every non-trivial change MUST have a bead**, no matter how it originates:
- **User asks you to do something** → create a bead before starting
- **You propose a change** → create a bead before starting
- **Mid-conversation pivot to implementation** → create a bead before coding

The only exceptions are truly microscopic changes (typo fixes, single-line tweaks) or when you are already iterating on an existing bead's implementation.

Without a bead, work cannot be recovered from crashes, handed off to other agents, or tracked for review. When in doubt, create the bead — it takes seconds and prevents lost work.

### Directory Structure (maw v2)

This project uses a **bare repo** layout. Source files live in workspaces under \`ws/\`, not at the project root.

\`\`\`
project-root/          ← bare repo (no source files here)
├── ws/
│   ├── default/       ← main working copy (AGENTS.md, .beads/, src/, etc.)
│   ├── frost-castle/  ← agent workspace (isolated jj commit)
│   └── amber-reef/    ← another agent workspace
├── .jj/               ← jj repo data
├── .git/              ← git data (core.bare=true)
├── AGENTS.md          ← stub redirecting to ws/default/AGENTS.md
└── CLAUDE.md          ← symlink → AGENTS.md
\`\`\`

**Key rules:**
- \`ws/default/\` is the main workspace — beads, config, and project files live here
- **Never merge or destroy the default workspace.** It is where other branches merge INTO, not something you merge.
- Agent workspaces (\`ws/<name>/\`) are isolated jj commits for concurrent work
- **ALL commands must go through \`maw exec\`** — this includes \`br\`, \`bv\`, \`crit\`, \`jj\`, \`cargo\`, \`bun\`, and any project tool. Never run them directly from the bare repo root.
- Use \`maw exec default -- <command>\` for beads (\`br\`, \`bv\`) and general project commands
- Use \`maw exec <agent-ws> -- <command>\` for workspace-scoped commands (\`crit\`, \`jj describe\`, \`cargo check\`)
- **crit commands must run in the review's workspace**, not default: \`maw exec <ws> -- crit ...\`

### Beads Quick Reference

| Operation | Command |
|-----------|---------|
| View ready work | \`maw exec default -- br ready\` |
| Show bead | \`maw exec default -- br show <id>\` |
| Create | \`maw exec default -- br create --actor $AGENT --owner $AGENT --title="..." --type=task --priority=2\` |
| Start work | \`maw exec default -- br update --actor $AGENT <id> --status=in_progress --owner=$AGENT\` |
| Add comment | \`maw exec default -- br comments add --actor $AGENT --author $AGENT <id> "message"\` |
| Close | \`maw exec default -- br close --actor $AGENT <id>\` |
| Add dependency | \`maw exec default -- br dep add --actor $AGENT <blocked> <blocker>\` |
| Sync | \`maw exec default -- br sync --flush-only\` |
| Triage (scores) | \`maw exec default -- bv --robot-triage\` |
| Next bead | \`maw exec default -- bv --robot-next\` |

**Required flags**: \`--actor $AGENT\` on mutations, \`--author $AGENT\` on comments.

### Workspace Quick Reference

| Operation | Command |
|-----------|---------|
| Create workspace | \`maw ws create <name>\` |
| List workspaces | \`maw ws list\` |
| Merge to main | \`maw ws merge <name> --destroy\` |
| Destroy (no merge) | \`maw ws destroy <name>\` |
| Run jj in workspace | \`maw exec <name> -- jj <jj-args...>\` |

**Avoiding divergent commits**: Each workspace owns ONE commit. Only modify your own.

| Safe | Dangerous |
|------|-----------|
| \`maw ws merge <agent-ws> --destroy\` | \`maw ws merge default --destroy\` (NEVER) |
| \`jj describe\` (your working copy) | \`jj describe main -m "..."\` |
| \`maw exec <your-ws> -- jj describe -m "..."\` | \`jj describe <other-change-id>\` |

If you see \`(divergent)\` in \`jj log\`:
\`\`\`bash
jj abandon <change-id>/0   # keep one, abandon the divergent copy
\`\`\`

**Working copy snapshots**: jj auto-snapshots your working copy before most operations (\`jj new\`, \`jj rebase\`, etc.). Edits go into the **current** commit automatically. To put changes in a **new** commit, run \`jj new\` first, then edit files.

**Always pass \`-m\`**: Commands like \`jj commit\`, \`jj squash\`, and \`jj describe\` open an editor by default. Agents cannot interact with editors, so always pass \`-m "message"\` explicitly.

### Beads Conventions

- Create a bead before starting work. Update status: \`open\` → \`in_progress\` → \`closed\`.
- Post progress comments during work for crash recovery.
- **Push to main** after completing beads (see [finish.md](.agents/botbox/finish.md)).
- **Update CHANGELOG.md** when releasing: add a summary of user-facing changes under the new version heading before tagging.${config.installCommand ? `\n- **Install locally** after releasing: \`${config.installCommand}\`` : ""}

### Identity

Your agent name is set by the hook or script that launched you. Use \`$AGENT\` in commands.
For manual sessions, use \`<project>-dev\` (e.g., \`myapp-dev\`).

### Claims

When working on a bead, stake claims to prevent conflicts:

\`\`\`bash
bus claims stake --agent $AGENT "bead://<project>/<id>" -m "<id>"
bus claims stake --agent $AGENT "workspace://<project>/<ws>" -m "<id>"
bus claims release --agent $AGENT --all  # when done
\`\`\`

### Reviews

Use \`@<project>-<role>\` mentions to request reviews:

\`\`\`bash
maw exec $WS -- crit reviews request <review-id> --reviewers $PROJECT-security --agent $AGENT
bus send --agent $AGENT $PROJECT "Review requested: <review-id> @$PROJECT-security" -L review-request
\`\`\`

The @mention triggers the auto-spawn hook for the reviewer.

### Cross-Project Communication

**Don't suffer in silence.** If a tool confuses you or behaves unexpectedly, post to its project channel.

1. Find the project: \`bus history projects -n 50\` (the #projects channel has project registry entries)
2. Post question or feedback: \`bus send --agent $AGENT <project> "..." -L feedback\`
3. For bugs, create beads in their repo first
4. **Always create a local tracking bead** so you check back later:
   \`\`\`bash
   maw exec default -- br create --actor $AGENT --owner $AGENT --title="[tracking] <summary>" --labels tracking --type=task --priority=3
   \`\`\`

See [cross-channel.md](.agents/botbox/cross-channel.md) for the full workflow.

### Session Search (optional)

Use \`cass search "error or problem"\` to find how similar issues were solved in past sessions.

${designDocsSection}### Workflow Docs

${lifecycleLinks}`
}

/**
 * @typedef {object} DetectedConfig
 * @property {string} [name]
 * @property {string[]} [type]
 * @property {string[]} [tools]
 * @property {string[]} [reviewers]
 */

/**
 * Parse project config from the header of an existing AGENTS.md.
 * Returns only the fields that were successfully detected.
 * @param {string} content - Raw AGENTS.md content
 * @returns {DetectedConfig}
 */
export function parseAgentsMdHeader(content) {
  /** @type {DetectedConfig} */
  let result = {}
  let lines = content.split("\n")

  for (let line of lines) {
    if (line.startsWith("<!--")) {
      break
    } else if (line.startsWith("# ")) {
      result.name = line.slice(2).trim()
    } else if (line.startsWith("Project type: ")) {
      result.type = line.slice(14).split(",").map((s) => s.trim())
    } else if (line.startsWith("Tools: ")) {
      result.tools = line
        .slice(7)
        .replaceAll("`", "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (line.startsWith("Reviewer roles: ")) {
      result.reviewers = line.slice(16).split(",").map((s) => s.trim())
    }
  }

  // No reviewer line means no reviewers configured (not a parse failure)
  if (result.name && !result.reviewers) {
    result.reviewers = []
  }

  return result
}

/**
 * Replace the managed section in an existing AGENTS.md.
 * @param {string} content
 * @param {ManagedSectionConfig} [config]
 * @returns {string}
 */
export function updateManagedSection(content, config = {}) {
  const startIdx = content.indexOf(MANAGED_START)
  const endIdx = content.indexOf(MANAGED_END)

  const managed = `${MANAGED_START}\n${renderManagedSection(config)}\n${MANAGED_END}`

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    // Missing markers, only one marker, or markers out of order — strip any
    // partial markers and append a clean managed section
    let cleaned = content
      .replace(MANAGED_START, "")
      .replace(MANAGED_END, "")
      .trimEnd()
    return `${cleaned}\n\n${managed}\n`
  }

  const before = content.slice(0, startIdx)
  const after = content.slice(endIdx + MANAGED_END.length)
  return `${before}${managed}${after}`
}
