import { checkbox, confirm, input } from "@inquirer/prompts"
import { execSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { ExitError } from "../lib/errors.mjs"
import { copyWorkflowDocs, writeVersionMarker } from "../lib/docs.mjs"
import { commit, isJjRepo } from "../lib/jj.mjs"
import { copyPrompts, writePromptsVersionMarker } from "../lib/prompts.mjs"
import {
  copyDesignDocs,
  writeDesignDocsVersionMarker,
} from "../lib/design-docs.mjs"
import { copyScripts, writeScriptsVersionMarker } from "../lib/scripts.mjs"
import {
  copyHooks,
  generateHooksConfig,
  writeHooksVersionMarker,
} from "../lib/hooks.mjs"
import { parseAgentsMdHeader, renderAgentsMd } from "../lib/templates.mjs"
import { currentMigrationVersion } from "../migrations/index.mjs"

export const PROJECT_TYPES = ["api", "cli", "frontend", "library", "monorepo", "tui"]
export const AVAILABLE_TOOLS = ["beads", "maw", "crit", "botbus", "botty"]
export const REVIEWER_ROLES = ["security"]
export const LANGUAGES = ["rust", "python", "node", "go", "typescript", "java"]
export const BOTBOX_CONFIG_VERSION = currentMigrationVersion()

/**
 * @param {object} opts
 * @param {string} [opts.name]
 * @param {string} [opts.type]
 * @param {string} [opts.tools]
 * @param {string} [opts.reviewers]
 * @param {string} [opts.language]
 * @param {boolean} [opts.initBeads]
 * @param {boolean} [opts.seedWork]
 * @param {string} [opts.installCommand]
 * @param {boolean} [opts.force]
 * @param {boolean} [opts.interactive]
 * @param {boolean} [opts.commit] - Auto-commit changes (default: true)
 */
export async function init(opts) {
  const interactive = opts.interactive !== false
  const shouldCommit = opts.commit !== false
  const projectDir = process.cwd()

  // Detect maw v2 bare repo — ws/default/ has botbox config, or ws/default/
  // exists and root has no .agents/botbox/ (first init at bare root)
  let bareRootDir = null
  let wsDefault = join(projectDir, "ws", "default")
  if (existsSync(join(wsDefault, ".botbox.json")) ||
      (existsSync(wsDefault) && !existsSync(join(projectDir, ".agents", "botbox")))) {
    bareRootDir = projectDir
    let args = ["exec", "default", "--", "botbox", "init"]
    // Forward relevant flags
    if (opts.name) args.push("--name", opts.name)
    if (opts.type) args.push("--type", opts.type)
    if (opts.tools) args.push("--tools", opts.tools)
    if (opts.reviewers) args.push("--reviewers", opts.reviewers)
    if (opts.language) args.push("--language", opts.language)
    if (opts.installCommand) args.push("--install-command", opts.installCommand)
    if (opts.force) args.push("--force")
    if (opts.interactive === false) args.push("--no-interactive")
    if (opts.commit === false) args.push("--no-commit")
    if (opts.initBeads === false) args.push("--no-init-beads")
    if (opts.seedWork === false) args.push("--no-seed-work")
    execSync(`maw ${args.join(" ")}`, {
      cwd: projectDir,
      stdio: "inherit",
    })

    // Ensure bare root has stub AGENTS.md + CLAUDE.md symlink
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
        if (existsSync(rootClaudeDir)) {
          rmSync(rootClaudeDir, { recursive: true })
        }
        symlinkSync("ws/default/.claude", rootClaudeDir)
        console.log("Symlinked .claude → ws/default/.claude")
      }
    }
    return
  }

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

  // Ask about local install command (for CLI tools)
  let installCommand = opts.installCommand ?? null
  if (interactive && installCommand === null) {
    const wantsInstall = await confirm({
      message: "Install locally after releases? (for CLI tools)",
      default: false,
    })
    if (wantsInstall) {
      installCommand = await input({
        message: "Install command:",
        default: "just install",
      })
    }
  }

  // Create .agents/botbox/
  mkdirSync(agentsDir, { recursive: true })
  console.log("Created .agents/botbox/")

  // Copy workflow docs
  copyWorkflowDocs(agentsDir)
  writeVersionMarker(agentsDir)
  console.log("Copied workflow docs")

  // Copy prompt templates
  let promptsDir = join(agentsDir, "prompts")
  let copiedPrompts = copyPrompts(promptsDir)
  if (copiedPrompts.length > 0) {
    writePromptsVersionMarker(promptsDir)
    console.log("Copied prompt templates")
  }

  // Copy design docs based on project type
  let designDocsDir = join(agentsDir, "design")
  let allCopiedDesignDocs = new Set()
  for (let projectType of types) {
    let copiedDocs = copyDesignDocs(designDocsDir, projectType)
    for (let doc of copiedDocs) {
      allCopiedDesignDocs.add(doc)
    }
  }
  if (allCopiedDesignDocs.size > 0) {
    writeDesignDocsVersionMarker(designDocsDir)
    console.log(`Copied design docs: ${[...allCopiedDesignDocs].join(", ")}`)
  }

  // Copy loop scripts
  let scriptsDir = join(agentsDir, "scripts")
  let copied = copyScripts(scriptsDir, { tools, reviewers })
  if (copied.length > 0) {
    writeScriptsVersionMarker(scriptsDir)
    console.log(`Copied loop scripts: ${copied.join(", ")}`)
  }

  // Copy Claude Code hooks
  let hooksDir = join(agentsDir, "hooks")
  let copiedHooks = copyHooks(hooksDir, { tools })
  if (copiedHooks.length > 0) {
    writeHooksVersionMarker(hooksDir)
    console.log(`Copied hooks: ${copiedHooks.join(", ")}`)

    // Write .claude/settings.json with hooks config
    let claudeDir = join(projectDir, ".claude")
    let settingsPath = join(claudeDir, "settings.json")
    mkdirSync(claudeDir, { recursive: true })

    let settings = {}
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
      } catch {
        // Ignore parse errors
      }
    }

    // Generate hooks config with absolute paths
    let absHooksDir = resolve(hooksDir)
    settings.hooks = generateHooksConfig(absHooksDir, copiedHooks)

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
    console.log("Generated .claude/settings.json with hooks config")
  }

  // Generate AGENTS.md
  if (existsSync(agentsMdPath) && !opts.force) {
    console.warn(
      "AGENTS.md already exists. Use --force to overwrite, or run `botbox sync` to update.",
    )
  } else {
    const content = renderAgentsMd({ name, type: types, tools, reviewers, installCommand })
    writeFileSync(agentsMdPath, content)
    console.log("Generated AGENTS.md")
  }

  // Symlink CLAUDE.md → AGENTS.md
  const claudeMdPath = join(projectDir, "CLAUDE.md")
  if (!existsSync(claudeMdPath)) {
    symlinkSync("AGENTS.md", claudeMdPath)
    console.log("Symlinked CLAUDE.md → AGENTS.md")
  }

  // Generate .botbox.json config
  const configPath = join(projectDir, ".botbox.json")
  if (!existsSync(configPath) || opts.force) {
    const config = {
      version: BOTBOX_CONFIG_VERSION,
      project: {
        name,
        type: types,
        languages: languages.length > 0 ? languages : undefined,
        defaultAgent: `${name}-dev`,
        channel: name,
        installCommand: installCommand || undefined,
      },
      tools: {
        beads: tools.includes("beads"),
        maw: tools.includes("maw"),
        crit: tools.includes("crit"),
        botbus: tools.includes("botbus"),
        botty: tools.includes("botty"),
      },
      review: {
        enabled: reviewers.length > 0,
        reviewers,
      },
      pushMain: false,
      agents: {
        dev: {
          model: "opus",
          maxLoops: 20,
          pause: 2,
          timeout: 900,
          missions: {
            enabled: true,
            maxWorkers: 4,
            maxChildren: 12,
            checkpointIntervalSec: 30,
          },
        },
        worker: {
          model: "haiku",
          timeout: 600,
        },
        reviewer: {
          model: "opus",
          maxLoops: 20,
          pause: 2,
          timeout: 600,
        },
      },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
    console.log("Generated .botbox.json")
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

    // Create .critignore to exclude botbox-managed and tool files from reviews
    const critignorePath = join(projectDir, ".critignore")
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
    await registerSpawnHook(projectDir, name, reviewers)
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

  // Auto-commit if this is a new init (not a re-init) and in a jj repo
  if (!isReinit && shouldCommit && isJjRepo()) {
    let message = `chore: initialize botbox v${BOTBOX_CONFIG_VERSION}`

    // Only commit botbox-managed files to avoid capturing unrelated
    // user changes that happen to be in the working copy.
    let managedPaths = [
      ".agents/botbox",
      "AGENTS.md",
      "CLAUDE.md",
      ".botbox.json",
      ".claude/settings.json",
    ]
    if (existsSync(join(projectDir, ".critignore"))) {
      managedPaths.push(".critignore")
    }

    if (commit(message, managedPaths)) {
      console.log(`Committed: ${message}`)
    } else {
      console.warn("Warning: Failed to auto-commit (jj error)")
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

/**
 * Build the env-inherit list for botty spawn hooks.
 * @param {boolean} pushMain - Whether pushMain is enabled in config
 * @returns {string} Comma-separated list of environment variables
 */
function buildEnvInheritList(pushMain) {
  let vars = ["BOTBUS_CHANNEL", "BOTBUS_MESSAGE_ID", "BOTBUS_AGENT", "BOTBUS_HOOK_ID"]
  if (pushMain) {
    vars.push("SSH_AUTH_SOCK")
  }
  return vars.join(",")
}

/**
 * Register auto-spawn hooks for dev agent and specialist reviewers.
 * @param {string} projectDir - Project root directory
 * @param {string} name - Project name
 * @param {string[]} reviewers - Reviewer roles (e.g., ["security"])
 */
async function registerSpawnHook(projectDir, name, reviewers) {
  let { execSync } = await import("node:child_process")
  let absPath = resolve(projectDir)
  let agent = `${name}-dev`

  // Read .botbox.json to check pushMain setting
  let configPath = join(projectDir, ".botbox.json")
  let pushMain = false
  if (existsSync(configPath)) {
    try {
      let config = JSON.parse(readFileSync(configPath, "utf-8"))
      pushMain = config.pushMain || false
    } catch {
      // Ignore parse errors, default to false
    }
  }

  let envInherit = buildEnvInheritList(pushMain)

  // In maw v2, ws/default/ can be recreated by jj during workspace merges,
  // invalidating the CWD of any process using it. Use the bare repo root
  // (stable) for hook and spawn CWDs, with absolute script paths.
  let hookCwd = absPath
  let spawnCwd = absPath
  let scriptPrefix = ".agents/botbox/scripts/"
  if (basename(dirname(absPath)) === "ws" && existsSync(join(dirname(dirname(absPath)), ".jj"))) {
    let bareRoot = dirname(dirname(absPath))
    hookCwd = bareRoot
    spawnCwd = bareRoot
    scriptPrefix = join(absPath, ".agents", "botbox", "scripts") + "/"
  }

  // Check if bus supports hooks
  try {
    execSync("bus hooks list", { stdio: "pipe", env: process.env })
  } catch {
    // bus doesn't support hooks or isn't installed
    return
  }

  // Register single router hook — respond.mjs handles all message routing
  // (replaces the old dev-loop + respond hook pair)
  try {
    let existing = execSync("bus hooks list --format json", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })
    let hooks = JSON.parse(existing)
    let arr = Array.isArray(hooks) ? hooks : hooks.hooks ?? []
    // Check for existing router hook (claim-based, runs respond.mjs)
    // Match either old CWD (ws/default/) or new CWD (bare root)
    let hasRouterHook = arr.some(
      (/** @type {any} */ h) =>
        (h.cwd === hookCwd || h.cwd === absPath) &&
        h.active &&
        h.condition?.type === "claim_available" &&
        Array.isArray(h.command) &&
        h.command.some((/** @type {string} */ c) => c.includes("respond.mjs")),
    )
    if (hasRouterHook) {
      console.log("Router hook already exists, skipping")
    } else {
      execSync(
        `bus hooks add --agent ${agent} --channel ${name} --claim "agent://${agent}" --claim-owner ${agent} --cwd "${hookCwd}" --ttl 600 -- botty spawn --env-inherit ${envInherit} --name ${agent} --cwd "${spawnCwd}" -- bun "${scriptPrefix}respond.mjs" ${name} ${agent}`,
        { cwd: projectDir, stdio: "inherit", env: process.env },
      )
      console.log("Registered router hook (respond.mjs) for all channel messages")
    }
  } catch {
    console.warn("Warning: Failed to register router hook")
  }

  // Register reviewer hooks (mention-based)
  for (let role of reviewers) {
    let reviewerAgent = `${name}-${role}`
    let scriptName = "reviewer-loop.mjs"

    try {
      let existing = execSync("bus hooks list --format json", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      })
      let hooks = JSON.parse(existing)
      let arr = Array.isArray(hooks) ? hooks : hooks.hooks ?? []
      if (arr.some((/** @type {any} */ h) => h.condition?.agent === reviewerAgent && h.active)) {
        console.log(`Mention hook for @${reviewerAgent} already exists, skipping`)
        continue
      }
    } catch {
      // Parse failure — proceed to add
    }

    try {
      execSync(
        `bus hooks add --agent ${agent} --channel ${name} --mention "${reviewerAgent}" --claim "agent://${reviewerAgent}" --claim-owner ${reviewerAgent} --ttl 600 --priority 1 --cwd "${hookCwd}" -- botty spawn --env-inherit ${envInherit} --name ${reviewerAgent} --cwd "${spawnCwd}" -- bun "${scriptPrefix}${scriptName}" ${name} ${reviewerAgent}`,
        { cwd: projectDir, stdio: "inherit", env: process.env },
      )
      console.log(`Registered mention hook for @${reviewerAgent}`)
    } catch (err) {
      console.warn(`Warning: Failed to register mention hook for @${reviewerAgent}: ${err.message}`)
    }
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
