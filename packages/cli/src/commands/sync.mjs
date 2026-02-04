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
  copyPrompts,
  currentPromptsVersion,
  readPromptsVersionMarker,
  writePromptsVersionMarker,
} from "../lib/prompts.mjs"
import {
  currentScriptsVersion,
  readScriptsVersionMarker,
  updateExistingScripts,
  writeScriptsVersionMarker,
} from "../lib/scripts.mjs"
import { updateManagedSection } from "../lib/templates.mjs"
import {
  currentMigrationVersion,
  getPendingMigrations,
} from "../migrations/index.mjs"

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

  // Read config first (needed for managed section generation)
  let configPath = join(projectDir, ".botbox.json")
  let configNeedsUpdate = false
  let installedConfigVer = null
  let latestConfigVer = currentMigrationVersion()
  /** @type {import("../migrations/index.mjs").Migration[]} */
  let pendingMigrations = []
  let config = null

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"))
    } catch {
      // Ignore parse errors — don't break on malformed config
    }
  } else {
    config = { version: "0.0.0" }
  }

  if (config) {
    installedConfigVer = config.version ?? "0.0.0"
    pendingMigrations = getPendingMigrations(installedConfigVer)
    configNeedsUpdate = pendingMigrations.length > 0
  }

  // Extract managed section config from project config
  let managedConfig = {
    installCommand: config?.project?.installCommand,
  }

  // Check if managed section needs updating (don't update yet, just check)
  const agentsMdPath = join(projectDir, "AGENTS.md")
  let managedSectionNeedsUpdate = false
  let managedSectionContent = ""
  let managedSectionUpdated = ""

  if (existsSync(agentsMdPath)) {
    managedSectionContent = readFileSync(agentsMdPath, "utf-8")
    managedSectionUpdated = updateManagedSection(managedSectionContent, managedConfig)
    managedSectionNeedsUpdate = managedSectionContent !== managedSectionUpdated
  }

  let scriptsState = getScriptsUpdateState(agentsDir)
  let scriptsDir = scriptsState.scriptsDir
  let scriptsNeedUpdate = scriptsState.scriptsNeedUpdate
  let installedScriptsVer = scriptsState.installedScriptsVer
  let latestScriptsVer = scriptsState.latestScriptsVer

  // Check if prompts need updating
  let promptsState = getPromptsUpdateState(agentsDir)
  let promptsDir = promptsState.promptsDir
  let promptsNeedUpdate = promptsState.promptsNeedUpdate
  let installedPromptsVer = promptsState.installedPromptsVer
  let latestPromptsVer = promptsState.latestPromptsVer

  // Validate in --check mode (after all checks, before any writes)
  if (
    opts.check &&
    (docsNeedUpdate || managedSectionNeedsUpdate || scriptsNeedUpdate || promptsNeedUpdate || configNeedsUpdate)
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
    if (promptsNeedUpdate) {
      parts.push(
        `prompt templates (${installedPromptsVer} → ${latestPromptsVer})`,
      )
    }
    if (configNeedsUpdate) {
      parts.push(
        `.botbox.json (${installedConfigVer} → ${latestConfigVer})`,
      )
    }
    throw new ExitError(`Stale: ${parts.join(", ")}`, 1)
  }

  let ranMigrations = false
  if (configNeedsUpdate && config) {
    applyMigrations({
      projectDir,
      agentsDir,
      configPath,
      config,
      pendingMigrations,
    })
    ranMigrations = true
    configNeedsUpdate = false

    scriptsState = getScriptsUpdateState(agentsDir)
    scriptsDir = scriptsState.scriptsDir
    scriptsNeedUpdate = scriptsState.scriptsNeedUpdate
    installedScriptsVer = scriptsState.installedScriptsVer
    latestScriptsVer = scriptsState.latestScriptsVer

    if (existsSync(agentsMdPath)) {
      managedSectionContent = readFileSync(agentsMdPath, "utf-8")
      managedSectionUpdated = updateManagedSection(managedSectionContent, managedConfig)
      managedSectionNeedsUpdate = managedSectionContent !== managedSectionUpdated
    }
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

  if (promptsNeedUpdate) {
    copyPrompts(promptsDir)
    writePromptsVersionMarker(promptsDir)
    console.log("Updated prompt templates")
  }

  // Summary output
  if (docsNeedUpdate) {
    console.log(`Synced: ${installed ?? "(none)"} → ${latest}`)
  } else if (
    !managedSectionNeedsUpdate &&
    !scriptsNeedUpdate &&
    !promptsNeedUpdate &&
    !configNeedsUpdate &&
    !ranMigrations
  ) {
    console.log("Already up to date.")
  }
}

/**
 * @param {string} agentsDir
 */
function getScriptsUpdateState(agentsDir) {
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

  return {
    scriptsDir,
    scriptsNeedUpdate,
    installedScriptsVer,
    latestScriptsVer,
  }
}

/**
 * @param {string} agentsDir
 */
function getPromptsUpdateState(agentsDir) {
  let promptsDir = join(agentsDir, "prompts")
  let promptsNeedUpdate = false
  let installedPromptsVer = null
  let latestPromptsVer = currentPromptsVersion()

  if (existsSync(promptsDir)) {
    installedPromptsVer = readPromptsVersionMarker(promptsDir)
    if (installedPromptsVer !== null) {
      promptsNeedUpdate = installedPromptsVer !== latestPromptsVer
    }
  } else {
    // Prompts directory doesn't exist - need to create it
    promptsNeedUpdate = true
    installedPromptsVer = "(none)"
  }

  return {
    promptsDir,
    promptsNeedUpdate,
    installedPromptsVer,
    latestPromptsVer,
  }
}

/**
 * @param {object} params
 * @param {string} params.projectDir
 * @param {string} params.agentsDir
 * @param {string} params.configPath
 * @param {any} params.config
 * @param {Array<{ id: string, title: string, up: (ctx: any) => void }>} params.pendingMigrations
 */
function applyMigrations({
  projectDir,
  agentsDir,
  configPath,
  config,
  pendingMigrations,
}) {
  let startVersion = config.version ?? "0.0.0"
  let ctx = {
    projectDir,
    agentsDir,
    configPath,
    config,
    log: (/** @type {string} */ message) => console.log(message),
    warn: (/** @type {string} */ message) => console.warn(message),
  }

  for (let migration of pendingMigrations) {
    console.log(`Running migration ${migration.id}: ${migration.title}`)
    try {
      migration.up(ctx)
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error)
      throw new ExitError(`Migration ${migration.id} failed: ${message}`, 1)
    }

    config.version = migration.id
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
  }

  if (pendingMigrations.length > 0) {
    console.log(`Updated .botbox.json: ${startVersion} → ${config.version}`)
  }
}
