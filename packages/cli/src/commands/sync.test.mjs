import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  copyWorkflowDocs,
  writeVersionMarker,
  currentVersion,
} from "../lib/docs.mjs"
import { ExitError } from "../lib/errors.mjs"
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
})
