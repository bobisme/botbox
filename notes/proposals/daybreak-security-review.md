# Proposal: Explicit Daybreak Security Review Sessions

**Status**: ACCEPTED
**Bone**: bn-11qk
**Author**: edict-dev
**Date**: 2026-09-06

## Summary

Retire Edict's hook-triggered `reviewer-loop` and the `@<project>-security`
mention contract. The requesting agent will launch one dedicated Codex session
through Vessel for one explicit Seal review, using
`gpt-daybreak-blue-latest`. The review agent receives the review id, workspace,
commit, canonical Seal/Rite identity, and reply anchor as an explicit contract;
it never discovers work by scanning unrelated workspaces.

## Motivation

The current chain is hook -> Vessel -> `edict run reviewer-loop` -> Pi/Claude.
It has two distinct execution layers and selects review work from a project-wide
scan. `find_work` can silently skip a workspace; the prompt's primary workspace
comes from the first discovered item even when it lists several. The generic
`agent://<project>-security` hook lease also serializes unrelated reviews.

`gpt-daybreak-blue-latest` is available through Codex, not the Pi runner used
for non-Anthropic models by `run_agent("auto")`, so it cannot be made reliable
by changing the old reviewer's configured model.

## Proposed Design

### Explicit launcher contract

Add a managed workflow document that requires the authoring agent, immediately
after `seal reviews create`, to start a unique Vessel Codex reviewer with:

- review id and exact workspace name;
- current workspace commit and the persisted Seal range;
- canonical reviewer identity `<project>-security` for Seal and Rite;
- Rite request anchor for the verdict reply; and
- `review://<project>/<review-id>` claim ownership.

The session name is process-only and unique (review id plus commit); it is not
the Seal reviewer identity. Vessel labels include `project:`, `review:`,
`workspace:`, and `role:security-review` so agents can inspect or stop exactly
the intended session. The session's `--cwd` is the review workspace and it uses
Codex with `gpt-daybreak-blue-latest`.

### Security-reviewer contract

The dedicated agent handles exactly one review or re-review. It verifies the
supplied review against its supplied workspace before it reads the diff, uses
`maw exec <workspace> -- seal ...` for Seal mutations, and makes only review
metadata/Rite writes. It must inspect the full persisted range, preserve the
risk:high failure-mode checklist and risk:critical human gate, vote, and reply
to the supplied Rite anchor. It may not edit source, commit, merge, push, or
discover another review.

The launching agent records a timestamp before submitting the prompt, obtains
the Vessel PID, and watches with `agentbus wait --pid ... --since ... --json`.
It treats a blocked, timeout, or unavailable Agentbus result as failure, posts
an anchored blocker, and releases the review claim. It verifies the Seal vote;
model prose alone never counts as approval.

### Retire the ambient reviewer path

Edict-owned named reviewer hooks are removed in a sync migration. Workflow
documents no longer ask authors to mention `@<project>-security`; review
assignment in Seal remains, because the Seal approval gate still requires the
canonical reviewer identity. `reviewer-loop`, its prompt templates, and
`agents.reviewer` configuration are removed rather than left as a competing
automatic path.

## Answered Questions

1. **Should a plain prose recipe replace the loop?** No. The recipe must carry
   an explicit structured target and terminal failure rules. A workflow document
   is sufficient for the first implementation because author agents already
   own the created review id and workspace; a future CLI wrapper remains an
   option if repeated command transcription proves unreliable.
2. **Should `@<project>-security` remain as a compatibility trigger?** No. A
   mention has no authoritative review/workspace binding. Retaining it would
   preserve the ambiguous dispatch path and duplicate review risk.
3. **Does Daybreak remove the need for a watchdog?** No. The live read-only
   Vessel experiment launched and Agentbus resolved its descendant PID, but its
   session over-explored and did not publish a timely terminal result. The
   launcher must time out and fail closed.

## Alternatives Considered

- **Keep the loop and change only its model.** Rejected: Daybreak would still
  route to Pi, and the ambient scan/first-workspace ambiguity remains.
- **Replace the hook command with `vessel spawn codex`.** Rejected: a Rite
  mention alone contains no verified review/workspace contract.
- **Add a Rust launcher subcommand now.** Deferred: it is a larger execution
  surface than the requested agent-managed workflow. The documentation contract
  and test fixtures first establish the stable inputs a later wrapper would own.

## Implementation Plan

1. Add the Daybreak/Vessel/Agentbus direct-review workflow and complete
   single-review security prompt, including exact target, claim, timeout, Seal,
   Rite, and re-review rules.
2. Remove Edict-owned security reviewer hook registration, loop command,
   reviewer config/templates, and add a sync migration that removes only
   Edict-owned named reviewer hooks.
3. Cover the replacement with unit and isolated lifecycle tests: exact target
   with multiple reviews, hook retirement, migration idempotence, failure
   behavior, and documentation/config sync.
