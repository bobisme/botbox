import { execSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * @typedef {object} StatusSection
 * @property {string} name
 * @property {boolean} available
 * @property {string} [error]
 * @property {any} [data]
 */

/**
 * @typedef {object} StatusResult
 * @property {StatusSection} beads
 * @property {StatusSection} workspaces
 * @property {StatusSection} inbox
 * @property {StatusSection} agents
 * @property {StatusSection} claims
 */

/**
 * Run a command and return parsed JSON or null on failure
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ data: any, error: string | null }}
 */
function runJsonCommand(cmd, args) {
  try {
    let result = spawnSync(cmd, args, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env },
    })

    if (result.error) {
      // Command not found or spawn error
      let err = /** @type {NodeJS.ErrnoException} */ (result.error)
      if (err.code === "ENOENT") {
        return { data: null, error: `${cmd} not installed` }
      }
      return { data: null, error: result.error.message }
    }

    if (result.status !== 0) {
      let stderr = result.stderr?.trim() || ""
      return { data: null, error: stderr || `exit code ${result.status}` }
    }

    let stdout = result.stdout?.trim() || ""
    if (!stdout) {
      return { data: [], error: null }
    }

    try {
      return { data: JSON.parse(stdout), error: null }
    } catch {
      return { data: null, error: "invalid JSON response" }
    }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Check if a tool is available
 * @param {string} cmd
 * @returns {boolean}
 */
function isToolAvailable(cmd) {
  try {
    execSync(`which ${cmd}`, { encoding: "utf-8", timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * Get open beads (ready work)
 * @returns {StatusSection}
 */
function getBeadsStatus() {
  if (!isToolAvailable("br")) {
    return { name: "beads", available: false, error: "br not installed" }
  }

  // Check if .beads directory exists
  let beadsDir = join(process.cwd(), ".beads")
  if (!existsSync(beadsDir)) {
    return { name: "beads", available: false, error: "no .beads/ directory" }
  }

  let { data, error } = runJsonCommand("br", ["ready", "--format", "json", "--limit", "0"])
  if (error) {
    return { name: "beads", available: true, error }
  }

  return { name: "beads", available: true, data }
}

/**
 * Get active workspaces
 * @returns {StatusSection}
 */
function getWorkspacesStatus() {
  if (!isToolAvailable("maw")) {
    return { name: "workspaces", available: false, error: "maw not installed" }
  }

  let { data, error } = runJsonCommand("maw", ["ws", "list", "--format", "json"])
  if (error) {
    return { name: "workspaces", available: true, error }
  }

  return { name: "workspaces", available: true, data }
}

/**
 * Get pending inbox messages
 * @returns {StatusSection}
 */
function getInboxStatus() {
  if (!isToolAvailable("bus")) {
    return { name: "inbox", available: false, error: "bus not installed" }
  }

  let agent = process.env["AGENT"] || process.env["BOTBUS_AGENT"]
  let args = ["inbox", "--format", "json", "--all"]
  if (agent) {
    args.push("--agent", agent)
  }

  let { data, error } = runJsonCommand("bus", args)
  if (error) {
    return { name: "inbox", available: true, error }
  }

  return { name: "inbox", available: true, data }
}

/**
 * Get running agents
 * @returns {StatusSection}
 */
function getAgentsStatus() {
  if (!isToolAvailable("botty")) {
    return { name: "agents", available: false, error: "botty not installed" }
  }

  let { data, error } = runJsonCommand("botty", ["list", "--format", "json"])
  if (error) {
    return { name: "agents", available: true, error }
  }

  return { name: "agents", available: true, data }
}

/**
 * Get active claims
 * @returns {StatusSection}
 */
function getClaimsStatus() {
  if (!isToolAvailable("bus")) {
    return { name: "claims", available: false, error: "bus not installed" }
  }

  let { data, error } = runJsonCommand("bus", ["claims", "list", "--format", "json"])
  if (error) {
    return { name: "claims", available: true, error }
  }

  return { name: "claims", available: true, data }
}

/**
 * Collect all status information
 * @returns {StatusResult}
 */
function collectStatus() {
  return {
    beads: getBeadsStatus(),
    workspaces: getWorkspacesStatus(),
    inbox: getInboxStatus(),
    agents: getAgentsStatus(),
    claims: getClaimsStatus(),
  }
}

/**
 * Format human-readable output for a section
 * @param {StatusSection} section
 * @param {string} title
 * @param {(item: any) => string} formatter
 */
function printSection(section, title, formatter) {
  console.log(`\n${title}:`)

  if (!section.available) {
    console.log(`  (${section.error})`)
    return
  }

  if (section.error) {
    console.log(`  Error: ${section.error}`)
    return
  }

  let items = Array.isArray(section.data) ? section.data : []
  if (items.length === 0) {
    console.log("  (none)")
    return
  }

  for (let item of items) {
    console.log(`  ${formatter(item)}`)
  }
}

/**
 * Format a bead for display
 * @param {any} bead
 * @returns {string}
 */
function formatBead(bead) {
  let id = bead.id || bead.short_id || "?"
  let title = bead.title || "(untitled)"
  let status = bead.status || "?"
  let priority = bead.priority !== undefined ? `P${bead.priority}` : ""
  let owner = bead.owner ? `@${bead.owner}` : ""

  let parts = [id, title]
  if (priority) parts.push(`[${priority}]`)
  if (status !== "open") parts.push(`(${status})`)
  if (owner) parts.push(owner)

  return parts.join(" ")
}

/**
 * Format a workspace for display
 * @param {any} ws
 * @returns {string}
 */
function formatWorkspace(ws) {
  let name = ws.name || ws.workspace || "?"
  let desc = ws.description || ws.commit_description || ""
  let stale = ws.stale ? " [stale]" : ""

  if (desc) {
    // Truncate long descriptions
    let shortDesc = desc.length > 50 ? desc.slice(0, 47) + "..." : desc
    return `${name}: ${shortDesc}${stale}`
  }

  return `${name}${stale}`
}

/**
 * Format an inbox message for display
 * @param {any} msg
 * @returns {string}
 */
function formatInboxMessage(msg) {
  let channel = msg.channel || "?"
  let from = msg.from || msg.agent || "?"
  let content = msg.content || msg.message || ""
  let shortContent = content.length > 60 ? content.slice(0, 57) + "..." : content

  return `#${channel} <${from}> ${shortContent}`
}

/**
 * Format an agent for display
 * @param {any} agent
 * @returns {string}
 */
function formatAgent(agent) {
  let name = agent.name || agent.agent || agent.id || "?"
  let status = agent.status || agent.state || "?"
  let labels = agent.labels ? ` [${agent.labels.join(", ")}]` : ""

  return `${name} (${status})${labels}`
}

/**
 * Format a claim for display
 * @param {any} claim
 * @returns {string}
 */
function formatClaim(claim) {
  let resource = claim.resource || claim.uri || "?"
  let agent = claim.agent || claim.owner || "?"
  let message = claim.message || ""

  if (message) {
    return `${resource} by ${agent}: ${message}`
  }

  return `${resource} by ${agent}`
}

/**
 * Print human-readable status output
 * @param {StatusResult} status
 */
function printHumanReadable(status) {
  console.log("Project Status")
  console.log("==============")

  printSection(status.beads, "Ready Beads", formatBead)
  printSection(status.workspaces, "Active Workspaces", formatWorkspace)
  printSection(status.inbox, "Pending Inbox", formatInboxMessage)
  printSection(status.agents, "Running Agents", formatAgent)
  printSection(status.claims, "Active Claims", formatClaim)

  console.log()
}

/**
 * Show status across all botbox tools
 * @param {object} opts
 * @param {boolean} [opts.json]
 */
export function status(opts) {
  let result = collectStatus()

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    printHumanReadable(result)
  }
}
