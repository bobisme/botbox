import { execSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  copyWorkflowDocs,
  currentVersion,
  readVersionMarker,
  writeVersionMarker,
} from "../lib/docs.mjs"
import { ExitError } from "../lib/errors.mjs"
import { commit, hasUncommittedChanges, isJjRepo } from "../lib/jj.mjs"
import {
  copyPrompts,
  currentPromptsVersion,
  readPromptsVersionMarker,
  writePromptsVersionMarker,
} from "../lib/prompts.mjs"
import {
  currentScriptsVersion,
  listEligibleScripts,
  readScriptsVersionMarker,
  syncScripts,
  writeScriptsVersionMarker,
} from "../lib/scripts.mjs"
import {
  currentHooksVersion,
  generateHooksConfig,
  readHooksVersionMarker,
  syncHooks,
  writeHooksVersionMarker,
} from "../lib/hooks.mjs"
import {
  currentDesignDocsVersion,
  listEligibleDesignDocs,
  readDesignDocsVersionMarker,
  syncDesignDocs,
  writeDesignDocsVersionMarker,
} from "../lib/design-docs.mjs"
import { updateManagedSection } from "../lib/templates.mjs"
import {
  currentMigrationVersion,
  getPendingMigrations,
} from "../migrations/index.mjs"

/**
 * @param {object} opts
 * @param {boolean} [opts.check]
 * @param {boolean} [opts.commit] - Auto-commit changes (default: true)
 */
export function sync(opts) {
  let shouldCommit = opts.commit !== false
  const projectDir = process.cwd()
  const agentsDir = join(projectDir, ".agents", "botbox")

  // Detect maw v2 bare repo — botbox was initialized inside ws/default/
  if (existsSync(join(projectDir, "ws", "default", ".botbox.json"))) {
    let args = ["exec", "default", "--", "botbox", "sync"]
    if (opts.check) args.push("--check")
    if (opts.commit === false) args.push("--no-commit")
    execSync(`maw ${args.join(" ")}`, {
      cwd: projectDir,
      stdio: "inherit",
    })

    // Ensure bare root has stub AGENTS.md + CLAUDE.md symlink
    // so Claude Code finds instructions when launched from project root
    let stubAgentsMd = join(projectDir, "AGENTS.md")
    let stubClaudeMd = join(projectDir, "CLAUDE.md")
    let stubContent = "**Do not edit the root AGENTS.md or CLAUDE.md for memories or instructions. Use the AGENTS.md in ws/default/.**\n@ws/default/AGENTS.md\n"
    if (!existsSync(stubAgentsMd)) {
      writeFileSync(stubAgentsMd, stubContent)
      console.log("Created bare-root AGENTS.md stub")
    }
    if (!existsSync(stubClaudeMd)) {
      symlinkSync("AGENTS.md", stubClaudeMd)
      console.log("Symlinked bare-root CLAUDE.md → AGENTS.md")
    }

    // Symlink repo-root/.claude → ws/default/.claude so Claude Code
    // finds hooks when launched from the bare repo root
    let rootClaudeDir = join(projectDir, ".claude")
    let wsClaudeDir = join(projectDir, "ws", "default", ".claude")
    if (existsSync(wsClaudeDir)) {
      let isSymlink = existsSync(rootClaudeDir) && lstatSync(rootClaudeDir).isSymbolicLink()
      if (!isSymlink) {
        // Remove existing .claude/ directory (stale generated copy)
        if (existsSync(rootClaudeDir)) {
          rmSync(rootClaudeDir, { recursive: true })
        }
        symlinkSync("ws/default/.claude", rootClaudeDir)
        console.log("Symlinked .claude → ws/default/.claude")
      }
    }

    return
  }

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
  let projectTypes = config?.project?.type ?? []
  if (!Array.isArray(projectTypes)) projectTypes = [projectTypes]
  let managedConfig = {
    installCommand: config?.project?.installCommand,
    projectTypes,
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

  let scriptsState = getScriptsUpdateState(agentsDir, config)
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

  // Check if hooks need updating
  let hooksState = getHooksUpdateState(agentsDir)
  let hooksDir = hooksState.hooksDir
  let hooksNeedUpdate = hooksState.hooksNeedUpdate
  let installedHooksVer = hooksState.installedHooksVer
  let latestHooksVer = hooksState.latestHooksVer

  // Check if design docs need updating
  let designDocsState = getDesignDocsUpdateState(agentsDir, config)
  let designDocsDir = designDocsState.designDocsDir
  let designDocsNeedUpdate = designDocsState.designDocsNeedUpdate
  let installedDesignDocsVer = designDocsState.installedDesignDocsVer
  let latestDesignDocsVer = designDocsState.latestDesignDocsVer

  // Validate in --check mode (after all checks, before any writes)
  if (
    opts.check &&
    (docsNeedUpdate || managedSectionNeedsUpdate || scriptsNeedUpdate || promptsNeedUpdate || hooksNeedUpdate || designDocsNeedUpdate || configNeedsUpdate)
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
    if (hooksNeedUpdate) {
      parts.push(
        `hooks (${installedHooksVer} → ${latestHooksVer})`,
      )
    }
    if (designDocsNeedUpdate) {
      parts.push(
        `design docs (${installedDesignDocsVer} → ${latestDesignDocsVer})`,
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

    scriptsState = getScriptsUpdateState(agentsDir, config)
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
    // Extract enabled tools from config
    let enabledTools = []
    if (config?.tools) {
      for (let [tool, enabled] of Object.entries(config.tools)) {
        if (enabled) enabledTools.push(tool)
      }
    }
    let reviewers = config?.review?.reviewers ?? []

    let { updated, added } = syncScripts(scriptsDir, { tools: enabledTools, reviewers })
    writeScriptsVersionMarker(scriptsDir)
    let parts = []
    if (updated.length > 0) parts.push(`updated: ${updated.join(", ")}`)
    if (added.length > 0) parts.push(`added: ${added.join(", ")}`)
    if (parts.length > 0) {
      console.log(`Synced scripts (${parts.join("; ")})`)
    }
  }

  if (promptsNeedUpdate) {
    copyPrompts(promptsDir)
    writePromptsVersionMarker(promptsDir)
    console.log("Updated prompt templates")
  }

  if (hooksNeedUpdate) {
    let enabledTools = []
    if (config?.tools) {
      for (let [tool, enabled] of Object.entries(config.tools)) {
        if (enabled) enabledTools.push(tool)
      }
    }
    let { updated, added } = syncHooks(hooksDir, { tools: enabledTools })
    if (updated.length > 0 || added.length > 0) {
      writeHooksVersionMarker(hooksDir)
      let hookParts = []
      if (updated.length > 0) hookParts.push(`updated: ${updated.join(", ")}`)
      if (added.length > 0) hookParts.push(`added: ${added.join(", ")}`)
      console.log(`Synced hooks (${hookParts.join("; ")})`)
    }

    // Regenerate .claude/settings.json hooks config
    let hookFiles = existsSync(hooksDir) ? readdirSync(hooksDir).filter((f) => f.endsWith(".sh")) : []
    if (hookFiles.length > 0) {
      let claudeDir = join(projectDir, ".claude")
      let settingsPath = join(claudeDir, "settings.json")
      let settings = {}
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
        } catch {
          // Overwrite if unparseable
        }
      }
      settings.hooks = generateHooksConfig(resolve(hooksDir), hookFiles)
      mkdirSync(claudeDir, { recursive: true })
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
      console.log("Regenerated .claude/settings.json hooks config")
    }
  }

  if (designDocsNeedUpdate) {
    // Get project types from config
    let projectTypes = config?.project?.type ?? []
    if (!Array.isArray(projectTypes)) projectTypes = [projectTypes]

    let allUpdated = []
    let allAdded = []
    for (let projectType of projectTypes) {
      let { updated, added } = syncDesignDocs(designDocsDir, projectType)
      allUpdated.push(...updated)
      allAdded.push(...added)
    }
    // Deduplicate
    allUpdated = [...new Set(allUpdated)]
    allAdded = [...new Set(allAdded.filter((a) => !allUpdated.includes(a)))]

    writeDesignDocsVersionMarker(designDocsDir)
    let parts = []
    if (allUpdated.length > 0) parts.push(`updated: ${allUpdated.join(", ")}`)
    if (allAdded.length > 0) parts.push(`added: ${allAdded.join(", ")}`)
    if (parts.length > 0) {
      console.log(`Synced design docs (${parts.join("; ")})`)
    }
  }

  // Ensure .critignore exists if crit is enabled
  let critignoreCreated = false
  if (config?.tools?.crit) {
    let critignorePath = join(projectDir, ".critignore")
    if (!existsSync(critignorePath)) {
      writeFileSync(critignorePath, `# Ignore botbox-managed files (prompts, scripts, hooks, journals)
.agents/botbox/

# Ignore tool config and data files
.beads/
.crit/
.maw.toml
.botbox.json
.claude/
opencode.json
`)
      console.log("Created .critignore")
      critignoreCreated = true
    }
  }

  // Summary output
  if (docsNeedUpdate) {
    console.log(`Synced: ${installed ?? "(none)"} → ${latest}`)
  } else if (
    !managedSectionNeedsUpdate &&
    !scriptsNeedUpdate &&
    !promptsNeedUpdate &&
    !hooksNeedUpdate &&
    !designDocsNeedUpdate &&
    !configNeedsUpdate &&
    !ranMigrations
  ) {
    console.log("Already up to date.")
  }

  // Auto-commit if changes were made
  let madeChanges =
    docsNeedUpdate ||
    managedSectionNeedsUpdate ||
    scriptsNeedUpdate ||
    promptsNeedUpdate ||
    hooksNeedUpdate ||
    designDocsNeedUpdate ||
    critignoreCreated ||
    ranMigrations
  if (madeChanges && shouldCommit && isJjRepo()) {
    let parts = []
    if (docsNeedUpdate) parts.push("docs")
    if (managedSectionNeedsUpdate) parts.push("AGENTS.md")
    if (scriptsNeedUpdate) parts.push("scripts")
    if (promptsNeedUpdate) parts.push("prompts")
    if (hooksNeedUpdate) parts.push("hooks")
    if (designDocsNeedUpdate) parts.push("design-docs")
    if (ranMigrations) parts.push("migrations")

    let fromVer = installed ?? installedConfigVer ?? "0.0.0"
    let toVer = latest
    let message = `chore: upgrade botbox from ${fromVer} to ${toVer}\n\nUpdated: ${parts.join(", ")}`

    // Only commit botbox-managed files to avoid capturing unrelated
    // user changes that happen to be in the working copy.
    let managedPaths = [".agents/botbox"]
    if (managedSectionNeedsUpdate) managedPaths.push("AGENTS.md")
    if (ranMigrations) managedPaths.push(".botbox.json", ".claude/settings.json")
    if (hooksNeedUpdate) managedPaths.push(".claude/settings.json")
    if (critignoreCreated) managedPaths.push(".critignore")

    if (commit(message, managedPaths)) {
      console.log(`Committed: chore: upgrade botbox from ${fromVer} to ${toVer}`)
    } else {
      console.warn("Warning: Failed to auto-commit (jj error)")
    }
  }
}

/**
 * @param {string} agentsDir
 * @param {any} config
 */
function getScriptsUpdateState(agentsDir, config) {
  let scriptsDir = join(agentsDir, "scripts")
  let scriptsNeedUpdate = false
  let installedScriptsVer = null
  let latestScriptsVer = null

  if (existsSync(scriptsDir)) {
    installedScriptsVer = readScriptsVersionMarker(scriptsDir)
    if (installedScriptsVer !== null) {
      latestScriptsVer = currentScriptsVersion()
      scriptsNeedUpdate = installedScriptsVer !== latestScriptsVer

      // Also check for missing eligible scripts
      if (!scriptsNeedUpdate && config?.tools) {
        let enabledTools = Object.entries(config.tools)
          .filter(([, enabled]) => enabled)
          .map(([tool]) => tool)
        let reviewers = config?.review?.reviewers ?? []
        let eligible = listEligibleScripts({ tools: enabledTools, reviewers })
        for (let script of eligible) {
          if (!existsSync(join(scriptsDir, script))) {
            scriptsNeedUpdate = true
            break
          }
        }
      }
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

/**
 * @param {string} agentsDir
 */
function getHooksUpdateState(agentsDir) {
  let hooksDir = join(agentsDir, "hooks")
  let hooksNeedUpdate = false
  let installedHooksVer = null
  let latestHooksVer = currentHooksVersion()

  if (existsSync(hooksDir)) {
    installedHooksVer = readHooksVersionMarker(hooksDir)
    hooksNeedUpdate = installedHooksVer !== latestHooksVer
  } else {
    // Hooks dir doesn't exist — install eligible hooks for first time
    hooksNeedUpdate = true
  }

  return {
    hooksDir,
    hooksNeedUpdate,
    installedHooksVer,
    latestHooksVer,
  }
}

/**
 * @param {string} agentsDir
 * @param {any} config
 */
function getDesignDocsUpdateState(agentsDir, config) {
  let designDocsDir = join(agentsDir, "design")
  let designDocsNeedUpdate = false
  let installedDesignDocsVer = null
  let latestDesignDocsVer = currentDesignDocsVersion()

  // Get project types from config
  let projectTypes = config?.project?.type ?? []
  if (!Array.isArray(projectTypes)) projectTypes = [projectTypes]

  if (existsSync(designDocsDir)) {
    installedDesignDocsVer = readDesignDocsVersionMarker(designDocsDir)
    if (installedDesignDocsVer !== null) {
      designDocsNeedUpdate = installedDesignDocsVer !== latestDesignDocsVer

      // Also check for missing eligible docs
      if (!designDocsNeedUpdate && projectTypes.length > 0) {
        for (let projectType of projectTypes) {
          let eligible = listEligibleDesignDocs(projectType)
          for (let doc of eligible) {
            if (!existsSync(join(designDocsDir, doc))) {
              designDocsNeedUpdate = true
              break
            }
          }
          if (designDocsNeedUpdate) break
        }
      }
    }
  } else {
    // Design docs directory doesn't exist - check if there are eligible docs
    for (let projectType of projectTypes) {
      if (listEligibleDesignDocs(projectType).length > 0) {
        designDocsNeedUpdate = true
        installedDesignDocsVer = "(none)"
        break
      }
    }
  }

  return {
    designDocsDir,
    designDocsNeedUpdate,
    installedDesignDocsVer,
    latestDesignDocsVer,
  }
}
