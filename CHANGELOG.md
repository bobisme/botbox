# Changelog

## [0.29.1] — 2026-09-07

### Fixed

- Made the authoring agent, rather than the workspace-write Daybreak reviewer, own the anchored Rite handoff, review-claim release, and Vessel session lifecycle.
- Explicitly terminate each exact security-review Vessel session after a verified Seal verdict or after a snapshot on an unverified outcome; graceful Codex exit is followed by a bounded exact-session kill backstop.

## [0.29.0] - 2026-09-06

### Changed

- Replaced the ambient security reviewer loop and `@<project>-security` launch hooks with an explicit, exact-target Codex Daybreak security review session managed through Vessel and Agentbus.
- Retained Seal reviewer identities and approval gates while making Daybreak review completion fail closed unless the reviewer records a verified Seal vote.

### Migration

- `edict sync` retires only Edict-owned named reviewer hooks and removes the retired reviewer-loop configuration and managed templates.
