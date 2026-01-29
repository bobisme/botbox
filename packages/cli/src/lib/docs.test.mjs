import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  listWorkflowDocs,
  copyWorkflowDocs,
  currentVersion,
  writeVersionMarker,
  readVersionMarker,
} from "./docs.mjs"

describe("listWorkflowDocs", () => {
  test("returns an array of .md filenames", () => {
    let docs = listWorkflowDocs()
    expect(docs.length).toBeGreaterThan(0)
    for (let doc of docs) {
      expect(doc).toEndWith(".md")
    }
  })

  test("includes known workflow docs", () => {
    let docs = listWorkflowDocs()
    expect(docs).toContain("triage.md")
    expect(docs).toContain("finish.md")
    expect(docs).toContain("worker-loop.md")
    expect(docs).toContain("start.md")
  })
})

describe("copyWorkflowDocs", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("copies all docs to target directory", () => {
    let target = join(tempDir, "agents", "botbox")
    copyWorkflowDocs(target)

    let copied = readdirSync(target).filter((f) => f.endsWith(".md"))
    let expected = listWorkflowDocs()
    expect(copied.sort()).toEqual(expected.sort())
  })

  test("creates target directory if it does not exist", () => {
    let target = join(tempDir, "deep", "nested", "dir")
    expect(existsSync(target)).toBe(false)

    copyWorkflowDocs(target)
    expect(existsSync(target)).toBe(true)
  })

  test("copied files match source content", () => {
    let target = join(tempDir, "docs")
    copyWorkflowDocs(target)

    let docs = listWorkflowDocs()
    for (let doc of docs) {
      let copied = readFileSync(join(target, doc), "utf-8")
      expect(copied.length).toBeGreaterThan(0)
    }
  })
})

describe("currentVersion", () => {
  test("returns a 12-character hex string", () => {
    let version = currentVersion()
    expect(version).toMatch(/^[0-9a-f]{12}$/)
  })

  test("is deterministic", () => {
    let v1 = currentVersion()
    let v2 = currentVersion()
    expect(v1).toBe(v2)
  })
})

describe("version markers", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("writeVersionMarker creates a .version file", () => {
    writeVersionMarker(tempDir)
    expect(existsSync(join(tempDir, ".version"))).toBe(true)
  })

  test("readVersionMarker reads what writeVersionMarker wrote", () => {
    writeVersionMarker(tempDir)
    let version = readVersionMarker(tempDir)
    expect(version).toBe(currentVersion())
  })

  test("readVersionMarker returns null for missing directory", () => {
    let version = readVersionMarker(join(tempDir, "nonexistent"))
    expect(version).toBeNull()
  })
})
