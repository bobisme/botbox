import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  accessSync,
  constants,
  writeFileSync,
  mkdirSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  listAllScripts,
  listEligibleScripts,
  copyScripts,
  updateExistingScripts,
  currentScriptsVersion,
  writeScriptsVersionMarker,
  readScriptsVersionMarker,
} from "./scripts.mjs"

describe("listAllScripts", () => {
  test("returns an array of .mjs filenames", () => {
    let scripts = listAllScripts()
    expect(scripts.length).toBeGreaterThan(0)
    for (let s of scripts) {
      expect(s).toEndWith(".mjs")
    }
  })

  test("includes known scripts", () => {
    let scripts = listAllScripts()
    expect(scripts).toContain("agent-loop.mjs")
    expect(scripts).toContain("dev-loop.mjs")
    expect(scripts).toContain("respond.mjs")
    expect(scripts).toContain("reviewer-loop.mjs")
  })
})

describe("listEligibleScripts", () => {
  test("all scripts eligible with full tools + security reviewer", () => {
    let eligible = listEligibleScripts({
      tools: ["beads", "maw", "crit", "botbus"],
      reviewers: ["security"],
    })
    expect(eligible).toContain("agent-loop.mjs")
    expect(eligible).toContain("dev-loop.mjs")
    expect(eligible).toContain("reviewer-loop.mjs")
  })

  test("reviewer-loop and respond with crit + botbus", () => {
    let eligible = listEligibleScripts({
      tools: ["crit", "botbus"],
      reviewers: [],
    })
    expect(eligible).toContain("reviewer-loop.mjs")
    expect(eligible).toContain("respond.mjs")
    expect(eligible).not.toContain("agent-loop.mjs")
    expect(eligible).not.toContain("dev-loop.mjs")
  })

  test("triage script only with beads", () => {
    let eligible = listEligibleScripts({
      tools: ["beads"],
      reviewers: [],
    })
    expect(eligible).toEqual(["triage.mjs"])
  })

  test("no scripts with empty tools", () => {
    let eligible = listEligibleScripts({
      tools: [],
      reviewers: [],
    })
    expect(eligible).toHaveLength(0)
  })

  test("agent/dev loops need all four tools", () => {
    let eligible = listEligibleScripts({
      tools: ["beads", "maw", "crit"],
      reviewers: [],
    })
    expect(eligible).not.toContain("agent-loop.mjs")
    expect(eligible).not.toContain("dev-loop.mjs")
  })
})

describe("copyScripts", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-scripts-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("copies eligible scripts to target dir", () => {
    let target = join(tempDir, "scripts")
    let copied = copyScripts(target, {
      tools: ["beads", "maw", "crit", "botbus"],
      reviewers: ["security"],
    })

    // 7 scripts: agent-loop, dev-loop, iteration-start, respond (legacy), router, reviewer-loop, triage
    expect(copied.length).toBe(7)
    for (let file of copied) {
      expect(existsSync(join(target, file))).toBe(true)
    }
  })

  test("creates target directory", () => {
    let target = join(tempDir, "deep", "nested", "scripts")
    copyScripts(target, {
      tools: ["crit", "botbus"],
      reviewers: [],
    })
    expect(existsSync(target)).toBe(true)
  })

  test("scripts are executable", () => {
    let target = join(tempDir, "scripts")
    let copied = copyScripts(target, {
      tools: ["crit", "botbus"],
      reviewers: [],
    })

    for (let file of copied) {
      // Verify script is executable
      expect(() =>
        accessSync(join(target, file), constants.X_OK),
      ).not.toThrow()
    }
  })

  test("returns empty array when no scripts eligible", () => {
    let target = join(tempDir, "scripts")
    let copied = copyScripts(target, {
      tools: [],
      reviewers: [],
    })
    expect(copied).toHaveLength(0)
    expect(existsSync(target)).toBe(false)
  })
})

describe("updateExistingScripts", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-scripts-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("re-copies only scripts that exist in target", () => {
    let target = join(tempDir, "scripts")
    mkdirSync(target, { recursive: true })
    // Create a dummy file for one script
    writeFileSync(join(target, "reviewer-loop.mjs"), "old content")

    let updated = updateExistingScripts(target)
    expect(updated).toContain("reviewer-loop.mjs")
    expect(updated).not.toContain("agent-loop.mjs")

    // Verify content was actually updated
    let content = readFileSync(join(target, "reviewer-loop.mjs"), "utf-8")
    expect(content).not.toBe("old content")
  })

  test("returns empty array when no scripts exist in target", () => {
    let target = join(tempDir, "scripts")
    mkdirSync(target, { recursive: true })
    let updated = updateExistingScripts(target)
    expect(updated).toHaveLength(0)
  })
})

describe("currentScriptsVersion", () => {
  test("returns a 12-character hex string", () => {
    let version = currentScriptsVersion()
    expect(version).toMatch(/^[0-9a-f]{12}$/)
  })

  test("is deterministic", () => {
    let v1 = currentScriptsVersion()
    let v2 = currentScriptsVersion()
    expect(v1).toBe(v2)
  })
})

describe("scripts version markers", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-scripts-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("writeScriptsVersionMarker creates a .scripts-version file", () => {
    writeScriptsVersionMarker(tempDir)
    expect(existsSync(join(tempDir, ".scripts-version"))).toBe(true)
  })

  test("readScriptsVersionMarker reads what write wrote", () => {
    writeScriptsVersionMarker(tempDir)
    let version = readScriptsVersionMarker(tempDir)
    expect(version).toBe(currentScriptsVersion())
  })

  test("readScriptsVersionMarker returns null for missing directory", () => {
    let version = readScriptsVersionMarker(join(tempDir, "nonexistent"))
    expect(version).toBeNull()
  })
})
