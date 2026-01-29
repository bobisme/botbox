# botbox

botbox is a decentralized, chat-first toolkit for coordinating multiple coding agents across repos. It is a metaproject that defines the workflow, conventions, and glue between companion tools.

## Goals

- **Decentralized coordination**: no mayor, no central orchestrator, any agent can claim, spawn, and review.
- **Chat-first ergonomics**: human-readable messages with lightweight labels for machine parsing.
- **Conflict avoidance**: explicit claims for files, beads, and agent roles.
- **Parallel work at scale**: isolated workspaces per agent and a shared work ledger.
- **Review as a first-class loop**: distributed reviews with reviewer agents and re-review flows.
- **Cross-repo consistency**: shared AGENTS templates and protocols that work across tools.

## Stack

- botbus: communication, claims, and agent presence
- maw: isolated jj workspaces per agent
- beads (br/bv): work tracking ledger + agent planning views
- botcrit: reviews as event streams
- botty: runtime for spawning agents

## Docs

- `site/index.html`
- `https://raw.githubusercontent.com/bobisme/ai-docs/main/agents/AGENTS.multi-agent.md`
- `https://raw.githubusercontent.com/bobisme/ai-docs/main/agents/mesh-protocol.md`

## Status

Early and evolving. Expect conventions to stabilize as the tooling converges.
