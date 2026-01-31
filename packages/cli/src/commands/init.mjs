import { checkbox, confirm, input } from "@inquirer/prompts"
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ExitError } from "../lib/errors.mjs"
import { copyWorkflowDocs, writeVersionMarker } from "../lib/docs.mjs"
import { renderAgentsMd } from "../lib/templates.mjs"

export const PROJECT_TYPES = ["api", "cli", "frontend", "library", "monorepo", "tui"]
export const AVAILABLE_TOOLS = ["beads", "maw", "crit", "botbus", "botty"]
export const REVIEWER_ROLES = ["security", "correctness"]

/**
 * @param {object} opts
 * @param {string} [opts.name]
 * @param {string} [opts.type]
 * @param {string} [opts.tools]
 * @param {string} [opts.reviewers]
 * @param {boolean} [opts.initBeads]
 * @param {boolean} [opts.force]
 * @param {boolean} [opts.interactive]
 */
export async function init(opts) {
  const interactive = opts.interactive !== false
  const projectDir = process.cwd()

  try {
    const name =
      opts.name ??
      (interactive
        ? await input({ message: "Project name:" })
        : missingFlag("--name"))

  const type =
    opts.type ??
    (interactive
      ? await checkbox({
          message: "Project type (select one or more):",
          choices: PROJECT_TYPES.map((t) => ({ value: t })),
          validate: (answer) =>
            answer.length > 0 ? true : "Select at least one project type",
        })
      : missingFlag("--type"))

  const types = Array.isArray(type) ? type : [type]
  const invalid = types.filter((t) => !PROJECT_TYPES.includes(t))
  if (invalid.length > 0) {
    throw new Error(
      `Unknown project type: ${invalid.join(", ")}. Valid: ${PROJECT_TYPES.join(", ")}`,
    )
  }

  let tools = AVAILABLE_TOOLS
  if (opts.tools) {
    tools = opts.tools.split(",").map((s) => s.trim())
    let invalid = tools.filter((t) => !AVAILABLE_TOOLS.includes(t))
    if (invalid.length > 0) {
      throw new Error(
        `Unknown tools: ${invalid.join(", ")}. Valid: ${AVAILABLE_TOOLS.join(", ")}`,
      )
    }
  } else if (interactive) {
    tools = await checkbox({
      message: "Tools to enable:",
      choices: AVAILABLE_TOOLS.map((t) => ({ value: t, checked: true })),
    })
  }

  /** @type {string[]} */
  let reviewers = []
  if (opts.reviewers) {
    reviewers = opts.reviewers.split(",").map((s) => s.trim())
    let invalid = reviewers.filter((r) => !REVIEWER_ROLES.includes(r))
    if (invalid.length > 0) {
      throw new Error(
        `Unknown reviewers: ${invalid.join(", ")}. Valid: ${REVIEWER_ROLES.join(", ")}`,
      )
    }
  } else if (interactive) {
    reviewers = await checkbox({
      message: "Reviewer roles:",
      choices: REVIEWER_ROLES.map((r) => ({ value: r })),
    })
  }

  const initBeads =
    opts.initBeads ??
    (interactive
      ? await confirm({ message: "Initialize beads?", default: true })
      : false)

  // Create .agents/botbox/
  const agentsDir = join(projectDir, ".agents", "botbox")
  mkdirSync(agentsDir, { recursive: true })
  console.log("Created .agents/botbox/")

  // Copy workflow docs
  copyWorkflowDocs(agentsDir)
  writeVersionMarker(agentsDir)
  console.log("Copied workflow docs")

  // Generate AGENTS.md
  const agentsMdPath = join(projectDir, "AGENTS.md")
  if (existsSync(agentsMdPath) && !opts.force) {
    console.warn(
      "AGENTS.md already exists. Use --force to overwrite, or run `botbox sync` to update.",
    )
  } else {
    const content = renderAgentsMd({ name, type: types, tools, reviewers })
    writeFileSync(agentsMdPath, content)
    console.log("Generated AGENTS.md")
  }

  // Symlink CLAUDE.md → AGENTS.md
  const claudeMdPath = join(projectDir, "CLAUDE.md")
  if (!existsSync(claudeMdPath)) {
    symlinkSync("AGENTS.md", claudeMdPath)
    console.log("Symlinked CLAUDE.md → AGENTS.md")
  }

  // Initialize beads
  if (initBeads && !tools.includes("beads")) {
    console.warn("Skipping beads init: beads not in tools list")
  } else if (initBeads && tools.includes("beads")) {
    const { execSync } = await import("node:child_process")
    try {
      execSync("br init", { cwd: projectDir, stdio: "inherit" })
      console.log("Initialized beads")
    } catch {
      console.warn("Warning: br init failed (is beads installed?)")
    }
  }

    console.log("Done.")
  } catch (err) {
    if (err.message?.includes("User force closed the prompt")) {
      throw new ExitError("Initialization cancelled")
    }
    throw err
  }
}

/**
 * @param {string} flag
 * @returns {never}
 */
function missingFlag(flag) {
  throw new Error(`${flag} is required in non-interactive mode`)
}
