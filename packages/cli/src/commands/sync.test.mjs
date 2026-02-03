import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  copyWorkflowDocs,
  writeVersionMarker,
  currentVersion,
} from "../lib/docs.mjs"
import { ExitError } from "../lib/errors.mjs"
import { copyScripts, currentScriptsVersion } from "../lib/scripts.mjs"
import { BOTBOX_CONFIG_VERSION } from "./init.mjs"
import { sync } from "./sync.mjs"

describe("sync", () => {
  /** @type {string} */
  let tempDir
  /** @type {string} */
  let origCwd

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-sync-test-"))
    origCwd = process.cwd()
    process.chdir(tempDir)
  })

  afterEach(() => {
    process.chdir(origCwd)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("reports up to date when version matches", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir)

    // Should not throw, just log "Already up to date."
    sync({ check: false })
  })

  test("updates docs when version is stale", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    // Write a fake old version
    writeFileSync(join(agentsDir, ".version"), "000000000000")

    sync({ check: false })

    let version = readFileSync(join(agentsDir, ".version"), "utf-8").trim()
    expect(version).toBe(currentVersion())
  })

  test("throws ExitError when .agents/botbox/ is missing", () => {
    expect(() => sync({ check: false })).toThrow(ExitError)
  })

  test("throws ExitError with --check when stale", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeFileSync(join(agentsDir, ".version"), "000000000000")

    expect(() => sync({ check: true })).toThrow(ExitError)
  })

  test("--check does not write files when stale", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeFileSync(join(agentsDir, ".version"), "000000000000")

    try {
      sync({ check: true })
    } catch {
      // expected
    }

    let version = readFileSync(join(agentsDir, ".version"), "utf-8").trim()
    expect(version).toBe("000000000000")
  })

  test("updates managed section in AGENTS.md", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeFileSync(join(agentsDir, ".version"), "000000000000")

    writeFileSync(
      join(tempDir, "AGENTS.md"),
      [
        "# My Project",
        "",
        "Custom stuff.",
        "",
        "<!-- botbox:managed-start -->",
        "old content",
        "<!-- botbox:managed-end -->",
      ].join("\n"),
    )

    sync({ check: false })

    let content = readFileSync(join(tempDir, "AGENTS.md"), "utf-8")
    expect(content).toContain("# My Project")
    expect(content).toContain("Custom stuff.")
    expect(content).not.toContain("old content")
    expect(content).toContain("## Botbox Workflow")
  })

  test("updates managed section even when docs are unchanged (bd-1pe)", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir) // Docs are now up to date

    // Create AGENTS.md with stale managed section
    writeFileSync(
      join(tempDir, "AGENTS.md"),
      [
        "# My Project",
        "",
        "Custom stuff.",
        "",
        "<!-- botbox:managed-start -->",
        "stale managed section content",
        "<!-- botbox:managed-end -->",
      ].join("\n"),
    )

    // Sync should update managed section even though docs are current
    sync({ check: false })

    let content = readFileSync(join(tempDir, "AGENTS.md"), "utf-8")
    expect(content).toContain("# My Project")
    expect(content).toContain("Custom stuff.")
    expect(content).not.toContain("stale managed section content")
    expect(content).toContain("## Botbox Workflow")
  })

  test("--check fails when managed section is stale but docs are current", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir) // Docs are current

    // Create AGENTS.md with stale managed section
    writeFileSync(
      join(tempDir, "AGENTS.md"),
      [
        "# My Project",
        "",
        "Custom stuff.",
        "",
        "<!-- botbox:managed-start -->",
        "stale managed section content",
        "<!-- botbox:managed-end -->",
      ].join("\n"),
    )

    // Should throw because managed section is stale
    expect(() => sync({ check: true })).toThrow(ExitError)
    expect(() => sync({ check: true })).toThrow(
      /Stale:.*managed section of AGENTS\.md/,
    )

    // File should not be modified in --check mode
    let content = readFileSync(join(tempDir, "AGENTS.md"), "utf-8")
    expect(content).toContain("stale managed section content")
  })

  test("updates scripts when version is stale", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir)

    // Set up scripts dir with stale version
    let scriptsDir = join(agentsDir, "scripts")
    copyScripts(scriptsDir, {
      tools: ["crit", "botbus"],
      reviewers: [],
    })
    writeFileSync(join(scriptsDir, ".scripts-version"), "000000000000")

    sync({ check: false })

    let version = readFileSync(
      join(scriptsDir, ".scripts-version"),
      "utf-8",
    ).trim()
    expect(version).toBe(currentScriptsVersion())
  })

  test("--check fails when scripts are stale", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir)

    let scriptsDir = join(agentsDir, "scripts")
    copyScripts(scriptsDir, {
      tools: ["crit", "botbus"],
      reviewers: [],
    })
    writeFileSync(join(scriptsDir, ".scripts-version"), "000000000000")

    expect(() => sync({ check: true })).toThrow(ExitError)
    expect(() => sync({ check: true })).toThrow(/Stale:.*loop scripts/)
  })

  test("skips scripts check when no .scripts-version marker", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir)

    // Create scripts dir without version marker
    let scriptsDir = join(agentsDir, "scripts")
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, "some-script.sh"), "#!/bin/bash")

    // Should not throw — no version marker means not managed by botbox
    sync({ check: false })
  })

  test("upgrades config when version is stale", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir)

    // Write a config with an old version
    let configPath = join(tempDir, ".botbox.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        version: "0.9.0",
        project: { name: "test", type: ["api"] },
      }, null, 2),
    )

    sync({ check: false })

    let config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.version).toBe(BOTBOX_CONFIG_VERSION)
    expect(config.project.name).toBe("test")
  })

  test("--check fails when config is stale", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir)

    let configPath = join(tempDir, ".botbox.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        version: "0.9.0",
        project: { name: "test", type: ["api"] },
      }, null, 2),
    )

    expect(() => sync({ check: true })).toThrow(ExitError)
    expect(() => sync({ check: true })).toThrow(/Stale:.*\.botbox\.json/)
  })

  test("treats missing version field as 0.0.0", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir)

    let configPath = join(tempDir, ".botbox.json")
    writeFileSync(
      configPath,
      JSON.stringify({
        project: { name: "test", type: ["api"] },
      }, null, 2),
    )

    sync({ check: false })

    let config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.version).toBe(BOTBOX_CONFIG_VERSION)
  })

  test("skips config check on malformed JSON", () => {
    let agentsDir = join(tempDir, ".agents", "botbox")
    copyWorkflowDocs(agentsDir)
    writeVersionMarker(agentsDir)

    let configPath = join(tempDir, ".botbox.json")
    writeFileSync(configPath, "{ invalid json")

    // Should not throw — malformed config is ignored
    sync({ check: false })
  })
})
