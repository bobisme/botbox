import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { isJjRepo, hasUncommittedChanges, getCurrentDescription, commit } from "./jj.mjs"

describe("jj helpers", () => {
  let testDir
  let originalCwd

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "jj-test-"))
    originalCwd = process.cwd()
    process.chdir(testDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(testDir, { recursive: true, force: true })
  })

  describe("isJjRepo", () => {
    it("returns false for non-jj directory", () => {
      expect(isJjRepo()).toBe(false)
    })

    it("returns true for jj repository", () => {
      execSync("jj git init", { stdio: "pipe" })
      expect(isJjRepo()).toBe(true)
    })
  })

  describe("hasUncommittedChanges", () => {
    it("returns false for non-jj directory", () => {
      expect(hasUncommittedChanges()).toBe(false)
    })

    it("returns false for clean jj repository", () => {
      execSync("jj git init", { stdio: "pipe" })
      expect(hasUncommittedChanges()).toBe(false)
    })

    it("returns true when there are changes", () => {
      execSync("jj git init", { stdio: "pipe" })
      writeFileSync(join(testDir, "test.txt"), "hello")
      expect(hasUncommittedChanges()).toBe(true)
    })
  })

  describe("getCurrentDescription", () => {
    it("returns null for non-jj directory", () => {
      expect(getCurrentDescription()).toBe(null)
    })

    it("returns null for empty description", () => {
      execSync("jj git init", { stdio: "pipe" })
      expect(getCurrentDescription()).toBe(null)
    })

    it("returns description when set", () => {
      execSync("jj git init", { stdio: "pipe" })
      execSync('jj describe -m "test message"', { stdio: "pipe" })
      expect(getCurrentDescription()).toBe("test message")
    })
  })

  describe("commit", () => {
    it("returns false for non-jj directory", () => {
      expect(commit("test")).toBe(false)
    })

    it("creates a commit and new change", () => {
      execSync("jj git init", { stdio: "pipe" })
      writeFileSync(join(testDir, "test.txt"), "hello")

      let result = commit("test commit message")
      expect(result).toBe(true)

      // Verify the commit was made (parent should have our message)
      let log = execSync('jj log -r @- --no-graph -T description', {
        encoding: "utf-8",
        stdio: "pipe",
      })
      expect(log.trim()).toBe("test commit message")

      // Current change should be empty
      expect(getCurrentDescription()).toBe(null)
    })

    it("commits only specified paths when paths are provided", () => {
      execSync("jj git init", { stdio: "pipe" })

      // Create two files — one managed, one unrelated
      mkdirSync(join(testDir, ".agents", "botbox"), { recursive: true })
      writeFileSync(join(testDir, ".agents", "botbox", "doc.md"), "managed")
      writeFileSync(join(testDir, "user-file.txt"), "unrelated work")

      let result = commit("scoped commit", [".agents/botbox"])
      expect(result).toBe(true)

      // The committed change should contain only the managed file
      let committed = execSync('jj diff -r @- --summary', {
        encoding: "utf-8",
        stdio: "pipe",
      })
      expect(committed).toContain(".agents/botbox/doc.md")
      expect(committed).not.toContain("user-file.txt")

      // The unrelated file should still be in the working copy
      let working = execSync("jj diff --summary", {
        encoding: "utf-8",
        stdio: "pipe",
      })
      expect(working).toContain("user-file.txt")
    })

    it("commits multiple specified paths", () => {
      execSync("jj git init", { stdio: "pipe" })

      mkdirSync(join(testDir, ".agents", "botbox"), { recursive: true })
      writeFileSync(join(testDir, ".agents", "botbox", "doc.md"), "managed")
      writeFileSync(join(testDir, "AGENTS.md"), "agents content")
      writeFileSync(join(testDir, ".botbox.json"), "{}")
      writeFileSync(join(testDir, "unrelated.txt"), "user work")

      let result = commit("multi-path commit", [
        ".agents/botbox",
        "AGENTS.md",
        ".botbox.json",
      ])
      expect(result).toBe(true)

      let committed = execSync('jj diff -r @- --summary', {
        encoding: "utf-8",
        stdio: "pipe",
      })
      expect(committed).toContain(".agents/botbox/doc.md")
      expect(committed).toContain("AGENTS.md")
      expect(committed).toContain(".botbox.json")
      expect(committed).not.toContain("unrelated.txt")

      let working = execSync("jj diff --summary", {
        encoding: "utf-8",
        stdio: "pipe",
      })
      expect(working).toContain("unrelated.txt")
    })
  })
})
