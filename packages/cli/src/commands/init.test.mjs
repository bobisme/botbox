import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  lstatSync,
  readdirSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import { init } from "./init.mjs"

describe("init (non-interactive)", () => {
  /** @type {string} */
  let tempDir
  /** @type {string} */
  let origCwd

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-init-test-"))
    origCwd = process.cwd()
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.chdir(origCwd)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("creates .agents/botbox/ directory", async () => {
    await init({
      name: "test-project",
      type: "api",
      tools: "beads,maw",
      interactive: false,
    })

    expect(existsSync(join(tempDir, ".agents", "botbox"))).toBe(true)
  })

  test("copies workflow docs", async () => {
    await init({
      name: "test-project",
      type: "api",
      tools: "beads",
      interactive: false,
    })

    let docsDir = join(tempDir, ".agents", "botbox")
    let docs = readdirSync(docsDir).filter((f) => f.endsWith(".md"))
    expect(docs.length).toBeGreaterThan(0)
    expect(docs).toContain("triage.md")
    expect(docs).toContain("finish.md")
  })

  test("writes version marker", async () => {
    await init({
      name: "test-project",
      type: "api",
      tools: "beads",
      interactive: false,
    })

    expect(existsSync(join(tempDir, ".agents", "botbox", ".version"))).toBe(
      true,
    )
  })

  test("generates AGENTS.md with project name", async () => {
    await init({
      name: "my-cool-api",
      type: "api",
      tools: "beads,maw",
      reviewers: "security",
      interactive: false,
    })

    let content = readFileSync(join(tempDir, "AGENTS.md"), "utf-8")
    expect(content).toContain("# my-cool-api")
    expect(content).toContain("Project type: api")
    expect(content).toContain("`beads`")
    expect(content).toContain("`maw`")
    expect(content).toContain("Reviewer roles: security")
    expect(content).toContain("<!-- botbox:managed-start -->")
  })

  test("creates CLAUDE.md symlink", async () => {
    await init({
      name: "test-project",
      type: "library",
      tools: "beads",
      interactive: false,
    })

    let claudeMd = join(tempDir, "CLAUDE.md")
    expect(existsSync(claudeMd)).toBe(true)
    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(true)
  })

  test("does not overwrite existing AGENTS.md without --force", async () => {
    let { writeFileSync: writeFs } = await import("node:fs")
    writeFs(join(tempDir, "AGENTS.md"), "custom content")

    await init({
      name: "test-project",
      type: "api",
      tools: "beads",
      interactive: false,
    })

    let content = readFileSync(join(tempDir, "AGENTS.md"), "utf-8")
    expect(content).toBe("custom content")
  })

  test("overwrites AGENTS.md with --force", async () => {
    let { writeFileSync: writeFs } = await import("node:fs")
    writeFs(join(tempDir, "AGENTS.md"), "custom content")

    await init({
      name: "forced-project",
      type: "api",
      tools: "beads",
      force: true,
      interactive: false,
    })

    let content = readFileSync(join(tempDir, "AGENTS.md"), "utf-8")
    expect(content).toContain("# forced-project")
  })

  test("does not overwrite existing CLAUDE.md", async () => {
    let { writeFileSync } = await import("node:fs")
    writeFileSync(join(tempDir, "CLAUDE.md"), "existing content")

    await init({
      name: "test-project",
      type: "api",
      tools: "beads",
      interactive: false,
    })

    let content = readFileSync(join(tempDir, "CLAUDE.md"), "utf-8")
    expect(content).toBe("existing content")
  })

  test("rejects invalid project type", () => {
    expect(
      init({
        name: "test",
        type: "invalid-type",
        interactive: false,
      }),
    ).rejects.toThrow("Unknown project type")
  })

  test("rejects invalid tool names", () => {
    expect(
      init({
        name: "test",
        type: "api",
        tools: "beadz,mwa",
        interactive: false,
      }),
    ).rejects.toThrow("Unknown tools")
  })

  test("rejects invalid reviewer roles", () => {
    expect(
      init({
        name: "test",
        type: "api",
        reviewers: "speed",
        interactive: false,
      }),
    ).rejects.toThrow("Unknown reviewers")
  })

  test("copies loop scripts with full tools", async () => {
    await init({
      name: "scripts-test",
      type: "api",
      tools: "beads,maw,crit,botbus",
      reviewers: "security",
      interactive: false,
    })

    let scriptsDir = join(tempDir, "scripts")
    expect(existsSync(scriptsDir)).toBe(true)
    let scripts = readdirSync(scriptsDir).filter((f) => f.endsWith(".sh"))
    expect(scripts).toContain("agent-loop.sh")
    expect(scripts).toContain("dev-loop.sh")
    expect(scripts).toContain("reviewer-loop.sh")
    expect(scripts).toContain("spawn-security-reviewer.sh")
    expect(existsSync(join(scriptsDir, ".scripts-version"))).toBe(true)
  })

  test("copies only reviewer-loop with crit+botbus tools", async () => {
    await init({
      name: "partial-scripts-test",
      type: "api",
      tools: "crit,botbus",
      interactive: false,
    })

    let scriptsDir = join(tempDir, "scripts")
    expect(existsSync(scriptsDir)).toBe(true)
    let scripts = readdirSync(scriptsDir).filter((f) => f.endsWith(".sh"))
    expect(scripts).toContain("reviewer-loop.sh")
    expect(scripts).not.toContain("agent-loop.sh")
    expect(scripts).not.toContain("dev-loop.sh")
    expect(scripts).not.toContain("spawn-security-reviewer.sh")
  })

  test("does not create scripts dir when no scripts are eligible", async () => {
    await init({
      name: "no-scripts-test",
      type: "api",
      tools: "beads",
      interactive: false,
    })

    expect(existsSync(join(tempDir, "scripts"))).toBe(false)
  })

  test("re-init detects config from existing AGENTS.md", async () => {
    await init({
      name: "detect-test",
      type: "cli",
      tools: "beads,maw",
      reviewers: "security",
      interactive: false,
    })

    // Re-init without specifying name/type/tools/reviewers
    await init({
      force: true,
      interactive: false,
    })

    let content = readFileSync(join(tempDir, "AGENTS.md"), "utf-8")
    expect(content).toContain("# detect-test")
    expect(content).toContain("Project type: cli")
    expect(content).toContain("`beads`")
    expect(content).toContain("`maw`")
    expect(content).toContain("Reviewer roles: security")
  })

  test("CLI flags override detected values on re-init", async () => {
    await init({
      name: "original-name",
      type: "api",
      tools: "beads",
      interactive: false,
    })

    await init({
      name: "new-name",
      force: true,
      interactive: false,
    })

    let content = readFileSync(join(tempDir, "AGENTS.md"), "utf-8")
    expect(content).toContain("# new-name")
    expect(content).toContain("Project type: api")
  })

  test("non-interactive fresh init still requires --name", () => {
    expect(
      init({ type: "api", interactive: false }),
    ).rejects.toThrow("--name is required")
  })

  test("defaults all tools when tools flag omitted", async () => {
    await init({
      name: "test-project",
      type: "api",
      interactive: false,
    })

    let content = readFileSync(join(tempDir, "AGENTS.md"), "utf-8")
    expect(content).toContain("`beads`")
    expect(content).toContain("`maw`")
    expect(content).toContain("`crit`")
    expect(content).toContain("`botbus`")
    expect(content).toContain("`botty`")
  })

  test("registers on #projects when botbus is in tools", async () => {
    let hasBus = false
    try {
      execSync("bus --version", { stdio: "ignore" })
      hasBus = true
    } catch {
      // bus not installed
    }

    if (!hasBus) {
      // Verify init succeeds gracefully without bus
      await init({
        name: "bus-test",
        type: "api",
        tools: "botbus",
        interactive: false,
      })
      // Should not throw — just warn
      return
    }

    // bus is available — verify the message was sent
    await init({
      name: "bus-reg-test",
      type: "api",
      tools: "botbus",
      interactive: false,
    })

    let output = execSync("bus history projects -n 5 --format text", {
      encoding: "utf-8",
    })
    expect(output).toContain("project: bus-reg-test")
    expect(output).toContain(`repo: ${tempDir}`)
    expect(output).toContain("lead: bus-reg-test-dev")
  })

  test("seed-work creates beads for spec files", async () => {
    let hasBr = false
    try {
      execSync("br --version", { stdio: "ignore" })
      hasBr = true
    } catch {
      // br not installed
    }

    if (!hasBr) {
      // Verify init succeeds gracefully without br
      await init({
        name: "seed-test",
        type: "api",
        tools: "beads",
        seedWork: true,
        interactive: false,
      })
      return
    }

    // Initialize beads and create a spec file
    execSync("br init", { cwd: tempDir, stdio: "ignore" })
    let { writeFileSync } = await import("node:fs")
    writeFileSync(join(tempDir, "spec.md"), "# Spec\nBuild a thing.")

    await init({
      name: "seed-spec-test",
      type: "api",
      tools: "beads",
      seedWork: true,
      interactive: false,
    })

    let output = execSync("br list --json", {
      cwd: tempDir,
      encoding: "utf-8",
    })
    expect(output).toContain("Review spec.md")
  })

  test("seed-work creates fallback bead when no spec files found", async () => {
    let hasBr = false
    try {
      execSync("br --version", { stdio: "ignore" })
      hasBr = true
    } catch {
      // br not installed
    }

    if (!hasBr) {
      return
    }

    // Initialize beads, create src/ so it doesn't trigger the "create source structure" bead
    execSync("br init", { cwd: tempDir, stdio: "ignore" })
    let { mkdirSync: mkFs } = await import("node:fs")
    mkFs(join(tempDir, "src"))

    await init({
      name: "seed-fallback-test",
      type: "api",
      tools: "beads",
      seedWork: true,
      interactive: false,
    })

    let output = execSync("br list --json", {
      cwd: tempDir,
      encoding: "utf-8",
    })
    expect(output).toContain("Scout project")
  })

  test("seed-work skipped when beads not in tools", async () => {
    await init({
      name: "seed-no-beads",
      type: "api",
      tools: "maw",
      seedWork: true,
      interactive: false,
    })
    // Should not throw — just warn
    expect(existsSync(join(tempDir, ".agents", "botbox"))).toBe(true)
  })

  test("registers auto-spawn hook when botbus is in tools", async () => {
    let hasBus = false
    try {
      execSync("bus hooks list", { stdio: "ignore" })
      hasBus = true
    } catch {
      // bus hooks not available
    }

    if (!hasBus) {
      // Verify init succeeds gracefully without hooks support
      await init({
        name: "hook-test",
        type: "api",
        tools: "botbus",
        interactive: false,
      })
      return
    }

    await init({
      name: "hook-reg-test",
      type: "api",
      tools: "botbus",
      interactive: false,
    })

    let output = execSync("bus hooks list --format json", {
      encoding: "utf-8",
    })
    let hooks = JSON.parse(output)
    let arr = Array.isArray(hooks) ? hooks : hooks.hooks ?? []
    let hook = arr.find(
      (/** @type {any} */ h) => h.channel === "hook-reg-test" && h.active,
    )
    expect(hook).toBeTruthy()

    // Clean up
    if (hook) {
      execSync(`bus hooks remove ${hook.id}`, { stdio: "ignore" })
    }
  })

  test("does not duplicate hook on second init", async () => {
    let hasBus = false
    try {
      execSync("bus hooks list", { stdio: "ignore" })
      hasBus = true
    } catch {
      // bus hooks not available
    }

    if (!hasBus) {
      return
    }

    // Run init twice
    await init({
      name: "hook-dup-test",
      type: "api",
      tools: "botbus",
      interactive: false,
    })
    await init({
      name: "hook-dup-test",
      type: "api",
      tools: "botbus",
      force: true,
      interactive: false,
    })

    let output = execSync("bus hooks list --format json", {
      encoding: "utf-8",
    })
    let hooks = JSON.parse(output)
    let arr = Array.isArray(hooks) ? hooks : hooks.hooks ?? []
    let matching = arr.filter(
      (/** @type {any} */ h) => h.channel === "hook-dup-test" && h.active,
    )
    expect(matching.length).toBe(1)

    // Clean up
    for (let h of matching) {
      execSync(`bus hooks remove ${h.id}`, { stdio: "ignore" })
    }
  })

  test("does not register on #projects when botbus not in tools", async () => {
    let hasBus = false
    try {
      execSync("bus --version", { stdio: "ignore" })
      hasBus = true
    } catch {
      // bus not installed
    }

    if (!hasBus) {
      return
    }

    await init({
      name: "no-bus-test",
      type: "api",
      tools: "beads,maw",
      interactive: false,
    })

    let after = execSync("bus history projects -n 50 --format text", {
      encoding: "utf-8",
    })
    expect(after).not.toContain("project: no-bus-test")
  })
})
