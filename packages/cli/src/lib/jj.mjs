import { execSync } from "node:child_process"

/**
 * Check if the current directory is inside a jj repository.
 * @returns {boolean}
 */
export function isJjRepo() {
  try {
    execSync("jj root", { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/**
 * Check if the working copy has uncommitted changes.
 * @returns {boolean}
 */
export function hasUncommittedChanges() {
  try {
    let output = execSync("jj status", { encoding: "utf-8", stdio: "pipe" })
    // jj status shows "Working copy changes:" when there are changes
    return output.includes("Working copy changes:")
  } catch {
    return false
  }
}

/**
 * Get the current working copy's description (commit message).
 * @returns {string | null}
 */
export function getCurrentDescription() {
  try {
    let output = execSync('jj log -r @ --no-graph -T description', {
      encoding: "utf-8",
      stdio: "pipe",
    })
    return output.trim() || null
  } catch {
    return null
  }
}

/**
 * Commit the current working copy with a message.
 * This sets the commit message via `jj describe` and then creates
 * a new empty change with `jj new`.
 * @param {string} message - The commit message
 * @returns {boolean} - True if commit succeeded
 */
export function commit(message) {
  try {
    // Set the commit message
    execSync(`jj describe -m "${escapeShell(message)}"`, { stdio: "pipe" })
    // Create new change to finalize
    execSync("jj new", { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/**
 * Escape shell special characters in a string.
 * @param {string} str
 * @returns {string}
 */
function escapeShell(str) {
  return str.replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")
}
