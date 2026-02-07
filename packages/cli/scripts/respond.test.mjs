import { describe, expect, it } from "bun:test"
import { routeMessage } from "./respond.mjs"

describe("routeMessage", () => {
  // --- !oneshot ---
  describe("!oneshot prefix", () => {
    it("routes !oneshot with body", () => {
      let route = routeMessage("!oneshot what time is it?")
      expect(route).toEqual({ type: "oneshot", body: "what time is it?" })
    })

    it("routes bare !oneshot", () => {
      let route = routeMessage("!oneshot")
      expect(route).toEqual({ type: "oneshot", body: "" })
    })

    it("is case-insensitive", () => {
      let route = routeMessage("!ONESHOT hello")
      expect(route).toEqual({ type: "oneshot", body: "hello" })
    })

    it("takes priority over other routes", () => {
      // !oneshot should match before !dev, !q, etc.
      let route = routeMessage("!oneshot !dev something")
      expect(route.type).toBe("oneshot")
    })
  })

  // --- !dev ---
  describe("!dev prefix", () => {
    it("routes !dev with body", () => {
      let route = routeMessage("!dev fix the login page")
      expect(route).toEqual({ type: "dev", body: "fix the login page" })
    })

    it("routes bare !dev", () => {
      let route = routeMessage("!dev")
      expect(route).toEqual({ type: "dev", body: "" })
    })

    it("is case-insensitive", () => {
      let route = routeMessage("!DEV fix something")
      expect(route).toEqual({ type: "dev", body: "fix something" })
    })

    it("handles leading whitespace", () => {
      let route = routeMessage("  !dev fix it")
      expect(route).toEqual({ type: "dev", body: "fix it" })
    })
  })

  // --- !bead ---
  describe("!bead prefix", () => {
    it("routes !bead with description", () => {
      let route = routeMessage("!bead add rate limiting to the API")
      expect(route).toEqual({
        type: "bead",
        body: "add rate limiting to the API",
      })
    })

    it("routes bare !bead", () => {
      let route = routeMessage("!bead")
      expect(route).toEqual({ type: "bead", body: "" })
    })

    it("is case-insensitive", () => {
      let route = routeMessage("!BEAD add tests")
      expect(route).toEqual({ type: "bead", body: "add tests" })
    })
  })

  // --- !q variants ---
  describe("!q prefix (sonnet)", () => {
    it("routes !q with question", () => {
      let route = routeMessage("!q how does auth work?")
      expect(route).toEqual({
        type: "question",
        model: "sonnet",
        body: "how does auth work?",
      })
    })

    it("routes bare !q", () => {
      let route = routeMessage("!q")
      expect(route).toEqual({ type: "question", model: "sonnet", body: "" })
    })
  })

  describe("!qq prefix (haiku)", () => {
    it("routes !qq with question", () => {
      let route = routeMessage("!qq what version are we on?")
      expect(route).toEqual({
        type: "question",
        model: "haiku",
        body: "what version are we on?",
      })
    })

    it("does not match !q (must be !qq)", () => {
      // !qq should match before !q
      let route = routeMessage("!qq fast question")
      expect(route.model).toBe("haiku")
    })
  })

  describe("!bigq prefix (opus)", () => {
    it("routes !bigq with question", () => {
      let route = routeMessage("!bigq analyze the performance bottleneck")
      expect(route).toEqual({
        type: "question",
        model: "opus",
        body: "analyze the performance bottleneck",
      })
    })
  })

  describe("!q(model) prefix (explicit)", () => {
    it("routes !q(haiku) with question", () => {
      let route = routeMessage("!q(haiku) quick question")
      expect(route).toEqual({
        type: "question",
        model: "haiku",
        body: "quick question",
      })
    })

    it("routes !q(opus) with question", () => {
      let route = routeMessage("!q(opus) deep analysis needed")
      expect(route).toEqual({
        type: "question",
        model: "opus",
        body: "deep analysis needed",
      })
    })

    it("lowercases the model name", () => {
      let route = routeMessage("!q(SONNET) question")
      expect(route.model).toBe("sonnet")
    })

    it("takes priority over !q", () => {
      let route = routeMessage("!q(haiku) test")
      expect(route.model).toBe("haiku")
      expect(route.type).toBe("question")
    })
  })

  // --- Backwards compat: old colon prefixes ---
  describe("backwards compat: q: prefix", () => {
    it("routes q: with question", () => {
      let route = routeMessage("q: how does auth work?")
      expect(route).toEqual({
        type: "question",
        model: "sonnet",
        body: "how does auth work?",
      })
    })
  })

  describe("backwards compat: qq: prefix", () => {
    it("routes qq: with question", () => {
      let route = routeMessage("qq: what version?")
      expect(route).toEqual({
        type: "question",
        model: "haiku",
        body: "what version?",
      })
    })
  })

  describe("backwards compat: big q: prefix", () => {
    it("routes big q: with question", () => {
      let route = routeMessage("big q: analyze this")
      expect(route).toEqual({
        type: "question",
        model: "opus",
        body: "analyze this",
      })
    })

    it("is case-insensitive", () => {
      let route = routeMessage("Big Q: deep question")
      expect(route.model).toBe("opus")
    })
  })

  describe("backwards compat: q(model): prefix", () => {
    it("routes q(haiku): with question", () => {
      let route = routeMessage("q(haiku): quick one")
      expect(route).toEqual({
        type: "question",
        model: "haiku",
        body: "quick one",
      })
    })
  })

  // --- Triage (no prefix) ---
  describe("triage (no prefix)", () => {
    it("routes plain text to triage", () => {
      let route = routeMessage("hey how is the refactor going?")
      expect(route).toEqual({
        type: "triage",
        body: "hey how is the refactor going?",
      })
    })

    it("routes work-like messages to triage (not dev)", () => {
      // Even work-sounding messages without !dev go to triage — the handler classifies
      let route = routeMessage(
        "the signup form crashes when you enter a long email",
      )
      expect(route.type).toBe("triage")
    })

    it("trims whitespace", () => {
      let route = routeMessage("  hello  ")
      expect(route.body).toBe("hello")
    })
  })

  // --- Edge cases ---
  describe("edge cases", () => {
    it("does not match ! alone", () => {
      let route = routeMessage("! something")
      expect(route.type).toBe("triage")
    })

    it("does not match !devops as !dev", () => {
      // \b boundary: !devops should NOT match !dev
      let route = routeMessage("!devops pipeline is broken")
      expect(route.type).toBe("triage")
    })

    it("does not match !beadwork as !bead", () => {
      let route = routeMessage("!beadwork is fun")
      expect(route.type).toBe("triage")
    })

    it("handles empty string", () => {
      let route = routeMessage("")
      expect(route.type).toBe("triage")
      expect(route.body).toBe("")
    })

    it("handles multiline messages", () => {
      let route = routeMessage("!dev fix this\nit's broken\nurgent")
      expect(route.type).toBe("dev")
      expect(route.body).toBe("fix this\nit's broken\nurgent")
    })

    it("!q does not consume first word of body", () => {
      let route = routeMessage("!q question about something")
      expect(route.body).toBe("question about something")
    })
  })
})
