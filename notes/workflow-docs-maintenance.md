# Workflow Docs Maintenance

## Where Docs Live

Workflow docs live in `packages/cli/docs/` and are bundled with the npm package. When `botbox init` runs in a target project, they're copied into `.agents/botbox/` and referenced from the generated AGENTS.md.

## Doc Index

| Doc | Purpose |
|-----|---------|
| [triage.md](../packages/cli/docs/triage.md) | Find exactly one actionable bead from inbox and ready queue |
| [start.md](../packages/cli/docs/start.md) | Claim a bead, create a workspace, announce |
| [update.md](../packages/cli/docs/update.md) | Post progress updates during work |
| [finish.md](../packages/cli/docs/finish.md) | Close bead, merge workspace, release claims, sync |
| [worker-loop.md](../packages/cli/docs/worker-loop.md) | Full triage-start-work-finish lifecycle |
| [review-request.md](../packages/cli/docs/review-request.md) | Request a code review via crit |
| [review-response.md](../packages/cli/docs/review-response.md) | Handle reviewer feedback (fix/address/defer) and merge after LGTM |
| [review-loop.md](../packages/cli/docs/review-loop.md) | Reviewer agent loop until no pending reviews |
| [merge-check.md](../packages/cli/docs/merge-check.md) | Verify approval before merging |
| [preflight.md](../packages/cli/docs/preflight.md) | Validate toolchain health before starting work |
| [report-issue.md](../packages/cli/docs/report-issue.md) | Report bugs/features to other projects via #projects registry |
| [groom.md](../packages/cli/docs/groom.md) | Groom ready beads: fix titles, descriptions, priorities, break down large tasks |

## When to Update Docs

These docs define the protocol that every agent follows. Update them when:
- A bus/maw/br/crit/botty CLI changes its flags or behavior
- You discover a missing step, ambiguity, or edge case during real agent runs
- A new workflow is added (e.g., a new review strategy, a new teardown step)

Do **not** update docs for project-specific conventions — those belong in the target project's AGENTS.md above the managed section.

## How to Update Docs

1. Edit the file in `packages/cli/docs/`
2. Run `bun test` — the version hash will change, confirming the update is detected
3. If adding a new doc, add an entry to the `DOC_DESCRIPTIONS` map in `src/lib/templates.mjs`
4. Target projects pick up changes on their next `botbox sync`
