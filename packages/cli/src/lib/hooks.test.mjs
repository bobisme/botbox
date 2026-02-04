import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  listAllHooks,
  listEligibleHooks,
  copyHooks,
  updateExistingHooks,
  currentHooksVersion,
  writeHooksVersionMarker,
  readHooksVersionMarker,
  generateHooksConfig,
} from "./hooks.mjs"

describe("listAllHooks", () => {
  test("returns an array of .sh filenames", () => {
    let hooks = listAllHooks()
    expect(hooks.length).toBeGreaterThan(0)
    for (let h of hooks) {
      expect(h).toEndWith(".sh")
    }
  })

  test("includes known hooks", () => {
    let hooks = listAllHooks()
    expect(hooks).toContain("init-agent.sh")
    expect(hooks).toContain("check-bus-inbox.sh")
  })
})

describe("listEligibleHooks", () => {
  test("hooks eligible with botbus tool", () => {
    let eligible = listEligibleHooks({ tools: ["botbus"] })
    expect(eligible).toContain("init-agent.sh")
    expect(eligible).toContain("check-bus-inbox.sh")
  })

  test("no hooks without botbus tool", () => {
    let eligible = listEligibleHooks({ tools: ["beads", "maw"] })
    expect(eligible).toHaveLength(0)
  })
})

describe("copyHooks", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-hooks-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("copies eligible hooks to target dir", () => {
    let target = join(tempDir, "hooks")
    let copied = copyHooks(target, { tools: ["botbus"] })

    expect(copied.length).toBe(2)
    for (let file of copied) {
      expect(existsSync(join(target, file))).toBe(true)
    }
  })

  test("returns empty array when no hooks eligible", () => {
    let target = join(tempDir, "hooks")
    let copied = copyHooks(target, { tools: [] })
    expect(copied).toHaveLength(0)
    expect(existsSync(target)).toBe(false)
  })
})

describe("updateExistingHooks", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-hooks-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("re-copies only hooks that exist in target", () => {
    let target = join(tempDir, "hooks")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "init-agent.sh"), "old content")

    let updated = updateExistingHooks(target)
    expect(updated).toContain("init-agent.sh")
    expect(updated).not.toContain("check-bus-inbox.sh")
  })
})

describe("currentHooksVersion", () => {
  test("returns a 12-character hex string", () => {
    let version = currentHooksVersion()
    expect(version).toMatch(/^[0-9a-f]{12}$/)
  })

  test("is deterministic", () => {
    let v1 = currentHooksVersion()
    let v2 = currentHooksVersion()
    expect(v1).toBe(v2)
  })
})

describe("hooks version markers", () => {
  /** @type {string} */
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "botbox-hooks-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("writeHooksVersionMarker creates a .hooks-version file", () => {
    writeHooksVersionMarker(tempDir)
    expect(existsSync(join(tempDir, ".hooks-version"))).toBe(true)
  })

  test("readHooksVersionMarker reads what write wrote", () => {
    writeHooksVersionMarker(tempDir)
    let version = readHooksVersionMarker(tempDir)
    expect(version).toBe(currentHooksVersion())
  })

  test("readHooksVersionMarker returns null for missing directory", () => {
    let version = readHooksVersionMarker(join(tempDir, "nonexistent"))
    expect(version).toBeNull()
  })
})

describe("generateHooksConfig", () => {
  test("generates correct hooks config structure", () => {
    let config = generateHooksConfig("/abs/path/hooks", [
      "init-agent.sh",
      "check-bus-inbox.sh",
    ])

    expect(config.SessionStart).toBeDefined()
    expect(config.SessionStart).toHaveLength(1)
    expect(config.SessionStart[0]).toEqual({
      type: "command",
      command: "/abs/path/hooks/init-agent.sh",
    })

    expect(config.PostToolUse).toBeDefined()
    expect(config.PostToolUse).toHaveLength(1)
    expect(config.PostToolUse[0]).toEqual({
      type: "command",
      command: "/abs/path/hooks/check-bus-inbox.sh",
    })
  })

  test("returns empty object for no hooks", () => {
    let config = generateHooksConfig("/abs/path/hooks", [])
    expect(config).toEqual({})
  })
})
