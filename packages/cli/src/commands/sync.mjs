import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  copyWorkflowDocs,
  currentVersion,
  readVersionMarker,
  writeVersionMarker,
} from "../lib/docs.mjs"
import { ExitError } from "../lib/errors.mjs"
import {
  currentScriptsVersion,
  readScriptsVersionMarker,
  updateExistingScripts,
  writeScriptsVersionMarker,
} from "../lib/scripts.mjs"
import { updateManagedSection } from "../lib/templates.mjs"
import { BOTBOX_CONFIG_VERSION } from "./init.mjs"

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

  // Check if scripts need updating
  let scriptsDir = join(agentsDir, "scripts")
  let scriptsNeedUpdate = false
  let installedScriptsVer = null
  let latestScriptsVer = null

  if (existsSync(scriptsDir)) {
    installedScriptsVer = readScriptsVersionMarker(scriptsDir)
    if (installedScriptsVer !== null) {
      latestScriptsVer = currentScriptsVersion()
      scriptsNeedUpdate = installedScriptsVer !== latestScriptsVer
    }
  }

  // Check if config needs updating
  let configPath = join(projectDir, ".botbox.json")
  let configNeedsUpdate = false
  let installedConfigVer = null
  let upgradedConfig = null

  if (existsSync(configPath)) {
    try {
      let config = JSON.parse(readFileSync(configPath, "utf-8"))
      installedConfigVer = config.version ?? "0.0.0"
      if (installedConfigVer !== BOTBOX_CONFIG_VERSION) {
        upgradedConfig = upgradeConfig(config, installedConfigVer, BOTBOX_CONFIG_VERSION)
        configNeedsUpdate = true
      }
    } catch {
      // Ignore parse errors — don't break on malformed config
    }
  }

  // Validate in --check mode (after all checks, before any writes)
  if (
    opts.check &&
    (docsNeedUpdate || managedSectionNeedsUpdate || scriptsNeedUpdate || configNeedsUpdate)
  ) {
    let parts = []
    if (docsNeedUpdate) {
      parts.push(
        `workflow docs (${installed ?? "(none)"} → ${latest})`,
      )
    }
    if (managedSectionNeedsUpdate) {
      parts.push("managed section of AGENTS.md")
    }
    if (scriptsNeedUpdate) {
      parts.push(
        `loop scripts (${installedScriptsVer} → ${latestScriptsVer})`,
      )
    }
    if (configNeedsUpdate) {
      parts.push(
        `.botbox.json (${installedConfigVer} → ${BOTBOX_CONFIG_VERSION})`,
      )
    }
    throw new ExitError(`Stale: ${parts.join(", ")}`, 1)
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

  if (scriptsNeedUpdate) {
    let updated = updateExistingScripts(scriptsDir)
    writeScriptsVersionMarker(scriptsDir)
    console.log(`Updated loop scripts: ${updated.join(", ")}`)
  }

  if (configNeedsUpdate && upgradedConfig) {
    writeFileSync(configPath, JSON.stringify(upgradedConfig, null, 2) + "\n")
    console.log(`Updated .botbox.json: ${installedConfigVer} → ${BOTBOX_CONFIG_VERSION}`)
  }

  // Summary output
  if (docsNeedUpdate) {
    console.log(`Synced: ${installed ?? "(none)"} → ${latest}`)
  } else if (!managedSectionNeedsUpdate && !scriptsNeedUpdate && !configNeedsUpdate) {
    console.log("Already up to date.")
  }
}

/**
 * Upgrade config from one version to another.
 * @param {any} config - Current config object
 * @param {string} from - Current version
 * @param {string} to - Target version
 * @returns {any} Upgraded config
 */
function upgradeConfig(config, from, to) {
  // For now, only version 1.0.0 exists. Future migrations go here.
  // Example: if (from === "0.9.0" && to === "1.0.0") { /* migrate */ }

  // Clone config to avoid mutating the original
  let upgraded = structuredClone(config)

  // Update version field
  upgraded.version = to

  return upgraded
}
