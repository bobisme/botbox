# Proposal: Security Reviewer Excellence Program (Aegis)

**Status**: PROPOSAL
**Bead**: bd-u5ag
**Author**: bob
**Date**: 2026-02-20

## Summary

Build a data-driven security reviewer that combines structured vulnerability knowledge, deterministic checks, and expert LLM reasoning to produce high-signal, evidence-backed reviews across the full application security surface: memory safety (buffer overflows, unsafe FFI), web/API security, identity (OAuth2/OIDC/SAML), cryptography, cloud/IaC, and supply chain.

This proposal upgrades security review from a prompt-only checklist to a measurable security system with versioned policy packs, confidence scoring, benchmark evals, and continuous learning.

## Current Security Reviewer in Botbox (Brief Overview)

Today, security review is integrated into the normal botbox review lifecycle:

1. A worker requests review and mentions `@<project>-security` on botbus.
2. A mention hook spawns `botbox run reviewer-loop` for the security reviewer agent.
3. `reviewer-loop` discovers pending reviews via `maw ws list` + `maw exec <ws> -- crit inbox`.
4. The reviewer uses `src/templates/reviewer-security.md.jinja` guidance to inspect diffs/files and leave severity-tagged crit comments.
5. The reviewer votes LGTM/BLOCK in crit and posts a `review-done` message to the project channel.

This fits cleanly with botbox primitives (botbus orchestration, maw workspace isolation, crit review artifacts), but the intelligence is mostly prompt-driven and not yet data-driven.

## Problem Statement

Current prompt-only review is strong for obvious issues but weak in consistency and depth for complex security classes:

- Cross-file exploit chains are easy to miss without structured source/sink modeling.
- Domain-specific standards (OIDC, token validation, key rotation, mTLS) are not encoded as reusable policy.
- Findings are not scored by confidence/reachability in a fully consistent, repeatable way.
- We do not have benchmark-driven precision/recall tracking for security reviewer quality.
- Policy packs without schema-validated tests will drift and become noisy over time.
- We do not yet treat repository content as adversarial input to the reviewer.

## Goals

1. **Breadth**: Cover major vulnerability families from low-level memory corruption to identity and cloud misconfiguration.
2. **Depth**: Produce evidence-backed findings with exploitability rationale and concrete remediation.
3. **Consistency**: Use versioned policy/rule packs so behavior is stable and auditable.
4. **Measurability**: Track quality with replayable eval suites and explicit KPIs.
5. **Operational fit**: Preserve current botbox workflow and add capabilities incrementally.

## Non-Goals

- Replacing specialized SAST/DAST tools entirely.
- Blocking every review by default.
- Building a perfect whole-program static analyzer in v1.

## Design Principles

- **Evidence over intuition**: every finding must cite exact file/line path and dataflow rationale.
- **Deterministic first**: use rule-based detectors for high-confidence patterns, then LLM reasoning for synthesis.
- **Policy as data**: store security knowledge in versioned YAML/JSON packs.
- **Risk-aware voting**: tie BLOCK/LGTM decisions to severity + confidence + exploitability.
- **Continuously evaluated**: no policy change ships without benchmark impact data.
- **Treat repo content as adversarial**: code, docs, and comments may contain prompt injection attempts.
- **Data minimization**: provide only the minimum code slices needed to reason; redact secrets and PII before model calls.
- **Tool safety first**: run analyzers behind an allowlisted wrapper (no package-manager/build invocation, no auto-fetch/update, no user shell rc loading).

## Threat Model and Review Contract

### Assets to protect

- **Repository integrity**: avoid reviewer-induced regressions and unsafe fixes.
- **Secrets and credentials**: keys, tokens, internal endpoints, and sensitive data.
- **Execution environment**: maw workspace, analyzer runtime, and caches.
- **Review artifacts**: crit comments, Aegis artifacts, and telemetry.

### Adversaries and abuse cases

Assume PRs and repo content may be intentionally malicious:

- **Prompt injection** in code/docs/comments.
- **Tool-chain exploitation** via parser abuse, resource bombs, or malicious inputs.
- **Data poisoning** aimed at degrading reviewer behavior over time.
- **Covert exfiltration** through logs/comments/remediation output.

### Trust boundaries

- **Repo content is untrusted**.
- **Tool outputs are untrusted** until normalized into `EvidenceFacts`.
- **Network egress is restricted** by default (allowlist only when required).
- **External models are dependencies** and treated as sensitive boundaries.

### Review contract (hard invariants)

- Never execute repository code or model-suggested commands.
- Never echo secrets/PII in comments or persisted artifacts.
- Any blocking claim requires verifiable evidence (file/line and trace or deterministic proof).
- If coverage is incomplete on a high-risk surface, vote **NEEDS_HUMAN_REVIEW** (not LGTM).

## Aegis Safety Model (LLM + Tooling)

- **Untrusted inputs**: PR content, repository files, comments, generated artifacts.
- **Prompt injection defense**: ignore in-repo instructions; rely only on runtime policy + EvidenceFacts.
- **Secret/PII handling**: pre-scan and redact secrets in context and logs; never echo secrets in crit comments.
- **No implicit execution**: schema-validate model outputs; do not execute model-suggested commands.
- **Tool safety**: analyzers run through a sandboxed allowlisted wrapper with bounded resources.
- **Fail safely**: when parts of analysis fail, emit partial deterministic findings with an explicit `incomplete_analysis` flag (never silent LGTM).

Data governance:

- **Artifact retention**: short retention for raw slices/prompts, longer retention for redacted AegisIR metrics.
- **Access control**: restrict access to raw evidence and full artifacts, with audit trails.
- **Encryption**: encrypt artifacts at rest and redact in memory before persistence.
- **Model boundary policy**: support deterministic-only or self-hosted-model mode for regulated repos.

## Target Capability Matrix

Minimum domain coverage for v1-v2:

- Memory safety: C/C++ overflow patterns, unsafe Rust/FFI misuse, integer overflow, use-after-free indicators.
- AuthN/AuthZ: broken access control, IDOR, auth bypass, privilege escalation.
- OIDC/OAuth2/SAML: nonce/state validation, token audience/issuer checks, PKCE, key rollover/JWKS handling.
- Injection: SQL/NoSQL/command/template/deserialization injection.
- Web/API: SSRF, path traversal, XSS, CSRF, header/cookie/session issues.
- Crypto: insecure algorithms/modes, key management, cert validation gaps.
- Supply chain: dependency risk, malicious package indicators, lockfile drift, SBOM generation/diffing, vulnerability matching (OSV), and optional provenance/signature verification hooks.
- Cloud/IaC: public exposure, weak IAM, secrets in infra/config, network policy gaps.
- Runtime abuse: DoS/ReDoS, unbounded resource growth, queue poisoning patterns.

## Architecture

### 0) Execution Plane (Orchestration, Sandboxing, and Budgets)

Security review quality depends on deterministic and safe execution:

- **Deterministic orchestration**: stage-by-stage pipeline with explicit timeout/CPU/token budgets and retry policy.
- **Sandbox-by-default tool runner**: non-root execution, restricted filesystem/network, and resource limits.
- **Pinned toolchain**: analyzer and rule-pack versions recorded in `AegisIR.ReviewRun`.
- **Incremental caching**: key caches by `(repo, commit, file_hash, tool_version)`.
- **Failure semantics**: timeout/tool failure emits `incomplete_analysis` and degrades to **NEEDS_HUMAN_REVIEW** on high-risk surfaces.

### 1) Knowledge Plane (Policy Packs)

Add versioned policy data under a security knowledge directory, for example:

- `src/security/rules/*.yaml`
- `src/security/profiles/*.yaml`
- `src/security/mappings/*.yaml`
- `src/security/schemas/*.json` (rule + AegisIR schema validation)
- `src/security/rule-tests/**` (per-rule positive/negative fixtures)
- `aegis.yaml` (optional repo-local profile: exposure, criticality, allowed tools, model policy)

Policy packs are supply-chain inputs and must be reproducible:

- **Pack manifests + semver**: each pack defines version, compatibility, included rules, tool requirements.
- **Integrity verification**: signed packs; verification failures are fail-safe.
- **Pinned selection**: profile resolution writes `pack-lock.json` for replayable runs.
- **Repo overlays** (optional): allowed with explicit owner + security approver.

Each rule should include:

- `id`, `version`, `title`, `category`, `cwe`, `owasp`, `severity_default`
- `owner`, `tags`, `status` (`experimental` | `stable` | `deprecated`)
- `languages`, `frameworks`, `applies_if` (repo fingerprint conditions)
- `sources`, `sinks`, `sanitizers` (where relevant)
- `detectors` (regex/AST/heuristic hooks and/or tool-query hooks)
- `evidence_requirements`
- `confidence_model` (explicit calibration assumptions)
- `precision_target` / `recall_target` (optional)
- `remediation_patterns`
- `examples` (minimal positive/negative snippets)
- `tests` (fixture references; must pass in CI)
- `suppressions` model (reason + expiry + approver)
- `risk_vector_default` (attack-surface assumptions)
- `autofix_policy` (when fix-it patches are allowed)
- `references` (standards/RFC/CWE links)

Example shape:

```yaml
id: OIDC-001
version: 1
title: Missing issuer/audience verification on ID token
category: identity
cwe: [CWE-347]
owasp: [A07:2021]
severity_default: high
owner: security-identity
languages: [typescript, rust, go]
frameworks: [oidc, oauth2]
applies_if:
  any_dep_matches: ["openid", "oauth", "oidc"]
sources: [http_callback_query, auth_header]
sinks: [session_creation, role_grant]
evidence_requirements:
  must_show: ["token accepted", "no aud/iss check"]
confidence_model:
  high_if: ["token parse present", "claims used for authz", "aud/iss check absent"]
tests:
  positive_fixtures: ["fixtures/oidc/missing_aud_iss/*"]
  negative_fixtures: ["fixtures/oidc/valid_aud_iss/*"]
remediation_patterns:
  - "Validate iss, aud, exp, nonce, and signature against trusted JWKS"
references:
  - "OIDC Core 1.0 §3.1.3.7"
```

### 2) Analysis Plane (Hybrid Engine)

Reviewer runtime performs:

1. **Repo fingerprinting**: detect languages, frameworks, auth stack, cloud stack.
2. **Diff expansion + semantic ROI selection**: inspect changed files and a bounded region of influence around trust boundaries (auth middleware, serializers, gateways, policy code, IaC), prioritizing callers/callees and referenced controls over simple file proximity.
3. **Build an Evidence Graph (AegisGraph)**:
   - Incremental, language-pluggable graph over changed files + ROI:
     - syntax/symbols via Tree-sitter (or equivalent)
     - optional typed enrichment via compiler/LSP where available
     - calls and lightweight dataflow edges (best-effort with explicit unknowns)
     - web/API endpoints -> handlers -> authn/authz middleware
     - config/IaC resources -> IAM/network exposure edges
     - dependency changes -> package/SBOM nodes
   - Optional deep path for high-risk diffs: heavyweight analyzers within strict budget.
   - Cache by `(repo, commit, file_hash, tool_version)` to avoid re-parsing stable files.
4. **Deterministic signal collection (rule + tool plugins)**:
   - Run policy detectors (regex/AST/heuristic/lightweight taint) and sandboxed external analyzers.
   - Suggested v1 integrations: Semgrep, Gitleaks, OSV-Scanner, IaC analyzer, and SBOM tooling.
   - Normalize outputs into `EvidenceFacts` attached to AegisGraph nodes/edges.
5. **Reachability + exploit-chain reasoning**:
   - Query AegisGraph for source -> sink paths and privilege-boundary crossings.
   - Mark unknown edges explicitly instead of guessing.
6. **LLM synthesis + verification (two-pass)**:
   - **Pass A (synthesis)**: strict JSON output over minimal code slices + EvidenceFacts + policy references.
   - **Pass B (verification)**: deterministic checks confirm or refute each claim.
   - **Counterexample search**: for high-severity absence claims, actively search for the missing control.
   - Unverified claims are downgraded or marked `incomplete_analysis` (never block on unverified claims).

#### 2a) Canonical Intermediate Representation (AegisIR)

Define a stable internal schema for downstream processing:

- `AegisIR.ReviewRun`: repo/commit/diff metadata, timing, budgets, tool versions.
- `AegisIR.Finding`: stable finding id, rule id, severity, confidence, score breakdown.
- `AegisIR.Evidence`: code locations, traces/paths, normalized tool outputs.
- `AegisIR.Dedup`: fingerprints so reruns update existing findings instead of spamming duplicates.

### 3) Decision Plane (Risk Scoring)

Compute per-finding base score:

`risk = impact * exploitability * reachability * confidence`

Where:

- `impact`, `exploitability`, `reachability` are integers in `[1, 5]`
- `confidence` is a calibrated probability in `[0.0, 1.0]`
- risk range is `[0, 125]`

Then compute context-adjusted priority:

`context_multiplier = exposure_factor * asset_criticality_factor`
`risk_adjusted = risk * context_multiplier`

Where:

- `exposure_factor` in `[0.5, 2.0]` (internal-only to internet-facing/cross-tenant)
- `asset_criticality_factor` in `[0.5, 2.0]` (low-value internal service to critical auth/signing path)

Also compute a run-level assurance score:

`assurance = surface_coverage * tool_health * analysis_completeness`

Where each component is in `[0.0, 1.0]`.

Voting policy (default profile; overridable per repo):

- **BLOCK** if any finding is `severity in {critical, high}` and `confidence >= 0.8`
- **BLOCK** if any finding has `risk_adjusted >= 80` (including medium findings)
- **NEEDS_HUMAN_REVIEW** if `assurance < 0.7` on a high-risk surface (even with no findings)
- **NEEDS_HUMAN_REVIEW** if severity is high/critical but confidence is below block threshold
- **LGTM** only when no blocking findings remain and `assurance >= 0.7`

Each finding includes the breakdown:
`impact/exploitability/reachability/confidence -> risk -> risk_adjusted -> vote rationale`.

Each run includes:
`surface_coverage/tool_health/analysis_completeness -> assurance -> vote rationale`.

### 4) Explainability Plane (Structured Output)

For each finding, generate:

- short title + severity + confidence + stable finding id
- triage state: `new` | `existing` | `regressed` | `fixed` | `suppressed`
- exact evidence (file, line, code path)
- exploit scenario (realistic attacker path)
- remediation guidance (minimal safe patch strategy)
- optional verification test (unit/integration/security test idea)
- optional fix-it patch (small diff) when confidence is high and change risk is low

PR thread noise control:

- By default, post crit comments only for `new` and `regressed` findings.
- Summarize `existing` findings as carryover risk (or link baseline), not repeated line-by-line spam.

Post human-readable crit comments and persist:

- `aegis-review.json` (AegisIR; stable for analytics and replay)
- `aegis.sarif` (SARIF export for interoperability and multi-tool aggregation)
- `aegis-baseline.json` (accepted carryover findings/suppressions with expiry)
- `aegis-coverage.json` (coverage, tool health, and incomplete-analysis signals)

### 5) Learning Plane (Continuous Improvement)

- Benchmark corpora:
  - internal seeded vulnerabilities and known-safe controls
  - standardized suites (for example OWASP Benchmark and NIST SARD/Juliet)
- Ground-truth replay sets:
  - historical PR backtests with known outcomes
  - incident-linked commits and bug bounty/internal vulnerability reports
- Adversarial suites:
  - prompt-injection repositories
  - obfuscated/polyglot source-sink paths
  - parser stress/DoS cases
- Replay framework in evals to score precision/recall/F1, calibration, and time-to-review.
- False-positive triage queue with root-cause tags; promoted improvements update rule packs and tests.

## Integration with Botbox Runtime

No workflow disruption: keep the current trigger and transport flow.

- Trigger remains `@<project>-security` via botbus mention hook.
- Execution remains `botbox run reviewer-loop` in isolated maw workspaces.
- Review artifacts remain in crit threads and votes.
- Channel signaling remains `review-done` labels on bus.

Enhancement is additive: security reviewer-loop loads policy packs, runs analysis pipeline, then comments/votes through existing crit and bus commands.

## Governance and Ownership

If Aegis produces a BLOCK, ownership and exception path must be explicit:

- **Decision owner**: repository owner + designated security approver.
- **Override flow**: explicit override reason, expiry date, and audit trail in review artifacts.
- **SLA**: define response targets for high/critical findings and override requests.

## Implementation Plan

### Phase 0: Baseline, Reproducibility, and Safety Rails

1. Define metrics schema (precision, recall proxy, false-positive rate, review latency, tool failure rate).
2. Define and validate AegisIR schema; persist `aegis-review.json` per cycle.
3. Emit optional `aegis.sarif` for interoperability.
4. Emit `aegis-coverage.json` (surface coverage, tool health, completeness, incomplete-analysis flags).
5. Add telemetry summary to reviewer-loop journal (latency, token/cost budget, tool versions, pack versions).
6. Implement allowlisted sandbox tool wrapper (network-off by default, timeouts, resource limits).

### Phase 1: Policy Data Foundation

1. Create rule schema and validator.
2. Define pack manifest schema + signing verification + `pack-lock.json`.
3. Define `aegis.yaml` profile schema (exposure/criticality/tools/model policy).
4. Seed initial packs:
   - memory-safety core
   - web/api core
   - identity core (OAuth2/OIDC focus)
   - crypto core
   - supply-chain/cloud core
5. Add profile mapping (repo fingerprint + `aegis.yaml` -> active packs).
6. Add per-rule positive/negative test fixtures and CI enforcement.

### Phase 2: Deterministic Detectors

1. Implement detector runner for regex/heuristic checks + tool plugin harness normalized into EvidenceFacts/AegisIR.
2. Integrate pinned analyzers behind the sandbox wrapper.
3. Add framework-aware detectors (JWT misuse, unsafe deserialization, shell exec with tainted input).
4. Add deterministic supply-chain checks:
   - SBOM generation and diff on dependency changes
   - vulnerability matching (OSV)
   - optional signature/provenance verification hooks
5. Emit evidence packets with line-level references.

### Phase 3: Expert LLM Synthesis

1. Implement two-pass contract: strict JSON synthesis then deterministic verification.
2. Require evidence citations, exploitability, remediation, and verification ideas in output contract.
3. Add absence-claim counterexample search and confidence calibration heuristics.

### Phase 4: Scoring, Voting, and UX

1. Implement scoring + assurance gating using `aegis-coverage.json`.
2. Standardize crit comment template for readability.
3. Add "top risks" channel summary after review completion.
4. Add dedup semantics so reruns update/resolve prior findings.
5. Add baseline/noise control via `aegis-baseline.json`.
6. Add opt-in fix-it mode for high-confidence findings.

### Phase 5: Data-Driven Eval Program

1. Build benchmark suites:
   - seeded vulnerable repos + clean controls
   - standardized suites (OWASP Benchmark; NIST SARD/Juliet)
   - adversarial suites (prompt injection, obfuscation, parser stress)
2. Add historical PR backtests and incident-linked replay.
3. Run nightly replay and trend metrics (precision/recall/F1 + calibration + latency + tool failure).
4. Add regression gates for policy/rule/prompt/tool changes (no merge without eval delta review).

## Suggested Rule Pack Taxonomy

- `memory-corruption.yaml` (buffer overflow, bounds, unsafe pointer arithmetic)
- `unsafe-rust-ffi.yaml` (unsafe blocks, transmute, FFI boundary validation)
- `authn-authz.yaml` (access control, session semantics, RBAC checks)
- `oidc-oauth2.yaml` (state/nonce/aud/iss/exp/signature/JWKS)
- `injection.yaml` (SQL/OS/templating/deserialization)
- `transport-crypto.yaml` (TLS validation, crypto agility, key lifecycle)
- `supply-chain.yaml` (dependency trust, lock hygiene, install scripts)
- `sbom-vex.yaml` (SBOM generation/diff, vulnerability matching, and not-affected rationale)
- `provenance-signing.yaml` (optional signature/provenance verification hooks)
- `cloud-iac.yaml` (public exposure, IAM blast radius, secret leakage)

## Evaluation Strategy

Primary KPIs:

- Blocking-finding precision (target >= 0.80)
- True-positive recall on benchmark seeds (target >= 0.70 in v1, >= 0.85 in v2)
- False-positive rate for BLOCK votes (target <= 0.20)
- Mean review turnaround increase vs current baseline (target <= +25%)
- High-risk diff miss rate (auth/crypto/deserialization/ingress/IAM surfaces)

Secondary KPIs:

- Evidence completeness score
- Remediation usefulness score (human-rated)
- Domain coverage score (how many vulnerability families detected)
- Confidence calibration error (do confidence values match observed truth rates)
- Calibration quality (Brier score and expected calibration error)
- Tool failure rate and percent of runs marked `incomplete_analysis`
- Finding dedup rate (do reruns avoid duplicate noise)

## Risks and Mitigations

- **Rule bloat / maintenance burden**: use strict schema + ownership + linting for rule packs.
- **High false positives**: confidence thresholds + regression benchmarks before rollout.
- **Latency increase**: two-tier mode (fast scan by default, deep scan for risk labels), ROI bounding, and caching.
- **Prompt overfitting**: separate deterministic evidence generation from narrative generation.
- **Prompt injection / adversarial content**: treat repo content as untrusted, verify absence claims, never follow in-repo instructions.
- **Sensitive data exposure**: context minimization + secret redaction in prompts and artifacts.
- **Tool or LLM flakiness**: bounded retries, explicit partial-result artifacts, and no silent success.
- **Benchmark overfitting**: include backtests/adversarial suites alongside standard benchmark corpora.

## Rollout Strategy

1. Ship in shadow mode (advisory-only metrics, no vote change).
2. Enable blocking on high-confidence critical/high findings only.
3. Expand to medium severity once precision targets hold for N runs.

## Open Questions

1. Where should policy packs live long-term (`src/security/` vs templates copied to project)?
2. Should we support project-local override packs for domain-specific threat models?
3. Do we want separate reviewer roles (`security-app`, `security-cloud`, `security-identity`) for very high-risk repos?
4. What is the right default scan budget for large monorepos?
5. What are our SLOs (P95 latency, token/cost budget, max workspace CPU time)?
6. Which failures are fail-open vs fail-safe (require human review)?
7. Who owns BLOCK exception approvals and suppressions, and what is the SLA?
8. How are policy packs distributed/signed and how is key management handled?
9. Where does repo context live (`aegis.yaml` vs central policy), and who can change exposure/criticality?
10. What are default artifact retention windows and default external-LLM policy?
11. What is the analyzer allowlist and network-egress policy, and how is drift audited?
12. Do we require explicit baseline acceptance workflow for legacy findings?

## Immediate Next Beads (Proposed)

1. Define and implement security rule schema + validator.
2. Build initial YAML packs (web/api + OIDC + memory-safety + crypto).
3. Add reviewer-loop structured security artifact output.
4. Add benchmark harness for seeded vulnerabilities.
5. Integrate risk scoring into crit vote policy.
6. Add rule test harness with positive/negative fixtures and CI gates.
7. Add AegisIR + SARIF artifact generation and a dedup fingerprint strategy.
8. Add sandboxed allowlist tool wrapper and no-network default execution mode.
9. Add `aegis.yaml` profile schema + `pack-lock.json` resolution.
10. Add assurance gating from `aegis-coverage.json` before enabling blocking votes.

## External Standards and Baselines

- SARIF v2.1.0 for findings interchange.
- OWASP Benchmark and NIST SARD/Juliet for standardized eval corpora.
- CycloneDX/SPDX for SBOM interoperability.
- OSV for vulnerability matching on dependency changes.
- Sigstore/cosign patterns for signed policy-pack verification.
