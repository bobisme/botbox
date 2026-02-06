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
  "report-issue.md": "Report bugs/features to other projects",
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

### Beads Quick Reference

| Operation | Command |
|-----------|---------|
| View ready work | \`br ready\` |
| Show bead | \`br show <id>\` |
| Create | \`br create --actor $AGENT --owner $AGENT --title="..." --type=task --priority=2\` |
| Start work | \`br update --actor $AGENT <id> --status=in_progress --owner=$AGENT\` |
| Add comment | \`br comments add --actor $AGENT --author $AGENT <id> "message"\` |
| Close | \`br close --actor $AGENT <id>\` |
| Add dependency | \`br dep add --actor $AGENT <blocked> <blocker>\` |
| Sync | \`br sync --flush-only\` |

**Required flags**: \`--actor $AGENT\` on mutations, \`--author $AGENT\` on comments.

### Workspace Quick Reference

| Operation | Command |
|-----------|---------|
| Create workspace | \`maw ws create <name>\` |
| List workspaces | \`maw ws list\` |
| Merge to main | \`maw ws merge <name> --destroy\` |
| Destroy (no merge) | \`maw ws destroy <name>\` |
| Run jj in workspace | \`maw ws jj <name> <jj-args...>\` |

**Avoiding divergent commits**: Each workspace owns ONE commit. Only modify your own.

| Safe | Dangerous |
|------|-----------|
| \`jj describe\` (your working copy) | \`jj describe main -m "..."\` |
| \`maw ws jj <your-ws> describe -m "..."\` | \`jj describe <other-change-id>\` |

If you see \`(divergent)\` in \`jj log\`:
\`\`\`bash
jj abandon <change-id>/0   # keep one, abandon the divergent copy
\`\`\`

### Beads Conventions

- Create a bead before starting work. Update status: \`open\` → \`in_progress\` → \`closed\`.
- Post progress comments during work for crash recovery.
- **Push to main** after completing beads (see [finish.md](.agents/botbox/finish.md)).${config.installCommand ? `\n- **Install locally** after releasing: \`${config.installCommand}\`` : ""}

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
crit reviews request <review-id> --reviewers $PROJECT-security --agent $AGENT
bus send --agent $AGENT $PROJECT "Review requested: <review-id> @$PROJECT-security" -L review-request
\`\`\`

The @mention triggers the auto-spawn hook for the reviewer.

### Cross-Project Communication

When you have questions, feedback, or issues with tools from other projects:

1. Find the project: \`bus history projects -n 50\` (the #projects channel has project registry entries)
2. Post to their channel: \`bus send <project> "..." -L feedback\`
3. For bugs/features, create beads in their repo (see [report-issue.md](.agents/botbox/report-issue.md))

This includes: bugs, feature requests, confusion about APIs, UX problems, or just questions.

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
