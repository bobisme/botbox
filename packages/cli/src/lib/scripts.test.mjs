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
  test("returns an array of .sh filenames", () => {
    let scripts = listAllScripts()
    expect(scripts.length).toBeGreaterThan(0)
    for (let s of scripts) {
      expect(s).toEndWith(".sh")
    }
  })

  test("includes known scripts", () => {
    let scripts = listAllScripts()
    expect(scripts).toContain("agent-loop.sh")
    expect(scripts).toContain("dev-loop.sh")
    expect(scripts).toContain("reviewer-loop.sh")
    expect(scripts).toContain("spawn-security-reviewer.sh")
  })
})

describe("listEligibleScripts", () => {
  test("all scripts eligible with full tools + security reviewer", () => {
    let eligible = listEligibleScripts({
      tools: ["beads", "maw", "crit", "botbus"],
      reviewers: ["security"],
    })
    expect(eligible).toContain("agent-loop.sh")
    expect(eligible).toContain("dev-loop.sh")
    expect(eligible).toContain("reviewer-loop.sh")
    expect(eligible).toContain("spawn-security-reviewer.sh")
  })

  test("only reviewer-loop with crit + botbus", () => {
    let eligible = listEligibleScripts({
      tools: ["crit", "botbus"],
      reviewers: [],
    })
    expect(eligible).toContain("reviewer-loop.sh")
    expect(eligible).not.toContain("agent-loop.sh")
    expect(eligible).not.toContain("dev-loop.sh")
    expect(eligible).not.toContain("spawn-security-reviewer.sh")
  })

  test("no scripts with minimal tools", () => {
    let eligible = listEligibleScripts({
      tools: ["beads"],
      reviewers: [],
    })
    expect(eligible).toHaveLength(0)
  })

  test("spawn-security-reviewer requires botbus + security reviewer", () => {
    let eligible = listEligibleScripts({
      tools: ["botbus"],
      reviewers: ["security"],
    })
    expect(eligible).toContain("spawn-security-reviewer.sh")
    expect(eligible).not.toContain("agent-loop.sh")
  })

  test("spawn-security-reviewer not eligible without security reviewer", () => {
    let eligible = listEligibleScripts({
      tools: ["beads", "maw", "crit", "botbus"],
      reviewers: [],
    })
    expect(eligible).not.toContain("spawn-security-reviewer.sh")
    expect(eligible).toContain("agent-loop.sh")
  })

  test("agent/dev loops need all four tools", () => {
    let eligible = listEligibleScripts({
      tools: ["beads", "maw", "crit"],
      reviewers: [],
    })
    expect(eligible).not.toContain("agent-loop.sh")
    expect(eligible).not.toContain("dev-loop.sh")
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

    expect(copied.length).toBe(4)
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
      tools: ["beads"],
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
    writeFileSync(join(target, "reviewer-loop.sh"), "old content")

    let updated = updateExistingScripts(target)
    expect(updated).toContain("reviewer-loop.sh")
    expect(updated).not.toContain("agent-loop.sh")

    // Verify content was actually updated
    let content = readFileSync(join(target, "reviewer-loop.sh"), "utf-8")
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
