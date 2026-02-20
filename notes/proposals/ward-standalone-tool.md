# Proposal: Ward as a Standalone Security Reviewer

**Status**: PROPOSAL
**Bead**: bd-311g
**Author**: bob
**Date**: 2026-02-20

## Summary

Create `ward` as a standalone security review tool and use it from botbox as an integration consumer.

Ward owns the security intelligence surface (policy packs, deterministic checks, evidence graph, scoring, artifacts, evals), while botbox continues to own orchestration (agent loops, messaging, workspaces, crit comments/votes).

## Why Standalone

Security review requirements now justify a dedicated product boundary:

- Independent release cadence for rule packs, analyzer integrations, and scoring logic.
- Clear ownership model for security policy and suppression governance.
- Reuse outside botbox (CI, pre-merge checks, local developer workflows, other orchestrators).
- Cleaner architecture in botbox (stable CLI contract instead of deep internal coupling).

## Current State

Today, botbox security review runs inside `reviewer-loop` with prompt guidance and crit voting. The current proposal work expanded this to a data-driven model (policy packs, EvidenceFacts, scoring, artifacts). This proposal defines where that capability should live: in `ward`.

## Product Scope

### In scope (Ward)

- Policy/rule pack system (schema, tests, versioning, signing, lockfile).
- Deterministic detector runner and analyzer adapter layer.
- Evidence graph and finding synthesis pipeline.
- Risk scoring and assurance gating.
- Structured outputs (`ward-review.json`, SARIF, coverage/baseline artifacts).
- Replay and benchmark evaluation harness.

### Out of scope (Ward)

- Channel messaging, claims, and reviewer agent orchestration.
- Workspace lifecycle and merge logic.
- Crit thread storage and reviewer assignment.

Those remain botbox responsibilities.

## Ward CLI Contract (v1)

Primary commands:

- `ward review` - run review on a diff/workspace and emit findings.
- `ward rules validate` - validate rule/pack schemas and manifests.
- `ward rules test` - run per-rule fixtures (positive/negative).
- `ward eval replay` - run replay suites and report quality metrics.
- `ward baseline` - manage accepted carryover findings.

Recommended v1 `ward review` interface:

```bash
ward review \
  --repo /path/to/repo \
  --base <base-rev> \
  --head <head-rev> \
  --profile default \
  --config ward.yaml \
  --format json \
  --out ./artifacts
```

Contract guarantees:

- Stable JSON schema with semantic versioning.
- Non-zero exit for execution failures; successful runs always produce artifacts.
- Explicit `incomplete_analysis` and coverage fields (never silent success).

## Data and Artifact Model

Ward emits:

- `ward-review.json` - canonical findings and evidence.
- `ward.sarif` - interoperability for broader toolchains.
- `ward-coverage.json` - surface coverage, tool health, completeness.
- `ward-baseline.json` - accepted carryover findings with expiry metadata.

Each finding includes:

- stable finding ID
- rule ID and mapping (CWE/OWASP)
- severity and confidence
- risk breakdown (`impact`, `exploitability`, `reachability`, `risk_adjusted`)
- evidence references (file/line/path)
- remediation and verification guidance

## Configuration and Policy Packs

Ward uses two config layers:

1. Global/default profile packs (signed, versioned).
2. Repo-local `ward.yaml` profile (exposure, criticality, allowed analyzers, model policy).

Pack lifecycle:

- Manifests and semver for each pack.
- Signature verification for pack integrity.
- `pack-lock.json` for reproducible selection.
- Optional repo overlays with explicit approval metadata.

## Architecture

### 1) Execution Plane

- Sandbox-by-default analyzer wrapper (resource limits, network-off by default).
- Bounded retries and explicit timeout policy.
- Deterministic stage orchestration and tool/version capture.

### 2) Analysis Plane

- Repo fingerprinting and semantic ROI selection.
- Incremental evidence graph (symbols, calls, lightweight dataflow, auth boundaries, IaC edges).
- Deterministic detectors and analyzer adapters.
- Two-pass synthesis (LLM JSON output, then deterministic verification/counterexample checks).

### 3) Decision Plane

- Per-finding risk scoring.
- Context multipliers (exposure and asset criticality).
- Run-level assurance gating to avoid false-negative LGTMs.

### 4) Explainability Plane

- Human-readable summaries and machine-readable artifacts.
- Triage states (`new`, `regressed`, `existing`, `fixed`, `suppressed`).
- Noise control via baseline-aware output.

### 5) Learning Plane

- Replay harness for historical PRs and incident-linked commits.
- Standard benchmark suites and adversarial suites.
- Regression gates for rule/prompt/analyzer updates.

## Integration with Botbox

Botbox reviewer-loop becomes a client of Ward:

1. Reviewer-loop identifies the review workspace and diff.
2. It invokes `ward review` with repo/diff/profile inputs.
3. It maps ward output to crit comments and vote policy.
4. It posts summary to bus as today.

Minimal integration contract:

- Botbox depends only on Ward CLI input/output schemas.
- Botbox does not parse internal Ward rule files directly.
- Ward version is pinned in botbox config and surfaced in reviewer telemetry.

## Repository and Delivery Plan

Recommended structure:

- New repository: `ward`
- Runtime: Rust CLI (matches botbox ecosystem)
- Docs: architecture, schema, policy-pack authoring, suppression governance
- Release channel: semantic versions + changelog + schema compatibility notes

## Rollout Plan

### Phase A: In-repo incubation behind CLI boundary

- Implement `ward` as internal binary/module with strict external CLI contract.
- Update botbox reviewer-loop to call contract only.
- Run shadow mode and collect metrics.

### Phase B: Extract to standalone repo

- Move Ward code, schemas, and pack tooling to dedicated repository.
- Keep compatibility shim in botbox during transition.
- Cut initial stable release (`v0.1.0`) and pin from botbox.

### Phase C: Harden and scale

- Expand analyzer coverage and profile presets.
- Add hosted and self-managed policy-pack distribution options.
- Formalize governance workflows for suppressions and overrides.

## Success Criteria

- Botbox reviewer-loop uses Ward via stable CLI contract with no behavior regressions.
- Blocking-finding precision and false-positive goals are met on replay suites.
- High-risk coverage and incomplete-analysis visibility improve measurably.
- Policy updates ship independently of botbox core releases.

## Risks and Mitigations

- **Integration friction**: define strict schema contracts and compatibility tests.
- **Operational overhead**: start with single repo incubation before full split.
- **Performance drift**: enforce budget SLOs and cache aggressively.
- **Tool-chain risk**: sandbox analyzers and lock analyzer versions.
- **Governance complexity**: require explicit owner/expiry/approver on suppressions.

## Open Questions

1. Should `ward.yaml` allow project-local policy overrides by default or require opt-in per org?
2. What default analyzer allowlist ships in v1?
3. How should Ward package and verify signed policy packs in offline environments?
4. Should botbox treat Ward `incomplete_analysis` as automatic NEEDS_HUMAN_REVIEW everywhere or only on high-risk surfaces?
5. What long-term compatibility policy do we want for Ward JSON schemas?

## Immediate Next Beads (Proposed)

1. Define Ward CLI schemas (`ward-review.json`, coverage, baseline) and version policy.
2. Implement minimal `ward review` command with deterministic skeleton and artifact emission.
3. Add botbox integration adapter in reviewer-loop that consumes Ward JSON only.
4. Create rule-pack manifest/signing/lockfile spec.
5. Build first replay suite and CI regression gate for Ward updates.
