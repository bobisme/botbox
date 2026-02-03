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
const SCRIPTS_DIR = join(__dirname, "..", "..", "scripts")
const VERSION_FILE = ".scripts-version"

/**
 * @typedef {object} ScriptEntry
 * @property {string} description
 * @property {(config: { tools: string[], reviewers: string[] }) => boolean} eligible
 */

/** @type {Record<string, ScriptEntry>} */
const SCRIPT_REGISTRY = {
  "agent-loop.mjs": {
    description: "Worker: sequential triage-start-work-finish",
    eligible: (config) =>
      ["beads", "maw", "crit", "botbus"].every((t) =>
        config.tools.includes(t),
      ),
  },
  "dev-loop.mjs": {
    description: "Lead dev: triage, parallel dispatch, merge",
    eligible: (config) =>
      ["beads", "maw", "crit", "botbus"].every((t) =>
        config.tools.includes(t),
      ),
  },
  "reviewer-loop.mjs": {
    description: "Reviewer: review loop until queue empty",
    eligible: (config) =>
      ["crit", "botbus"].every((t) => config.tools.includes(t)),
  },
}

/** @returns {string[]} List of .mjs filenames in the bundled scripts dir */
export function listAllScripts() {
  return readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".mjs"))
}

/**
 * Return scripts eligible for the given project config.
 * @param {{ tools: string[], reviewers: string[] }} config
 * @returns {string[]}
 */
export function listEligibleScripts(config) {
  return listAllScripts().filter((name) => {
    let entry = SCRIPT_REGISTRY[name]
    return entry ? entry.eligible(config) : false
  })
}

/**
 * Copy eligible scripts to a target directory, chmod +x.
 * @param {string} targetDir
 * @param {{ tools: string[], reviewers: string[] }} config
 * @returns {string[]} List of copied script filenames
 */
export function copyScripts(targetDir, config) {
  let eligible = listEligibleScripts(config)
  if (eligible.length === 0) {
    return []
  }

  mkdirSync(targetDir, { recursive: true })
  for (let file of eligible) {
    let dest = join(targetDir, file)
    copyFileSync(join(SCRIPTS_DIR, file), dest)
    chmodSync(dest, 0o755)
  }
  return eligible
}

/**
 * Re-copy scripts that already exist in the target dir (for sync).
 * @param {string} targetDir
 * @returns {string[]} List of updated script filenames
 */
export function updateExistingScripts(targetDir) {
  let updated = []
  for (let file of listAllScripts()) {
    let dest = join(targetDir, file)
    if (existsSync(dest)) {
      copyFileSync(join(SCRIPTS_DIR, file), dest)
      chmodSync(dest, 0o755)
      updated.push(file)
    }
  }
  return updated
}

/**
 * Compute a version hash from all bundled scripts.
 * @returns {string}
 */
export function currentScriptsVersion() {
  let hash = createHash("sha256")
  for (let file of listAllScripts().sort()) {
    hash.update(readFileSync(join(SCRIPTS_DIR, file)))
  }
  return hash.digest("hex").slice(0, 12)
}

/**
 * Write a scripts version marker to the target directory.
 * @param {string} targetDir
 */
export function writeScriptsVersionMarker(targetDir) {
  writeFileSync(join(targetDir, VERSION_FILE), currentScriptsVersion())
}

/**
 * Read the installed scripts version marker.
 * @param {string} targetDir
 * @returns {string | null}
 */
export function readScriptsVersionMarker(targetDir) {
  try {
    return readFileSync(join(targetDir, VERSION_FILE), "utf-8").trim()
  } catch {
    return null
  }
}
