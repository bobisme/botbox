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
})
