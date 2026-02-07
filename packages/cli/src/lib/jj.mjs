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
 *
 * When called without paths, this commits all changes (describe + new).
 * When called with paths, only the specified files are included in the
 * commit — other working copy changes remain in the new working copy.
 * This uses `jj commit -m <message> <paths...>` which splits out just
 * the named files.
 *
 * @param {string} message - The commit message
 * @param {string[]} [paths] - Optional list of file paths to include (relative to repo root)
 * @returns {boolean} - True if commit succeeded
 */
export function commit(message, paths) {
  try {
    if (paths && paths.length > 0) {
      // Use jj commit with file arguments — only the specified files
      // go into the committed change; everything else stays in the
      // new working copy on top.
      let quotedPaths = paths.map((p) => `"${escapeShell(p)}"`).join(" ")
      execSync(`jj commit -m "${escapeShell(message)}" ${quotedPaths}`, {
        stdio: "pipe",
      })
    } else {
      // No paths specified — commit everything (original behavior)
      execSync(`jj describe -m "${escapeShell(message)}"`, { stdio: "pipe" })
      execSync("jj new", { stdio: "pipe" })
    }
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
