#!/usr/bin/env bun

import { createRequire } from "node:module"
import { Command } from "commander"
import { doctor } from "./commands/doctor.mjs"
import { init } from "./commands/init.mjs"
import { sync } from "./commands/sync.mjs"
import { runAgent } from "./commands/run-agent.mjs"
import { ExitError } from "./lib/errors.mjs"

const require = createRequire(import.meta.url)
const { version } = require("../package.json")

const program = new Command()

program
  .name("botbox")
  .description("Setup and sync tool for botbox multi-agent workflows")
  .version(version)

program
  .command("init")
  .description("Bootstrap a project for botbox multi-agent workflows")
  .option("--name <name>", "Project name")
  .option("--type <type>", "Project type (api, frontend, library, monorepo)")
  .option(
    "--tools <tools>",
    "Tools to enable (comma-separated: beads,maw,crit,botbus,botty)",
  )
  .option(
    "--reviewers <roles>",
    "Reviewer roles (comma-separated: security,correctness)",
  )
  .option(
    "--language <language>",
    "Language/framework (comma-separated: rust,python,node,go,typescript,java)",
  )
  .option("--init-beads", "Initialize beads issue tracker")
  .option("--seed-work", "Create initial beads by scouting the repo")
  .option("--force", "Overwrite existing AGENTS.md")
  .option("--no-interactive", "Skip interactive prompts (use flags only)")
  .action(init)

program
  .command("sync")
  .description("Sync workflow docs and managed AGENTS.md sections")
  .option("--check", "Check for staleness without writing")
  .action(sync)

program
  .command("doctor")
  .description("Check toolchain health and configuration")
  .action(doctor)

program
  .command("run-agent <type>")
  .description("Run an agent with pretty real-time output (e.g., claude)")
  .option("-p, --prompt <text>", "Prompt text for the agent")
  .option("-m, --model <name>", "Model to use (e.g., opus, sonnet, haiku)")
  .option("-t, --timeout <seconds>", "Timeout in seconds", "600")
  .action(async (type, options) => {
    await runAgent(type, {
      prompt: options.prompt,
      model: options.model,
      timeout: parseInt(options.timeout, 10),
    })
  })

try {
  await program.parseAsync()
} catch (error) {
  if (error instanceof ExitError) {
    if (error.message) {
      console.error(error.message)
    }
    process.exit(error.code)
  }
  throw error
}
