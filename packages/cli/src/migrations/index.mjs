import { execSync } from "node:child_process"
import { existsSync, readdirSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { copyScripts, writeScriptsVersionMarker } from "../lib/scripts.mjs"

/**
 * @typedef {object} MigrationContext
 * @property {string} projectDir
 * @property {string} agentsDir
 * @property {string} configPath
 * @property {any} config
 * @property {(message: string) => void} log
 * @property {(message: string) => void} warn
 */

/**
 * @typedef {object} Migration
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {(ctx: MigrationContext) => void} up
 */

/** @type {Migration[]} */
export const migrations = [
  {
    id: "1.0.1",
    title: "Move loop scripts into .agents/botbox/scripts",
    description: "Migrates legacy scripts/ to managed location.",
    up(ctx) {
      let oldScriptsDir = join(ctx.projectDir, "scripts")
      let newScriptsDir = join(ctx.agentsDir, "scripts")

      if (!existsSync(oldScriptsDir)) {
        return
      }

      if (existsSync(newScriptsDir)) {
        ctx.warn(
          "Legacy scripts/ exists alongside .agents/botbox/scripts/. " +
            "Skipping move; remove scripts/ manually if no longer needed.",
        )
        return
      }

      try {
        renameSync(oldScriptsDir, newScriptsDir)
        ctx.log("Migrated scripts/ to .agents/botbox/scripts/")
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to move scripts: ${message}`)
      }
    },
  },
  {
    id: "1.0.2",
    title: "Replace .sh loop scripts with .mjs versions",
    description: "Removes legacy .sh scripts and installs new .mjs scripts.",
    up(ctx) {
      let scriptsDir = join(ctx.agentsDir, "scripts")

      if (!existsSync(scriptsDir)) {
        return
      }

      // Find and remove old .sh scripts
      let files = readdirSync(scriptsDir)
      let shScripts = files.filter((f) => f.endsWith(".sh"))

      for (let script of shScripts) {
        unlinkSync(join(scriptsDir, script))
        ctx.log(`Removed legacy script: ${script}`)
      }

      // Copy new .mjs scripts based on project config
      let tools = (ctx.config && ctx.config.tools) || {}
      let toolsList = Object.keys(tools).filter((t) => tools[t])
      let review = (ctx.config && ctx.config.review) || {}
      let reviewers = review.reviewers || []

      let copied = copyScripts(scriptsDir, { tools: toolsList, reviewers })
      if (copied.length > 0) {
        writeScriptsVersionMarker(scriptsDir)
        ctx.log(`Installed scripts: ${copied.join(", ")}`)
      }
    },
  },
  {
    id: "1.0.3",
    title: "Update botbus hooks from .sh to .mjs scripts",
    description: "Updates registered botbus hooks to use new .mjs script paths.",
    up(ctx) {
      // Check if botbus is available
      try {
        execSync("bus hooks list", { stdio: "pipe", env: process.env })
      } catch {
        ctx.log("Botbus not available, skipping hook migration")
        return
      }

      // Get hooks for this project
      let hooksJson
      try {
        hooksJson = execSync("bus hooks list --format json", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        })
      } catch {
        ctx.warn("Could not list hooks, skipping hook migration")
        return
      }

      let hooks
      try {
        let parsed = JSON.parse(hooksJson)
        hooks = Array.isArray(parsed) ? parsed : (parsed.hooks || [])
      } catch {
        ctx.warn("Could not parse hooks, skipping hook migration")
        return
      }

      // Find hooks for this project that use .sh scripts
      let projectHooks = hooks.filter(
        (/** @type {any} */ h) =>
          h.cwd === ctx.projectDir &&
          h.active &&
          Array.isArray(h.command) &&
          h.command.some((/** @type {string} */ c) => c.endsWith(".sh")),
      )

      if (projectHooks.length === 0) {
        return
      }

      let project = (ctx.config && ctx.config.project) || {}
      let name = project.name
      let agent = name ? `${name}-dev` : null

      for (let hook of projectHooks) {
        // Build new command by replacing .sh with .mjs and bash with bun
        // Special case: spawn-security-reviewer.sh -> reviewer-loop.mjs with args
        let isSpawnSecurityReviewer = hook.command.some(
          (/** @type {string} */ c) => c.includes("spawn-security-reviewer.sh"),
        )

        let newCommand = hook.command.map((/** @type {string} */ c) => {
          if (c === "bash") {
            return "bun"
          }
          if (c.includes("spawn-security-reviewer.sh")) {
            return c.replace("spawn-security-reviewer.sh", "reviewer-loop.mjs")
          }
          if (c.endsWith(".sh")) {
            return c.replace(/\.sh$/, ".mjs")
          }
          return c
        })

        // Add project and agent args for reviewer-loop.mjs if it was spawn-security-reviewer
        if (isSpawnSecurityReviewer && name) {
          // Derive reviewer agent name from mention condition
          let condition = hook.condition || {}
          let reviewerAgent = condition.agent ? condition.agent.replace(/^@/, "") : `${name}-security`
          newCommand.push(name, reviewerAgent)
        }

        // Remove old hook and re-add with updated command
        let removed = false
        try {
          execSync(`bus hooks remove ${hook.id}`, {
            stdio: "pipe",
            env: process.env,
          })
          removed = true
        } catch {
          ctx.warn(`Could not remove hook ${hook.id}, skipping`)
        }

        if (removed) {
          // Re-add with updated command
          let addCmd = ["bus", "hooks", "add"]
          if (agent) {
            addCmd.push("--agent", agent)
          }
          if (hook.channel) {
            addCmd.push("--channel", hook.channel)
          }
          if (hook.cwd) {
            addCmd.push("--cwd", hook.cwd)
          }
          let condition = hook.condition || {}
          if (condition.type === "claim_available" && condition.pattern) {
            addCmd.push("--claim", `"${condition.pattern}"`)
            // Derive claim_owner from pattern (agent://foo-dev → foo-dev)
            let claimOwner = hook.claim_owner || condition.pattern.replace(/^agent:\/\//, "")
            addCmd.push("--claim-owner", claimOwner)
            // Default TTL of 600s for claim-based hooks (bus hooks list doesn't include this)
            addCmd.push("--ttl", "600")
          }
          if (condition.type === "mention_received" && condition.agent) {
            // Strip @ prefix if present (botbus expects agent name without @)
            let mentionAgent = condition.agent.replace(/^@/, "")
            addCmd.push("--mention", `"${mentionAgent}"`)
          }
          addCmd.push("--", ...newCommand)

          try {
            execSync(addCmd.join(" "), {
              stdio: "pipe",
              env: process.env,
            })
            ctx.log(`Updated hook ${hook.id}: ${hook.command.join(" ")} → ${newCommand.join(" ")}`)
          } catch (error) {
            let message = error instanceof Error ? error.message : String(error)
            ctx.warn(`Could not re-add hook ${hook.id}: ${message}`)
          }
        }
      }
    },
  },
  {
    id: "1.0.4",
    title: "Add default_agent and channel to project config",
    description: "Adds project.default_agent and project.channel fields to .botbox.json.",
    up(ctx) {
      let project = (ctx.config && ctx.config.project) || {}
      let name = project.name

      if (!name) {
        ctx.warn("No project.name in config, skipping migration")
        return
      }

      let needsUpdate = false

      if (!project.default_agent) {
        project.default_agent = `${name}-dev`
        needsUpdate = true
      }

      if (!project.channel) {
        project.channel = name
        needsUpdate = true
      }

      if (needsUpdate) {
        ctx.config.project = project
        ctx.log(`Added default_agent: ${project.default_agent}, channel: ${project.channel}`)
      }
    },
  },
  {
    id: "1.0.5",
    title: "Add respond hook for @dev mentions",
    description: "Registers botbus hook for @<project>-dev mentions to enable conversational responses.",
    up(ctx) {
      // Check if botbus is available
      try {
        execSync("bus hooks list", { stdio: "pipe", env: process.env })
      } catch {
        ctx.log("Botbus not available, skipping respond hook registration")
        return
      }

      let project = (ctx.config && ctx.config.project) || {}
      let name = project.name
      if (!name) {
        ctx.warn("No project.name in config, skipping respond hook")
        return
      }

      let agent = `${name}-dev`

      // Check if respond hook already exists
      let hooksJson
      try {
        hooksJson = execSync("bus hooks list --format json", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        })
      } catch {
        ctx.warn("Could not list hooks, skipping respond hook")
        return
      }

      let hooks
      try {
        let parsed = JSON.parse(hooksJson)
        hooks = Array.isArray(parsed) ? parsed : (parsed.hooks || [])
      } catch {
        ctx.warn("Could not parse hooks, skipping respond hook")
        return
      }

      // Check for existing mention hook for dev agent (respond hook)
      let hasRespondHook = hooks.some(
        (/** @type {any} */ h) =>
          h.condition?.type === "mention_received" &&
          h.condition?.agent === agent &&
          h.active,
      )

      if (hasRespondHook) {
        ctx.log(`Respond hook for @${agent} already exists`)
        return
      }

      // Register respond hook
      let addCmd = [
        "bus", "hooks", "add",
        "--agent", agent,
        "--mention", `"${agent}"`,
        "--cwd", ctx.projectDir,
        "--release-on-exit",
        "--",
        "botty", "spawn", "--name", agent, "--cwd", ctx.projectDir,
        "--", "bun", ".agents/botbox/scripts/respond.mjs", name, agent,
      ]

      try {
        execSync(addCmd.join(" "), {
          stdio: "pipe",
          env: process.env,
        })
        ctx.log(`Registered respond hook for @${agent} mentions`)
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error)
        ctx.warn(`Could not register respond hook: ${message}`)
      }
    },
  },
  {
    id: "1.0.6",
    title: "Add --pass-env to botty spawn hooks",
    description: "Updates all botbus hooks using botty spawn to pass BOTBUS_* env vars.",
    up(ctx) {
      // Check if botbus is available
      try {
        execSync("bus hooks list", { stdio: "pipe", env: process.env })
      } catch {
        ctx.log("Botbus not available, skipping hook update")
        return
      }

      // Get all hooks
      let hooksJson
      try {
        hooksJson = execSync("bus hooks list --format json", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        })
      } catch {
        ctx.warn("Could not list hooks, skipping hook update")
        return
      }

      let hooks
      try {
        let parsed = JSON.parse(hooksJson)
        hooks = Array.isArray(parsed) ? parsed : (parsed.hooks || [])
      } catch {
        ctx.warn("Could not parse hooks, skipping hook update")
        return
      }

      // Find hooks for this project that use botty spawn without --pass-env
      let projectHooks = hooks.filter(
        (/** @type {any} */ h) =>
          h.cwd === ctx.projectDir &&
          h.active &&
          Array.isArray(h.command) &&
          h.command.includes("botty") &&
          h.command.includes("spawn") &&
          !h.command.includes("--pass-env"),
      )

      if (projectHooks.length === 0) {
        ctx.log("No hooks need updating")
        return
      }

      let project = (ctx.config && ctx.config.project) || {}
      let name = project.name
      let agent = name ? `${name}-dev` : null

      for (let hook of projectHooks) {
        // Build new command with --pass-env inserted after "spawn"
        let newCommand = []
        for (let i = 0; i < hook.command.length; i++) {
          newCommand.push(hook.command[i])
          if (hook.command[i] === "spawn") {
            newCommand.push("--pass-env", "BOTBUS_CHANNEL,BOTBUS_MESSAGE_ID,BOTBUS_AGENT,BOTBUS_HOOK_ID")
          }
        }

        // Remove old hook and re-add with updated command
        let removed = false
        try {
          execSync(`bus hooks remove ${hook.id}`, {
            stdio: "pipe",
            env: process.env,
          })
          removed = true
        } catch {
          ctx.warn(`Could not remove hook ${hook.id}, skipping`)
        }

        if (removed) {
          // Re-add with updated command
          let addCmd = ["bus", "hooks", "add"]
          if (agent) {
            addCmd.push("--agent", agent)
          }
          if (hook.channel) {
            // Quote to prevent shell glob expansion (e.g., "*")
            addCmd.push("--channel", `"${hook.channel}"`)
          }
          if (hook.cwd) {
            addCmd.push("--cwd", hook.cwd)
          }
          let condition = hook.condition || {}
          if (condition.type === "claim_available" && condition.pattern) {
            addCmd.push("--claim", `"${condition.pattern}"`)
            let claimOwner = hook.claim_owner || condition.pattern.replace(/^agent:\/\//, "")
            addCmd.push("--claim-owner", claimOwner)
            addCmd.push("--ttl", "600")
          }
          if (condition.type === "mention_received" && condition.agent) {
            let mentionAgent = condition.agent.replace(/^@/, "")
            addCmd.push("--mention", `"${mentionAgent}"`)
            addCmd.push("--release-on-exit")
          }
          addCmd.push("--", ...newCommand)

          try {
            execSync(addCmd.join(" "), {
              stdio: "pipe",
              env: process.env,
            })
            ctx.log(`Updated hook ${hook.id}: added --pass-env`)
          } catch (error) {
            let message = error instanceof Error ? error.message : String(error)
            ctx.warn(`Could not re-add hook ${hook.id}: ${message}`)
          }
        }
      }
    },
  },
  {
    id: "1.0.7",
    title: "Set priority on mention hooks",
    description: "Sets priority 1 on mention-based hooks so claim-based hooks (priority 0) run first.",
    up(ctx) {
      // Check if botbus is available
      try {
        execSync("bus hooks list", { stdio: "pipe", env: process.env })
      } catch {
        ctx.log("Botbus not available, skipping hook priority migration")
        return
      }

      // Get all hooks
      let hooksJson
      try {
        hooksJson = execSync("bus hooks list --format json", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        })
      } catch {
        ctx.warn("Could not list hooks, skipping hook priority migration")
        return
      }

      let hooks
      try {
        let parsed = JSON.parse(hooksJson)
        hooks = Array.isArray(parsed) ? parsed : (parsed.hooks || [])
      } catch {
        ctx.warn("Could not parse hooks, skipping hook priority migration")
        return
      }

      // Find mention hooks for this project that still have default priority (0)
      let mentionHooks = hooks.filter(
        (/** @type {any} */ h) =>
          h.cwd === ctx.projectDir &&
          h.active &&
          h.condition?.type === "mention_received" &&
          (h.priority === 0 || h.priority === undefined),
      )

      if (mentionHooks.length === 0) {
        ctx.log("No mention hooks need priority update")
        return
      }

      let project = (ctx.config && ctx.config.project) || {}
      let name = project.name
      let agent = name ? `${name}-dev` : null

      for (let hook of mentionHooks) {
        // Remove old hook and re-add with priority 1
        let removed = false
        try {
          execSync(`bus hooks remove ${hook.id}`, {
            stdio: "pipe",
            env: process.env,
          })
          removed = true
        } catch {
          ctx.warn(`Could not remove hook ${hook.id}, skipping`)
        }

        if (removed) {
          let addCmd = ["bus", "hooks", "add"]
          if (agent) {
            addCmd.push("--agent", agent)
          }
          if (hook.channel) {
            addCmd.push("--channel", `"${hook.channel}"`)
          }
          let condition = hook.condition || {}
          let mentionAgent = condition.agent.replace(/^@/, "")
          addCmd.push("--mention", `"${mentionAgent}"`)
          addCmd.push("--priority", "1")
          if (hook.cwd) {
            addCmd.push("--cwd", hook.cwd)
          }
          // Preserve release-on-exit if the hook had a TTL (mention hooks from 1.0.5+)
          addCmd.push("--release-on-exit")
          addCmd.push("--", ...hook.command)

          try {
            execSync(addCmd.join(" "), {
              stdio: "pipe",
              env: process.env,
            })
            ctx.log(`Updated hook ${hook.id}: set priority 1 for @${mentionAgent}`)
          } catch (error) {
            let message = error instanceof Error ? error.message : String(error)
            ctx.warn(`Could not re-add hook ${hook.id}: ${message}`)
          }
        }
      }
    },
  },
  {
    id: "1.0.8",
    title: "Add claim guards to mention hooks",
    description: "Adds --claim agent://... to mention-based hooks so they don't fire when the agent claim is already held.",
    up(ctx) {
      // Check if botbus is available
      try {
        execSync("bus hooks list", { stdio: "pipe", env: process.env })
      } catch {
        ctx.log("Botbus not available, skipping mention hook claim migration")
        return
      }

      let hooksJson
      try {
        hooksJson = execSync("bus hooks list --format json", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        })
      } catch {
        ctx.warn("Could not list hooks, skipping mention hook claim migration")
        return
      }

      let hooks
      try {
        let parsed = JSON.parse(hooksJson)
        hooks = Array.isArray(parsed) ? parsed : (parsed.hooks || [])
      } catch {
        ctx.warn("Could not parse hooks, skipping mention hook claim migration")
        return
      }

      // Find mention hooks for this project that don't have a claim guard
      let mentionHooks = hooks.filter(
        (/** @type {any} */ h) =>
          h.cwd === ctx.projectDir &&
          h.active &&
          h.condition?.type === "mention_received" &&
          !h.claim_pattern,
      )

      if (mentionHooks.length === 0) {
        ctx.log("No mention hooks need claim guards")
        return
      }

      let project = (ctx.config && ctx.config.project) || {}
      let name = project.name
      let agent = name ? `${name}-dev` : null

      for (let hook of mentionHooks) {
        let condition = hook.condition || {}
        let mentionAgent = condition.agent.replace(/^@/, "")

        let removed = false
        try {
          execSync(`bus hooks remove ${hook.id}`, {
            stdio: "pipe",
            env: process.env,
          })
          removed = true
        } catch {
          ctx.warn(`Could not remove hook ${hook.id}, skipping`)
        }

        if (removed) {
          let addCmd = ["bus", "hooks", "add"]
          if (agent) {
            addCmd.push("--agent", agent)
          }
          if (hook.channel) {
            addCmd.push("--channel", `"${hook.channel}"`)
          }
          addCmd.push("--mention", `"${mentionAgent}"`)
          addCmd.push("--claim", `"agent://${mentionAgent}"`)
          addCmd.push("--claim-owner", mentionAgent)
          addCmd.push("--ttl", "600")
          addCmd.push("--priority", String(hook.priority ?? 1))
          if (hook.cwd) {
            addCmd.push("--cwd", hook.cwd)
          }
          addCmd.push("--", ...hook.command)

          try {
            execSync(addCmd.join(" "), {
              stdio: "pipe",
              env: process.env,
            })
            ctx.log(`Updated hook ${hook.id}: added claim guard for @${mentionAgent}`)
          } catch (error) {
            let message = error instanceof Error ? error.message : String(error)
            ctx.warn(`Could not re-add hook ${hook.id}: ${message}`)
          }
        }
      }
    },
  },
  {
    id: "1.0.9",
    title: "Replace --pass-env with --env-inherit in botty spawn hooks",
    description: "Updates hook commands from --pass-env to --env-inherit to match current botty CLI.",
    up(ctx) {
      // Check if botbus is available
      try {
        execSync("bus hooks list", { stdio: "pipe", env: process.env })
      } catch {
        ctx.log("Botbus not available, skipping env-inherit migration")
        return
      }

      let hooksJson
      try {
        hooksJson = execSync("bus hooks list --format json", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        })
      } catch {
        ctx.warn("Could not list hooks, skipping env-inherit migration")
        return
      }

      let hooks
      try {
        let parsed = JSON.parse(hooksJson)
        hooks = Array.isArray(parsed) ? parsed : (parsed.hooks || [])
      } catch {
        ctx.warn("Could not parse hooks, skipping env-inherit migration")
        return
      }

      // Find hooks for this project that still use --pass-env
      let passEnvHooks = hooks.filter(
        (/** @type {any} */ h) =>
          h.cwd === ctx.projectDir &&
          h.active &&
          Array.isArray(h.command) &&
          h.command.includes("--pass-env"),
      )

      if (passEnvHooks.length === 0) {
        ctx.log("No hooks need --env-inherit update")
        return
      }

      let project = (ctx.config && ctx.config.project) || {}
      let name = project.name
      let agent = name ? `${name}-dev` : null

      for (let hook of passEnvHooks) {
        // Build new command with --pass-env replaced by --env-inherit
        let newCommand = hook.command.map(
          (/** @type {string} */ c) => (c === "--pass-env" ? "--env-inherit" : c),
        )

        let removed = false
        try {
          execSync(`bus hooks remove ${hook.id}`, {
            stdio: "pipe",
            env: process.env,
          })
          removed = true
        } catch {
          ctx.warn(`Could not remove hook ${hook.id}, skipping`)
        }

        if (removed) {
          // Reconstruct add command preserving all hook properties
          let addCmd = ["bus", "hooks", "add"]
          if (agent) {
            addCmd.push("--agent", agent)
          }
          if (hook.channel) {
            addCmd.push("--channel", `"${hook.channel}"`)
          }
          if (hook.cwd) {
            addCmd.push("--cwd", hook.cwd)
          }
          let condition = hook.condition || {}
          if (condition.type === "claim_available" && condition.pattern) {
            addCmd.push("--claim", `"${condition.pattern}"`)
            let claimOwner = hook.claim_owner || condition.pattern.replace(/^agent:\/\//, "")
            addCmd.push("--claim-owner", claimOwner)
            addCmd.push("--ttl", "600")
          }
          if (condition.type === "mention_received" && condition.agent) {
            let mentionAgent = condition.agent.replace(/^@/, "")
            addCmd.push("--mention", `"${mentionAgent}"`)
            if (hook.claim_pattern) {
              addCmd.push("--claim", `"${hook.claim_pattern}"`)
            }
            let claimOwner = hook.claim_owner || mentionAgent
            addCmd.push("--claim-owner", claimOwner)
            addCmd.push("--ttl", "600")
          }
          addCmd.push("--priority", String(hook.priority ?? 0))
          addCmd.push("--", ...newCommand)

          try {
            execSync(addCmd.join(" "), {
              stdio: "pipe",
              env: process.env,
            })
            ctx.log(`Updated hook ${hook.id}: --pass-env → --env-inherit`)
          } catch (error) {
            let message = error instanceof Error ? error.message : String(error)
            ctx.warn(`Could not re-add hook ${hook.id}: ${message}`)
            // Try to restore the old hook
            try {
              let restoreCmd = ["bus", "hooks", "add"]
              if (agent) restoreCmd.push("--agent", agent)
              if (hook.channel) restoreCmd.push("--channel", `"${hook.channel}"`)
              if (hook.cwd) restoreCmd.push("--cwd", hook.cwd)
              if (condition.type === "claim_available" && condition.pattern) {
                restoreCmd.push("--claim", `"${condition.pattern}"`)
                let claimOwner = hook.claim_owner || condition.pattern.replace(/^agent:\/\//, "")
                restoreCmd.push("--claim-owner", claimOwner)
                restoreCmd.push("--ttl", "600")
              }
              if (condition.type === "mention_received" && condition.agent) {
                let mentionAgent = condition.agent.replace(/^@/, "")
                restoreCmd.push("--mention", `"${mentionAgent}"`)
                if (hook.claim_pattern) restoreCmd.push("--claim", `"${hook.claim_pattern}"`)
                let claimOwner = hook.claim_owner || mentionAgent
                restoreCmd.push("--claim-owner", claimOwner)
                restoreCmd.push("--ttl", "600")
              }
              restoreCmd.push("--priority", String(hook.priority ?? 0))
              restoreCmd.push("--", ...hook.command)
              execSync(restoreCmd.join(" "), { stdio: "pipe", env: process.env })
              ctx.warn(`Restored original hook ${hook.id}`)
            } catch {
              ctx.warn(`CRITICAL: Could not restore hook ${hook.id} — manual re-add required`)
            }
          }
        }
      }
    },
  },
  {
    id: "1.0.10",
    title: "Rename snake_case config keys to camelCase",
    description: "Renames project.default_agent → project.defaultAgent and agents.*.max_loops → agents.*.maxLoops in .botbox.json.",
    up(ctx) {
      let config = ctx.config
      if (!config) return

      let changed = false

      // project.default_agent → project.defaultAgent
      let project = config.project || {}
      if (project.default_agent && !project.defaultAgent) {
        project.defaultAgent = project.default_agent
        delete project.default_agent
        changed = true
      }

      // agents.*.max_loops → agents.*.maxLoops
      let agents = config.agents || {}
      for (let [role, settings] of Object.entries(agents)) {
        let s = /** @type {any} */ (settings)
        if (s.max_loops !== undefined && s.maxLoops === undefined) {
          s.maxLoops = s.max_loops
          delete s.max_loops
          changed = true
        }
      }

      if (changed) {
        ctx.log("Renamed snake_case keys to camelCase (default_agent → defaultAgent, max_loops → maxLoops)")
      } else {
        ctx.log("No snake_case keys to rename")
      }
    },
  },
]

/**
 * @param {string} version
 * @returns {number[]}
 */
function parseVersion(version) {
  let parts = version.split(".")
  return parts.map((part) => Number(part) || 0)
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareVersions(left, right) {
  let leftParts = parseVersion(left)
  let rightParts = parseVersion(right)
  let length = Math.max(leftParts.length, rightParts.length)

  for (let i = 0; i < length; i += 1) {
    let leftValue = leftParts[i] ?? 0
    let rightValue = rightParts[i] ?? 0

    if (leftValue > rightValue) {
      return 1
    }
    if (leftValue < rightValue) {
      return -1
    }
  }

  return 0
}

/** @returns {string} */
export function currentMigrationVersion() {
  if (migrations.length === 0) {
    return "0.0.0"
  }

  let versions = migrations.map((migration) => migration.id)
  versions.sort(compareVersions)
  // Safe: we already checked migrations.length > 0
  return /** @type {string} */ (versions[versions.length - 1])
}

/**
 * @param {string} installedVersion
 * @returns {Migration[]}
 */
export function getPendingMigrations(installedVersion) {
  let sorted = [...migrations].sort((left, right) =>
    compareVersions(left.id, right.id),
  )
  return sorted.filter(
    (migration) => compareVersions(migration.id, installedVersion) > 0,
  )
}
