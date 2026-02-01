import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  copyWorkflowDocs,
  currentVersion,
  readVersionMarker,
  writeVersionMarker,
} from "../lib/docs.mjs"
import { ExitError } from "../lib/errors.mjs"
import { updateManagedSection } from "../lib/templates.mjs"

/**
 * @param {object} opts
 * @param {boolean} [opts.check]
 */
export function sync(opts) {
  const projectDir = process.cwd()
  const agentsDir = join(projectDir, ".agents", "botbox")

  if (!existsSync(agentsDir)) {
    throw new ExitError("No .agents/botbox/ found. Run `botbox init` first.", 1)
  }

  const installed = readVersionMarker(agentsDir)
  const latest = currentVersion()

  // Check if docs need updating (don't update yet, just check)
  const docsNeedUpdate = installed !== latest

  // Check if managed section needs updating (don't update yet, just check)
  const agentsMdPath = join(projectDir, "AGENTS.md")
  let managedSectionNeedsUpdate = false
  let managedSectionContent = ""
  let managedSectionUpdated = ""

  if (existsSync(agentsMdPath)) {
    managedSectionContent = readFileSync(agentsMdPath, "utf-8")
    managedSectionUpdated = updateManagedSection(managedSectionContent)
    managedSectionNeedsUpdate = managedSectionContent !== managedSectionUpdated
  }

  // Validate in --check mode (after all checks, before any writes)
  if (opts.check && (docsNeedUpdate || managedSectionNeedsUpdate)) {
    let msg = "Stale:"
    if (docsNeedUpdate) {
      msg += ` workflow docs (${installed ?? "(none)"} → ${latest})`
    }
    if (managedSectionNeedsUpdate) {
      if (docsNeedUpdate) msg += ","
      msg += " managed section of AGENTS.md"
    }
    throw new ExitError(msg, 1)
  }

  // Perform updates
  if (docsNeedUpdate) {
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir)
    console.log("Updated workflow docs")
  }

  if (managedSectionNeedsUpdate) {
    writeFileSync(agentsMdPath, managedSectionUpdated)
    console.log("Updated managed section of AGENTS.md")
  }

  // Summary output
  if (!docsNeedUpdate && !managedSectionNeedsUpdate) {
    console.log("Already up to date.")
  } else if (docsNeedUpdate) {
    console.log(`Synced: ${installed ?? "(none)"} → ${latest}`)
  } else if (managedSectionNeedsUpdate) {
    console.log("Updated managed section (workflow docs unchanged)")
  }
}
