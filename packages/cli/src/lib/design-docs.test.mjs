import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  listAllDesignDocs,
  listEligibleDesignDocs,
  copyDesignDocs,
  syncDesignDocs,
  currentDesignDocsVersion,
  writeDesignDocsVersionMarker,
  readDesignDocsVersionMarker,
} from "./design-docs.mjs"

describe("listAllDesignDocs", () => {
  test("returns an array of .md filenames", () => {
    let docs = listAllDesignDocs()
    expect(docs.length).toBeGreaterThan(0)
    for (let d of docs) {
      expect(d).toEndWith(".md")
    }
  })

  test("includes cli-conventions.md", () => {
    let docs = listAllDesignDocs()
    expect(docs).toContain("cli-conventions.md")
  })
})

describe("listEligibleDesignDocs", () => {
  test("cli project type gets cli-conventions.md", () => {
    let eligible = listEligibleDesignDocs("cli")
    expect(eligible).toContain("cli-conventions.md")
  })

  test("tui project type gets cli-conventions.md", () => {
    let eligible = listEligibleDesignDocs("tui")
    expect(eligible).toContain("cli-conventions.md")
  })

  test("api project type gets no docs yet", () => {
    let eligible = listEligibleDesignDocs("api")
    expect(eligible).toHaveLength(0)
  })

  test("library project type gets no docs yet", () => {
    let eligible = listEligibleDesignDocs("library")
    expect(eligible).toHaveLength(0)
  })
})

describe("copyDesignDocs", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-design-docs-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("copies eligible docs to target dir for cli project", () => {
    let target = join(tempDir, "design")
    let copied = copyDesignDocs(target, "cli")

    expect(copied).toContain("cli-conventions.md")
    expect(existsSync(join(target, "cli-conventions.md"))).toBe(true)
  })

  test("returns empty array when no docs eligible", () => {
    let target = join(tempDir, "design")
    let copied = copyDesignDocs(target, "api")
    expect(copied).toHaveLength(0)
    expect(existsSync(target)).toBe(false)
  })
})

describe("syncDesignDocs", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-design-docs-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("adds new docs and updates existing", () => {
    let target = join(tempDir, "design")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "cli-conventions.md"), "old content")

    let { updated, added } = syncDesignDocs(target, "cli")
    expect(updated).toContain("cli-conventions.md")
    expect(added).toHaveLength(0)

    // Content should be updated
    let content = readFileSync(join(target, "cli-conventions.md"), "utf-8")
    expect(content).not.toBe("old content")
  })

  test("adds new docs when directory is empty", () => {
    let target = join(tempDir, "design")
    let { updated, added } = syncDesignDocs(target, "cli")

    expect(added).toContain("cli-conventions.md")
    expect(updated).toHaveLength(0)
  })
})

describe("currentDesignDocsVersion", () => {
  test("returns a 12-character hex string", () => {
    let version = currentDesignDocsVersion()
    expect(version).toMatch(/^[0-9a-f]{12}$/)
  })

  test("is deterministic", () => {
    let v1 = currentDesignDocsVersion()
    let v2 = currentDesignDocsVersion()
    expect(v1).toBe(v2)
  })
})

describe("design docs version markers", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-design-docs-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("writeDesignDocsVersionMarker creates a .design-docs-version file", () => {
    writeDesignDocsVersionMarker(tempDir)
    expect(existsSync(join(tempDir, ".design-docs-version"))).toBe(true)
  })

  test("readDesignDocsVersionMarker reads what write wrote", () => {
    writeDesignDocsVersionMarker(tempDir)
    let version = readDesignDocsVersionMarker(tempDir)
    expect(version).toBe(currentDesignDocsVersion())
  })

  test("readDesignDocsVersionMarker returns null for missing directory", () => {
    let version = readDesignDocsVersionMarker(join(tempDir, "nonexistent"))
    expect(version).toBeNull()
  })
})
