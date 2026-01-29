import { execSync } from "node:child_process"
import { existsSync, lstatSync } from "node:fs"
import { join } from "node:path"
import { currentVersion, readVersionMarker } from "../lib/docs.mjs"
import { ExitError } from "../lib/errors.mjs"

const TOOLS = [
  { name: "botbus", check: "botbus --version" },
  { name: "maw", check: "maw --version" },
  { name: "br", check: "br --version" },
  { name: "bv", check: "bv --version" },
  { name: "crit", check: "crit --version" },
  { name: "botty", check: "botty --version" },
  { name: "jj", check: "jj --version" },
]

export function doctor() {
  const projectDir = process.cwd()
  let issues = 0

  // Check tools
  console.log("Tools:")
  for (const tool of TOOLS) {
    try {
      const version = execSync(tool.check, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim()
      console.log(`  ✓ ${tool.name}: ${version}`)
    } catch {
      console.log(`  ✗ ${tool.name}: not found`)
      issues++
    }
  }

  // Check .agents/botbox/
  console.log("\nProject:")
  const agentsDir = join(projectDir, ".agents", "botbox")
  if (existsSync(agentsDir)) {
    console.log("  ✓ .agents/botbox/ exists")

    const installed = readVersionMarker(agentsDir)
    const latest = currentVersion()
    if (installed === latest) {
      console.log(`  ✓ workflow docs up to date (${latest})`)
    } else {
      console.log(`  ✗ workflow docs stale (${installed} → ${latest})`)
      issues++
    }
  } else {
    console.log("  ✗ .agents/botbox/ not found (run botbox init)")
    issues++
  }

  // Check AGENTS.md
  const agentsMd = join(projectDir, "AGENTS.md")
  if (existsSync(agentsMd)) {
    console.log("  ✓ AGENTS.md exists")
  } else {
    console.log("  ✗ AGENTS.md not found")
    issues++
  }

  // Check CLAUDE.md symlink
  const claudeMd = join(projectDir, "CLAUDE.md")
  if (existsSync(claudeMd)) {
    const stat = lstatSync(claudeMd)
    if (stat.isSymbolicLink()) {
      console.log("  ✓ CLAUDE.md → AGENTS.md")
    } else {
      console.log("  ⚠ CLAUDE.md exists but is not a symlink")
    }
  } else {
    console.log("  ✗ CLAUDE.md not found")
    issues++
  }

  // Check beads
  const beadsDir = join(projectDir, ".beads")
  if (existsSync(beadsDir)) {
    console.log("  ✓ .beads/ initialized")
  } else {
    console.log("  ⚠ .beads/ not found (optional)")
  }

  console.log(
    `\n${issues === 0 ? "All checks passed." : `${issues} issue(s) found.`}`,
  )

  if (issues > 0) {
    throw new ExitError("", issues)
  }
}
