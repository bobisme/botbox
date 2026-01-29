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

  if (installed === latest) {
    console.log("Already up to date.")
    return
  }

  if (opts.check) {
    throw new ExitError(
      `Stale: installed ${installed ?? "(none)"}, latest ${latest}`,
      1,
    )
  }

  // Update workflow docs
  copyWorkflowDocs(agentsDir)
  writeVersionMarker(agentsDir)
  console.log("Updated workflow docs")

  // Update managed section of AGENTS.md
  const agentsMdPath = join(projectDir, "AGENTS.md")
  if (existsSync(agentsMdPath)) {
    const content = readFileSync(agentsMdPath, "utf-8")
    const updated = updateManagedSection(content)
    writeFileSync(agentsMdPath, updated)
    console.log("Updated managed section of AGENTS.md")
  }

  console.log(`Synced: ${installed ?? "(none)"} → ${latest}`)
}
