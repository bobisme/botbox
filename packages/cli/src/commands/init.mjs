import { checkbox, confirm, input } from "@inquirer/prompts"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { ExitError } from "../lib/errors.mjs"
import { copyWorkflowDocs, writeVersionMarker } from "../lib/docs.mjs"
import { copyScripts, writeScriptsVersionMarker } from "../lib/scripts.mjs"
import { parseAgentsMdHeader, renderAgentsMd } from "../lib/templates.mjs"

export const PROJECT_TYPES = ["api", "cli", "frontend", "library", "monorepo", "tui"]
export const AVAILABLE_TOOLS = ["beads", "maw", "crit", "botbus", "botty"]
export const REVIEWER_ROLES = ["security", "correctness"]
export const LANGUAGES = ["rust", "python", "node", "go", "typescript", "java"]

/**
 * @param {object} opts
 * @param {string} [opts.name]
 * @param {string} [opts.type]
 * @param {string} [opts.tools]
 * @param {string} [opts.reviewers]
 * @param {string} [opts.language]
 * @param {boolean} [opts.initBeads]
 * @param {boolean} [opts.seedWork]
 * @param {boolean} [opts.force]
 * @param {boolean} [opts.interactive]
 */
export async function init(opts) {
  const interactive = opts.interactive !== false
  const projectDir = process.cwd()

  try {
    // Detect existing config from AGENTS.md on re-init
    const agentsDir = join(projectDir, ".agents", "botbox")
    const agentsMdPath = join(projectDir, "AGENTS.md")
    const isReinit = existsSync(agentsDir)

    /** @type {import("../lib/templates.mjs").DetectedConfig} */
    let detected = {}
    if (isReinit && existsSync(agentsMdPath)) {
      detected = parseAgentsMdHeader(readFileSync(agentsMdPath, "utf-8"))
    }

    const name =
      opts.name ??
      (interactive
        ? await input({ message: "Project name:", default: detected.name })
        : detected.name ?? missingFlag("--name"))

  const type =
    opts.type ??
    (interactive
      ? await checkbox({
          message: "Project type (select one or more):",
          choices: PROJECT_TYPES.map((t) => ({
            value: t,
            checked: detected.type ? detected.type.includes(t) : false,
          })),
          validate: (answer) =>
            answer.length > 0 ? true : "Select at least one project type",
        })
      : detected.type ?? missingFlag("--type"))

  const types = Array.isArray(type) ? type : [type]
  const invalid = types.filter((t) => !PROJECT_TYPES.includes(t))
  if (invalid.length > 0) {
    throw new Error(
      `Unknown project type: ${invalid.join(", ")}. Valid: ${PROJECT_TYPES.join(", ")}`,
    )
  }

  /** @type {string[]} */
  let tools
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
      choices: AVAILABLE_TOOLS.map((t) => ({
        value: t,
        checked: detected.tools ? detected.tools.includes(t) : true,
      })),
    })
  } else {
    tools = detected.tools ?? AVAILABLE_TOOLS
  }

  /** @type {string[]} */
  let reviewers
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
      choices: REVIEWER_ROLES.map((r) => ({
        value: r,
        checked: detected.reviewers ? detected.reviewers.includes(r) : false,
      })),
    })
  } else {
    reviewers = detected.reviewers ?? []
  }

  /** @type {string[]} */
  let languages = []
  if (opts.language) {
    languages = opts.language.split(",").map((s) => s.trim())
    let invalid = languages.filter((l) => !LANGUAGES.includes(l))
    if (invalid.length > 0) {
      throw new Error(
        `Unknown languages: ${invalid.join(", ")}. Valid: ${LANGUAGES.join(", ")}`,
      )
    }
  } else if (interactive) {
    languages = await checkbox({
      message: "Languages/frameworks (for .gitignore generation):",
      choices: LANGUAGES.map((l) => ({ value: l })),
    })
  }

  const initBeads =
    opts.initBeads ??
    (interactive
      ? await confirm({ message: "Initialize beads?", default: true })
      : false)

  const seedWork =
    opts.seedWork ??
    (interactive
      ? await confirm({ message: "Seed initial work beads?", default: false })
      : false)

  // Create .agents/botbox/
  mkdirSync(agentsDir, { recursive: true })
  console.log("Created .agents/botbox/")

  // Copy workflow docs
  copyWorkflowDocs(agentsDir)
  writeVersionMarker(agentsDir)
  console.log("Copied workflow docs")

  // Copy loop scripts
  let scriptsDir = join(projectDir, "scripts")
  let copied = copyScripts(scriptsDir, { tools, reviewers })
  if (copied.length > 0) {
    writeScriptsVersionMarker(scriptsDir)
    console.log(`Copied loop scripts: ${copied.join(", ")}`)
  }

  // Generate AGENTS.md
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
      execSync("br init", { cwd: projectDir, stdio: "inherit", env: process.env })
      console.log("Initialized beads")
    } catch {
      console.warn("Warning: br init failed (is beads installed?)")
    }
  }

  // Initialize maw (jj + .workspaces/ gitignore)
  if (tools.includes("maw")) {
    const { execSync } = await import("node:child_process")
    try {
      execSync("maw init", { cwd: projectDir, stdio: "inherit", env: process.env })
      console.log("Initialized maw (jj)")
    } catch {
      console.warn("Warning: maw init failed (is maw installed?)")
    }
  }

  // Initialize crit (code review)
  if (tools.includes("crit")) {
    const { execSync } = await import("node:child_process")
    try {
      execSync("crit init", { cwd: projectDir, stdio: "inherit", env: process.env })
      console.log("Initialized crit")
    } catch {
      console.warn("Warning: crit init failed (is crit installed?)")
    }
  }

  // Register project on botbus #projects channel (skip on re-init)
  if (tools.includes("botbus") && !isReinit) {
    const { execSync } = await import("node:child_process")
    let absPath = resolve(projectDir)
    let toolsList = tools.join(", ")
    try {
      execSync(
        `bus send --agent ${name}-dev projects "project: ${name}  repo: ${absPath}  lead: ${name}-dev  tools: ${toolsList}" -L project-registry`,
        { cwd: projectDir, stdio: "inherit", env: process.env },
      )
      console.log("Registered project on #projects channel")
    } catch {
      console.warn("Warning: Failed to register on #projects (is bus installed?)")
    }
  }

  // Seed initial work beads
  if (seedWork && !tools.includes("beads")) {
    console.warn("Skipping seed work: beads not in tools list")
  } else if (seedWork && tools.includes("beads")) {
    let beadsCreated = await seedInitialBeads(projectDir, name, types)
    if (beadsCreated > 0) {
      console.log(`Created ${beadsCreated} seed bead${beadsCreated > 1 ? "s" : ""}`)
    }
  }

  // Register auto-spawn hook for the project channel
  if (tools.includes("botbus")) {
    await registerSpawnHook(projectDir, name)
  }

  // Generate .gitignore
  const gitignorePath = join(projectDir, ".gitignore")
  if (languages.length > 0 && !existsSync(gitignorePath)) {
    try {
      const gitignoreContent = await fetchGitignore(languages)
      writeFileSync(gitignorePath, gitignoreContent)
      console.log(`Generated .gitignore for: ${languages.join(", ")}`)
    } catch (err) {
      console.warn(`Warning: Failed to generate .gitignore: ${err.message}`)
    }
  } else if (languages.length > 0 && existsSync(gitignorePath)) {
    console.log(".gitignore already exists, skipping generation")
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

/**
 * Register an auto-spawn hook so the dev agent starts when messages arrive.
 * @param {string} projectDir - Project root directory
 * @param {string} name - Project name
 */
async function registerSpawnHook(projectDir, name) {
  let { execSync } = await import("node:child_process")
  let absPath = resolve(projectDir)
  let agent = `${name}-dev`

  // Check if bus supports hooks
  try {
    execSync("bus hooks list", { stdio: "pipe", env: process.env })
  } catch {
    // bus doesn't support hooks or isn't installed
    return
  }

  // Check for existing hook on this channel to avoid duplicates
  try {
    let existing = execSync("bus hooks list --format json", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })
    let hooks = JSON.parse(existing)
    let arr = Array.isArray(hooks) ? hooks : hooks.hooks ?? []
    if (arr.some((/** @type {any} */ h) => h.channel === name && h.active)) {
      console.log("Auto-spawn hook already exists, skipping")
      return
    }
  } catch {
    // Parse failure — proceed to add
  }

  try {
    execSync(
      `bus hooks add --agent ${agent} --channel ${name} --claim "agent://${agent}" --claim-owner ${agent} --cwd ${absPath} --ttl 600 -- botty spawn --name ${agent} -- bash scripts/dev-loop.sh ${name} ${agent}`,
      { cwd: projectDir, stdio: "inherit", env: process.env },
    )
    console.log("Registered auto-spawn hook for dev agent")
  } catch {
    console.warn("Warning: Failed to register auto-spawn hook")
  }
}

/**
 * Scout the repo and create initial beads for work items.
 * @param {string} projectDir - Project root directory
 * @param {string} name - Project name
 * @param {string[]} types - Project types
 * @returns {Promise<number>} Number of beads created
 */
async function seedInitialBeads(projectDir, name, types) {
  let { execSync } = await import("node:child_process")
  let agent = `${name}-dev`
  let beadsCreated = 0

  /** @param {string} title @param {string} description @param {number} priority */
  let createBead = (title, description, priority) => {
    try {
      execSync(
        `br create --actor ${agent} --owner ${agent} --title="${title}" --description="${description}" --type=task --priority=${priority}`,
        { cwd: projectDir, stdio: "pipe", env: process.env },
      )
      return true
    } catch {
      return false
    }
  }

  // Scout for spec files
  let specFiles = ["spec.md", "SPEC.md", "specification.md", "design.md"]
  for (let spec of specFiles) {
    if (existsSync(join(projectDir, spec)) && createBead(
      `Review ${spec} and create implementation beads`,
      `Read ${spec}, understand requirements, and break down into actionable beads with acceptance criteria.`,
      1,
    )) {
      beadsCreated++
    }
  }

  // Scout for README
  if (existsSync(join(projectDir, "README.md")) && createBead(
    "Review README and align project setup",
    "Read README.md for project goals, architecture decisions, and setup requirements. Create beads for any gaps.",
    2,
  )) {
    beadsCreated++
  }

  // Scout for source structure
  if (!existsSync(join(projectDir, "src")) && createBead(
    "Create initial source structure",
    `Set up src/ directory and project scaffolding for project type: ${types.join(", ")}.`,
    2,
  )) {
    beadsCreated++
  }

  // Fallback if nothing found
  if (beadsCreated === 0 && createBead(
    "Scout project and create initial beads",
    "Explore the repository, understand the project goals, and create actionable beads for initial implementation work.",
    1,
  )) {
    beadsCreated++
  }

  return beadsCreated
}

/**
 * Fetch .gitignore templates from gitignore.io
 * @param {string[]} languages - Languages/frameworks to include
 * @returns {Promise<string>} .gitignore content
 */
async function fetchGitignore(languages) {
  const url = `https://www.toptal.com/developers/gitignore/api/${languages.join(",")}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  return await response.text()
}
