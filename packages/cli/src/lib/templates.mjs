import { listWorkflowDocs } from "./docs.mjs"

const MANAGED_START = "<!-- botbox:managed-start -->"
const MANAGED_END = "<!-- botbox:managed-end -->"

/**
 * @typedef {object} ProjectConfig
 * @property {string} name
 * @property {string} type
 * @property {string[]} tools
 * @property {string[]} reviewers
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

  return `# ${config.name}

Project type: ${config.type}
Tools: ${toolList}${reviewerLine}

<!-- Add project-specific context below: architecture, conventions, key files, etc. -->

${MANAGED_START}
${renderManagedSection()}
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
  "review-request.md": "Request a review",
  "review-response.md": "Handle reviewer feedback (fix/address/defer)",
  "review-loop.md": "Reviewer agent loop",
  "merge-check.md": "Verify approval before merge",
  "preflight.md": "Validate toolchain health",
  "report-issue.md": "Report bugs/features to other projects",
}

/**
 * Render the managed section content.
 * @returns {string}
 */
function renderManagedSection() {
  let lifecycleLinks = listWorkflowDocs()
    .sort()
    .map((doc) => {
      let desc = DOC_DESCRIPTIONS[doc] ?? doc.replace(".md", "")
      return `- [${desc}](.agents/botbox/${doc})`
    })
    .join("\n")

  return `## Botbox Workflow

This project uses the botbox multi-agent workflow.

### Identity

Every command that touches bus or crit requires \`--agent <name>\`.
Use \`<project>-dev\` as your name (e.g., \`terseid-dev\`). Agents spawned by \`agent-loop.sh\` receive a random name automatically.
Run \`bus whoami --agent $AGENT\` to confirm your identity.

### Lifecycle

**New to the workflow?** Start with [worker-loop.md](.agents/botbox/worker-loop.md) — it covers the complete triage → start → work → finish cycle.

Individual workflow docs:

${lifecycleLinks}

### Quick Start

\`\`\`bash
AGENT=<project>-dev   # or: AGENT=$(bus generate-name)
bus whoami --agent $AGENT
br ready
\`\`\`

### Beads Conventions

- Create a bead for each unit of work before starting.
- Update status as you progress: \`open\` → \`in_progress\` → \`closed\`.
- Reference bead IDs in all bus messages.
- Sync on session end: \`br sync --flush-only\`.

### Mesh Protocol

- Include \`-L mesh\` on bus messages.
- Claim bead: \`bus claim --agent $AGENT "bead://$BOTBOX_PROJECT/<bead-id>" -m "<bead-id>"\`.
- Claim workspace: \`bus claim --agent $AGENT "workspace://$BOTBOX_PROJECT/$WS" -m "<bead-id>"\`.
- Claim agents before spawning: \`bus claim --agent $AGENT "agent://role" -m "<bead-id>"\`.
- Release claims when done: \`bus release --agent $AGENT --all\`.

### Spawning Agents

1. Check if the role is online: \`bus agents\`.
2. Claim the agent lease: \`bus claim --agent $AGENT "agent://role"\`.
3. Spawn with an explicit identity (e.g., via botty or agent-loop.sh).
4. Announce with \`-L spawn-ack\`.

### Reviews

- Use \`crit\` to open and request reviews.
- If a reviewer is not online, claim \`agent://reviewer-<role>\` and spawn them.
- Reviewer agents loop until no pending reviews remain (see review-loop doc).

### Cross-Project Feedback

When you encounter issues with tools from other projects:

1. Query the \`#projects\` registry: \`bus inbox --agent $AGENT --channels projects --all\`
2. Find the project entry (format: \`project:<name> repo:<path> lead:<agent> tools:<tool1>,<tool2>\`)
3. Navigate to the repo, create beads with \`br create\`
4. Post to the project channel: \`bus send <project> "Filed beads: <ids>. <summary> @<lead>" -L feedback\`

See [report-issue.md](.agents/botbox/report-issue.md) for details.

### Stack Reference

| Tool | Purpose | Key commands |
|------|---------|-------------|
| bus | Communication, claims, presence | \`send\`, \`inbox\`, \`claim\`, \`release\`, \`agents\` |
| maw | Isolated jj workspaces | \`ws create\`, \`ws merge\`, \`ws destroy\` |
| br/bv | Work tracking + triage | \`ready\`, \`create\`, \`close\`, \`--robot-next\` |
| crit | Code review | \`review\`, \`comment\`, \`lgtm\`, \`block\` |
| botty | Agent runtime | \`spawn\`, \`kill\`, \`tail\`, \`snapshot\` |

### Loop Scripts

Scripts in \`scripts/\` automate agent loops:

| Script | Purpose |
|--------|---------|
| \`agent-loop.sh\` | Worker: sequential triage-start-work-finish |
| \`dev-loop.sh\` | Lead dev: triage, parallel dispatch, merge |
| \`reviewer-loop.sh\` | Reviewer: review loop until queue empty |
| \`spawn-security-reviewer.sh\` | Spawn a security reviewer |

Usage: \`bash scripts/<script>.sh <project-name> [agent-name]\``
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
 * @returns {string}
 */
export function updateManagedSection(content) {
  const startIdx = content.indexOf(MANAGED_START)
  const endIdx = content.indexOf(MANAGED_END)

  const managed = `${MANAGED_START}\n${renderManagedSection()}\n${MANAGED_END}`

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
