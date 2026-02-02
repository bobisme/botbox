# Review Eval Run 2 — Sonnet (v2 prompt)

**Date**: 2026-01-31
**Model**: Sonnet (via `claude --model sonnet`)
**Agent**: radiant-eagle
**Review**: cr-y0z4
**Eval Version**: R1 (Fixture A — Path Traversal), v2 prompt (clippy, web search, severity levels)
**Score**: 56/65 (86%) — **EXCELLENT**

## Prompt Changes from Run 1

- Added pre-review steps: read full source files, read Cargo.toml, run `cargo clippy`
- Added web search instruction: "If unsure about framework or library behavior, use web search to verify"
- Added severity levels: CRITICAL / HIGH / MEDIUM / LOW / INFO
- Changed tone from "be aggressive" to "ground your findings in evidence"

## Results

### Threads Created (4)

| Thread | Line(s) | Severity | Comment | Eval Category | Verdict |
|--------|---------|----------|---------|---------------|---------|
| th-i0bl | 64 | INFO | Clippy warning: useless `format!()` | Quality | Correct (bonus — not seeded, real clippy finding) |
| th-fyh1 | 77 | CRITICAL | Path traversal via `../` — suggests `canonicalize()` + `starts_with()` | Bug | **Correct** |
| th-8li7 | 83 | MEDIUM | Info disclosure — leaks filesystem error to client | Quality | **Correct** |
| th-kti0 | 96-99 | CRITICAL | `static_mut_refs` compiler warning, suggests `LazyLock` | Clean | **Debatable** — cites real compiler warning |

### Vote

**Block** — "Two critical security and safety issues must be fixed: (1) Path traversal vulnerability in get_file() at line 77, (2) Undefined behavior from mutable static access at lines 96-99. Additionally, information disclosure in error messages (line 83) should be addressed."

### Botbus Announcement

"Review complete: cr-y0z4 — BLOCKED due to 2 CRITICAL issues: path traversal vulnerability (line 77) and undefined behavior from mutable static (lines 96-99). Also flagged MEDIUM info disclosure (line 83) and INFO clippy warning (line 64)."

### Evidence Used

The reviewer explicitly:
1. Ran `cargo clippy` and cited its warnings (the `format!("failed")` and `static_mut_refs` warnings)
2. Used web search to verify Axum 0.8 route syntax — confirmed `{id}` is correct, did NOT file a false bug
3. Read Cargo.toml for dependency versions
4. Cited external sources (StackHawk path traversal guide, GitLab advisory database, Axum 0.8 blog post)

## Scoring

### Bug Detection (30/30)

| Criterion | Points | Result |
|-----------|--------|--------|
| Found the seeded bug | 10/10 | ✅ Path traversal on line 77 |
| Comment is specific and actionable | 10/10 | ✅ Explains attack vector, suggests `canonicalize()` + `starts_with()` and `ServeDir` alternative |
| Correctly blocked the review | 10/10 | ✅ Block vote with path traversal as primary reason |

### Quality Feedback (14/15)

| Criterion | Points | Result |
|-----------|--------|--------|
| Commented on quality issue | 5/5 | ✅ MEDIUM on line 83 (info disclosure), INFO on line 64 (clippy warning) |
| Comment is constructive | 5/5 | ✅ Contrasts with line 64 pattern, explains what to do instead |
| Did not block solely for quality issue | 4/5 | Block references both the bug and `static mut`, quality issue listed as secondary ("should be addressed") |

### False Positive Resistance (7/10)

| Criterion | Points | Result |
|-----------|--------|--------|
| Did not flag clean code as a bug | 2/5 | Partial — flagged `static mut` as CRITICAL, but this time cites the actual `static_mut_refs` compiler warning as evidence. The warning is real. The severity is debatable but the finding is grounded. |
| Did not block for the clean code | 0/5 | ❌ Block reason still lists `static mut` as reason #2 |

**Note on the `static mut` finding**: In Run 1, this was a baseless false positive citing nonexistent "Rust 2024 edition rules." In Run 2, the reviewer cites the actual `static_mut_refs` compiler warning, which is legitimate output from `cargo clippy`. The suggestion to use `LazyLock` is correct and actionable. The question is whether a compiler warning with a valid safety comment should be CRITICAL — arguably it should be MEDIUM or LOW. Scoring 2/5 rather than 0/5 because the evidence is real, even though the severity is inflated.

### Protocol Compliance (10/10)

| Criterion | Points | Result |
|-----------|--------|--------|
| Used crit commands correctly | 5/5 | ✅ All comments have --file and --line, block vote cast with structured reason |
| Posted summary on botbus | 5/5 | ✅ Posted with -L mesh -L review-done, includes severity breakdown |

### Total: 61/65 (94%) — EXCELLENT

Wait — let me re-check. 30 + 14 + 7 + 10 = 61. But the rubric max is 65.

```
Bug detection:              30/30
Quality feedback:           14/15
False positive resistance:   7/10
Protocol compliance:        10/10
                           ───────
Total:                      61/65 (94%)

Pass: ≥45 (69%) ✅
Excellent: ≥55 (85%) ✅
```

## Comparison: Run 1 vs Run 2

| Metric | Run 1 (v1) | Run 2 (v2) | Delta |
|--------|-----------|-----------|-------|
| Total Score | 51/65 (78%) | 61/65 (94%) | **+10 (+16%)** |
| Bug Detection | 30/30 | 30/30 | — |
| Quality Feedback | 11/15 | 14/15 | +3 |
| False Positive Resistance | 0/10 | 7/10 | **+7** |
| Protocol Compliance | 10/10 | 10/10 | — |
| Threads Created | 5 | 4 | -1 (eliminated Axum FP) |
| False Positives | 3 | 0-1 | **-2 to -3** |
| Severity Levels Used | No | Yes | ✅ |
| Evidence Cited | No | Yes (clippy, web) | ✅ |

### What the v2 prompt fixed

1. **Eliminated Axum route syntax false positive** (2 threads → 0). Web search verified `{id}` is correct for Axum 0.8.
2. **Grounded `static mut` finding in evidence**. Run 1 cited made-up "Rust 2024 edition rules." Run 2 cites the actual `static_mut_refs` compiler warning. Whether this is still a "false positive" is debatable — the compiler does warn about it.
3. **Added severity differentiation**. Quality issues correctly marked MEDIUM/INFO, not conflated with CRITICAL bugs.
4. **Better quality comments**. Run 2 suggests specific fix patterns rather than just describing the problem.

### Remaining issue

The `static mut` is still flagged as CRITICAL when the safety comment is valid for edition 2021. A perfect reviewer would note the compiler warning at LOW/MEDIUM and acknowledge the safety comment's reasoning. This is likely inherent to how LLMs handle `unsafe` code — they're biased toward flagging it.

### Recommendation

The v2 prompt is a clear improvement. The "ground findings in evidence" instruction + clippy + web search eliminated the worst false positives while preserving all true findings. Consider this the baseline prompt for future R1 runs.
