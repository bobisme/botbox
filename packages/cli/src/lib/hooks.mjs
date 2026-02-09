import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOKS_DIR = join(__dirname, "..", "..", "hooks")
const VERSION_FILE = ".hooks-version"

/**
 * @typedef {object} HookEntry
 * @property {string | string[]} event - Claude Code hook event(s) (SessionStart, PostToolUse, etc.)
 * @property {string} description
 * @property {(config: { tools: string[] }) => boolean} eligible
 */

/** @type {Record<string, HookEntry>} */
const HOOK_REGISTRY = {
  "init-agent.sh": {
    event: ["SessionStart", "PreCompact"],
    description: "Display agent identity from .botbox.json",
    eligible: (config) => config.tools.includes("botbus"),
  },
  "check-jj.sh": {
    event: ["SessionStart", "PreCompact"],
    description: "Remind agent to use jj commands in jj repos",
    eligible: (config) => config.tools.includes("maw"),
  },
  "check-bus-inbox.sh": {
    event: "PostToolUse",
    description: "Check for unread bus messages",
    eligible: (config) => config.tools.includes("botbus"),
  },
  "claim-agent.sh": {
    event: ["SessionStart", "PostToolUse"],
    description: "Claim and refresh agent:// advisory lock",
    eligible: (config) => config.tools.includes("botbus"),
  },
}

/** @returns {string[]} List of hook filenames in the bundled hooks dir */
export function listAllHooks() {
  if (!existsSync(HOOKS_DIR)) {
    return []
  }
  return readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".sh"))
}

/**
 * Return hooks eligible for the given project config.
 * @param {{ tools: string[] }} config
 * @returns {string[]}
 */
export function listEligibleHooks(config) {
  return listAllHooks().filter((name) => {
    let entry = HOOK_REGISTRY[name]
    return entry ? entry.eligible(config) : false
  })
}

/**
 * Get the hook registry entry for a hook filename.
 * @param {string} hookName
 * @returns {HookEntry | undefined}
 */
export function getHookEntry(hookName) {
  return HOOK_REGISTRY[hookName]
}

/**
 * Copy eligible hooks to a target directory, chmod +x.
 * @param {string} targetDir
 * @param {{ tools: string[] }} config
 * @returns {string[]} List of copied hook filenames
 */
export function copyHooks(targetDir, config) {
  let eligible = listEligibleHooks(config)
  if (eligible.length === 0) {
    return []
  }

  mkdirSync(targetDir, { recursive: true })
  for (let file of eligible) {
    let dest = join(targetDir, file)
    copyFileSync(join(HOOKS_DIR, file), dest)
    chmodSync(dest, 0o755)
  }
  return eligible
}

/**
 * Re-copy hooks that already exist in the target dir (for sync).
 * @param {string} targetDir
 * @returns {string[]} List of updated hook filenames
 */
export function updateExistingHooks(targetDir) {
  let updated = []
  for (let file of listAllHooks()) {
    let dest = join(targetDir, file)
    if (existsSync(dest)) {
      copyFileSync(join(HOOKS_DIR, file), dest)
      chmodSync(dest, 0o755)
      updated.push(file)
    }
  }
  return updated
}

/**
 * Sync hooks: update existing and add newly eligible ones (like syncScripts).
 * @param {string} targetDir
 * @param {{ tools: string[] }} config
 * @returns {{ updated: string[], added: string[] }}
 */
export function syncHooks(targetDir, config) {
  let updated = []
  let added = []
  let eligible = listEligibleHooks(config)

  if (eligible.length > 0 && !existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  for (let file of eligible) {
    let dest = join(targetDir, file)
    let existed = existsSync(dest)
    copyFileSync(join(HOOKS_DIR, file), dest)
    chmodSync(dest, 0o755)
    if (existed) {
      updated.push(file)
    } else {
      added.push(file)
    }
  }

  return { updated, added }
}

/**
 * Compute a version hash from all bundled hooks.
 * @returns {string}
 */
export function currentHooksVersion() {
  let hash = createHash("sha256")
  let hooks = listAllHooks().sort()
  if (hooks.length === 0) {
    return "000000000000"
  }
  for (let file of hooks) {
    hash.update(readFileSync(join(HOOKS_DIR, file)))
  }
  return hash.digest("hex").slice(0, 12)
}

/**
 * Write a hooks version marker to the target directory.
 * @param {string} targetDir
 */
export function writeHooksVersionMarker(targetDir) {
  writeFileSync(join(targetDir, VERSION_FILE), currentHooksVersion())
}

/**
 * Read the installed hooks version marker.
 * @param {string} targetDir
 * @returns {string | null}
 */
export function readHooksVersionMarker(targetDir) {
  try {
    return readFileSync(join(targetDir, VERSION_FILE), "utf-8").trim()
  } catch {
    return null
  }
}

/**
 * Generate Claude Code settings.json hooks config for installed hooks.
 * Uses the new format with matchers: {"event": [{"matcher": {...}, "hooks": [...]}]}
 * @param {string} hooksDir - Absolute path to hooks directory
 * @param {string[]} hookNames - Names of installed hooks
 * @returns {object} Hooks configuration for settings.json
 */
export function generateHooksConfig(hooksDir, hookNames) {
  let hooks = {}

  for (let hookName of hookNames) {
    let entry = HOOK_REGISTRY[hookName]
    if (!entry) continue

    let events = Array.isArray(entry.event) ? entry.event : [entry.event]

    for (let event of events) {
      if (!hooks[event]) {
        hooks[event] = []
      }

      // New format: each entry has a matcher and hooks array
      hooks[event].push({
        matcher: "",  // Empty string matches all
        hooks: [
          {
            type: "command",
            command: join(hooksDir, hookName),
          },
        ],
      })
    }
  }

  return hooks
}
