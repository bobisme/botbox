import { describe, expect, test } from "bun:test"
import {
  parseAgentsMdHeader,
  renderAgentsMd,
  updateManagedSection,
} from "./templates.mjs"

describe("renderAgentsMd", () => {
  test("includes project name as heading", () => {
    let result = renderAgentsMd({
      name: "my-api",
      type: "api",
      tools: ["beads", "maw"],
      reviewers: [],
    })
    expect(result).toStartWith("# my-api")
  })

  test("includes project type", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "frontend",
      tools: ["beads"],
      reviewers: [],
    })
    expect(result).toContain("Project type: frontend")
  })

  test("lists tools as inline code", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: ["beads", "maw", "crit"],
      reviewers: [],
    })
    expect(result).toContain("`beads`")
    expect(result).toContain("`maw`")
    expect(result).toContain("`crit`")
  })

  test("includes reviewer roles when provided", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: ["beads"],
      reviewers: ["security", "correctness"],
    })
    expect(result).toContain("Reviewer roles: security, correctness")
  })

  test("omits reviewer section when empty", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: ["beads"],
      reviewers: [],
    })
    expect(result).not.toContain("Reviewer roles:")
  })

  test("contains managed section markers", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: [],
      reviewers: [],
    })
    expect(result).toContain("<!-- botbox:managed-start -->")
    expect(result).toContain("<!-- botbox:managed-end -->")
  })

  test("managed section contains workflow doc links", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: [],
      reviewers: [],
    })
    expect(result).toContain(".agents/botbox/triage.md")
    expect(result).toContain(".agents/botbox/finish.md")
    expect(result).toContain(".agents/botbox/worker-loop.md")
  })

  test("managed section contains stack reference table", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: [],
      reviewers: [],
    })
    expect(result).toContain("| bus |")
    expect(result).toContain("| maw |")
    expect(result).toContain("| br/bv |")
    expect(result).toContain("| crit |")
    expect(result).toContain("| botty |")
  })

  test("managed section contains quick start", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: [],
      reviewers: [],
    })
    expect(result).toContain("### Quick Start")
    expect(result).toContain("bus generate-name")
    expect(result).toContain("br ready")
  })

  test("managed section contains beads conventions", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: [],
      reviewers: [],
    })
    expect(result).toContain("### Beads Conventions")
    expect(result).toContain("br sync --flush-only")
  })

  test("managed section contains mesh protocol", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: [],
      reviewers: [],
    })
    expect(result).toContain("### Mesh Protocol")
    expect(result).toContain("-L mesh")
    expect(result).toContain("bus claims stake")
    expect(result).toContain("bus claims release")
  })

  test("managed section contains spawning agents", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: [],
      reviewers: [],
    })
    expect(result).toContain("### Spawning Agents")
    expect(result).toContain("bus agents")
    expect(result).toContain("-L spawn-ack")
  })

  test("managed section contains reviews", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: [],
      reviewers: [],
    })
    expect(result).toContain("### Reviews")
    expect(result).toContain("crit")
    expect(result).toContain("agent://reviewer-")
  })

  test("managed section contains cross-project feedback", () => {
    let result = renderAgentsMd({
      name: "test",
      type: "api",
      tools: [],
      reviewers: [],
    })
    expect(result).toContain("### Cross-Project Feedback")
    expect(result).toContain("#projects")
    expect(result).toContain("report-issue.md")
    expect(result).toContain("-L feedback")
  })
})

describe("updateManagedSection", () => {
  test("replaces existing managed section", () => {
    let input = [
      "# My Project",
      "",
      "Custom content here.",
      "",
      "<!-- botbox:managed-start -->",
      "old managed content",
      "<!-- botbox:managed-end -->",
      "",
      "Footer content.",
    ].join("\n")

    let result = updateManagedSection(input)

    expect(result).toContain("# My Project")
    expect(result).toContain("Custom content here.")
    expect(result).toContain("Footer content.")
    expect(result).not.toContain("old managed content")
    expect(result).toContain("## Botbox Workflow")
  })

  test("preserves content before managed section", () => {
    let input = [
      "# My Project",
      "",
      "Important project-specific docs.",
      "",
      "<!-- botbox:managed-start -->",
      "old stuff",
      "<!-- botbox:managed-end -->",
    ].join("\n")

    let result = updateManagedSection(input)
    expect(result).toContain("Important project-specific docs.")
  })

  test("preserves content after managed section", () => {
    let input = [
      "<!-- botbox:managed-start -->",
      "old stuff",
      "<!-- botbox:managed-end -->",
      "",
      "Custom footer.",
    ].join("\n")

    let result = updateManagedSection(input)
    expect(result).toContain("Custom footer.")
  })

  test("appends managed section when markers are missing", () => {
    let input = "# My Project\n\nNo markers here.\n"

    let result = updateManagedSection(input)
    expect(result).toStartWith("# My Project")
    expect(result).toContain("<!-- botbox:managed-start -->")
    expect(result).toContain("## Botbox Workflow")
    expect(result).toContain("<!-- botbox:managed-end -->")
  })

  test("handles empty input", () => {
    let result = updateManagedSection("")
    expect(result).toContain("<!-- botbox:managed-start -->")
    expect(result).toContain("<!-- botbox:managed-end -->")
  })

  test("handles markers in wrong order", () => {
    let input = [
      "# My Project",
      "",
      "<!-- botbox:managed-end -->",
      "some content",
      "<!-- botbox:managed-start -->",
    ].join("\n")

    let result = updateManagedSection(input)
    let starts = result.split("<!-- botbox:managed-start -->").length - 1
    let ends = result.split("<!-- botbox:managed-end -->").length - 1
    expect(starts).toBe(1)
    expect(ends).toBe(1)
    expect(result.indexOf("<!-- botbox:managed-start -->")).toBeLessThan(
      result.indexOf("<!-- botbox:managed-end -->"),
    )
  })

  test("handles only start marker present", () => {
    let input = "# My Project\n\n<!-- botbox:managed-start -->\norphaned"

    let result = updateManagedSection(input)
    let starts = result.split("<!-- botbox:managed-start -->").length - 1
    let ends = result.split("<!-- botbox:managed-end -->").length - 1
    expect(starts).toBe(1)
    expect(ends).toBe(1)
    expect(result).toContain("# My Project")
    expect(result).toContain("## Botbox Workflow")
  })

  test("handles only end marker present", () => {
    let input = "# My Project\n\n<!-- botbox:managed-end -->\ntrailing"

    let result = updateManagedSection(input)
    expect(result).toContain("<!-- botbox:managed-start -->")
    expect(result).toContain("<!-- botbox:managed-end -->")
    expect(result).toContain("# My Project")
  })
})

describe("parseAgentsMdHeader", () => {
  test("parses name from heading", () => {
    let result = parseAgentsMdHeader("# my-project\n\nProject type: api\nTools: `beads`\n")
    expect(result.name).toBe("my-project")
  })

  test("parses single project type", () => {
    let result = parseAgentsMdHeader("# test\n\nProject type: api\nTools: `beads`\n")
    expect(result.type).toEqual(["api"])
  })

  test("parses multiple project types", () => {
    let result = parseAgentsMdHeader("# test\n\nProject type: cli, api\nTools: `beads`\n")
    expect(result.type).toEqual(["cli", "api"])
  })

  test("parses tools with backtick wrapping", () => {
    let result = parseAgentsMdHeader(
      "# test\n\nProject type: api\nTools: `beads`, `maw`, `crit`\n",
    )
    expect(result.tools).toEqual(["beads", "maw", "crit"])
  })

  test("parses reviewer roles", () => {
    let result = parseAgentsMdHeader(
      "# test\n\nProject type: api\nTools: `beads`\nReviewer roles: security, correctness\n",
    )
    expect(result.reviewers).toEqual(["security", "correctness"])
  })

  test("returns empty reviewers when line absent", () => {
    let result = parseAgentsMdHeader("# test\n\nProject type: api\nTools: `beads`\n")
    expect(result.reviewers).toEqual([])
  })

  test("stops parsing at managed section marker", () => {
    let content =
      "# test\n\nProject type: api\nTools: `beads`\n\n<!-- botbox:managed-start -->\n# not-a-name\n"
    let result = parseAgentsMdHeader(content)
    expect(result.name).toBe("test")
  })

  test("round-trips with renderAgentsMd", () => {
    let original = {
      name: "my-api",
      type: ["cli", "api"],
      tools: ["beads", "maw", "crit"],
      reviewers: ["security"],
    }
    let rendered = renderAgentsMd(original)
    let detected = parseAgentsMdHeader(rendered)
    expect(detected.name).toBe("my-api")
    expect(detected.type).toEqual(["cli", "api"])
    expect(detected.tools).toEqual(["beads", "maw", "crit"])
    expect(detected.reviewers).toEqual(["security"])
  })

  test("round-trips with no reviewers", () => {
    let rendered = renderAgentsMd({
      name: "test",
      type: "library",
      tools: ["beads"],
      reviewers: [],
    })
    let detected = parseAgentsMdHeader(rendered)
    expect(detected.name).toBe("test")
    expect(detected.reviewers).toEqual([])
  })

  test("handles empty content", () => {
    let result = parseAgentsMdHeader("")
    expect(result.name).toBeUndefined()
    expect(result.type).toBeUndefined()
    expect(result.tools).toBeUndefined()
  })

  test("ignores user content between header and managed section", () => {
    let content = [
      "# my-project",
      "",
      "Project type: library",
      "Tools: `beads`, `maw`",
      "",
      "## Architecture",
      "This is a library that does things.",
      "",
      "<!-- botbox:managed-start -->",
    ].join("\n")
    let result = parseAgentsMdHeader(content)
    expect(result.name).toBe("my-project")
    expect(result.type).toEqual(["library"])
    expect(result.tools).toEqual(["beads", "maw"])
  })
})
