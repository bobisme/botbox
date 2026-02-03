import { createHash } from "node:crypto"
import {
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
const PROMPTS_DIR = join(__dirname, "..", "..", "prompts")
const VERSION_FILE = ".prompts-version"

/**
 * List all prompt template files in the bundled prompts dir.
 * @returns {string[]}
 */
export function listAllPrompts() {
  if (!existsSync(PROMPTS_DIR)) {
    return []
  }
  return readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"))
}

/**
 * Copy all prompt templates to a target directory.
 * @param {string} targetDir
 * @returns {string[]} List of copied prompt filenames
 */
export function copyPrompts(targetDir) {
  let prompts = listAllPrompts()
  if (prompts.length === 0) {
    return []
  }

  mkdirSync(targetDir, { recursive: true })
  for (let file of prompts) {
    copyFileSync(join(PROMPTS_DIR, file), join(targetDir, file))
  }
  return prompts
}

/**
 * Compute a version hash from all bundled prompts.
 * @returns {string}
 */
export function currentPromptsVersion() {
  let hash = createHash("sha256")
  for (let file of listAllPrompts().sort()) {
    hash.update(readFileSync(join(PROMPTS_DIR, file)))
  }
  return hash.digest("hex").slice(0, 12)
}

/**
 * Write a prompts version marker to the target directory.
 * @param {string} targetDir
 */
export function writePromptsVersionMarker(targetDir) {
  writeFileSync(join(targetDir, VERSION_FILE), currentPromptsVersion())
}

/**
 * Read the installed prompts version marker.
 * @param {string} targetDir
 * @returns {string | null}
 */
export function readPromptsVersionMarker(targetDir) {
  try {
    return readFileSync(join(targetDir, VERSION_FILE), "utf-8").trim()
  } catch {
    return null
  }
}

/**
 * Load a prompt template and substitute variables.
 * @param {string} promptName - Name without extension (e.g., "reviewer", "reviewer-security")
 * @param {Record<string, string>} variables - Variables to substitute (e.g., { AGENT: "foo", PROJECT: "bar" })
 * @param {string} [promptsDir] - Directory to load from (defaults to bundled prompts)
 * @returns {string}
 */
export function loadPrompt(promptName, variables, promptsDir) {
  let dir = promptsDir || PROMPTS_DIR
  let filePath = join(dir, `${promptName}.md`)

  if (!existsSync(filePath)) {
    throw new Error(`Prompt template not found: ${filePath}`)
  }

  let template = readFileSync(filePath, "utf-8")

  // Simple {{VARIABLE}} substitution
  for (let [key, value] of Object.entries(variables)) {
    let pattern = new RegExp(`\\{\\{${key}\\}\\}`, "g")
    template = template.replace(pattern, value)
  }

  return template
}

/**
 * Derive the reviewer role from an agent name.
 * e.g., "myproject-security" -> "security", "myproject-dev" -> null
 * @param {string} agentName
 * @param {string[]} knownRoles - List of known reviewer roles
 * @returns {string | null}
 */
export function deriveRoleFromAgentName(agentName, knownRoles = ["security"]) {
  for (let role of knownRoles) {
    if (agentName.endsWith(`-${role}`)) {
      return role
    }
  }
  return null
}

/**
 * Get the prompt name for a reviewer based on role.
 * @param {string | null} role
 * @returns {string}
 */
export function getReviewerPromptName(role) {
  if (role) {
    return `reviewer-${role}`
  }
  return "reviewer"
}
