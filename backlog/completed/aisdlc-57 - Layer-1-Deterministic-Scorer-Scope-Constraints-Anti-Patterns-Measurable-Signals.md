---
id: AISDLC-57
title: >-
  Layer 1: Deterministic Scorer (Scope, Constraints, Anti-Patterns, Measurable
  Signals)
status: Done
assignee: []
created_date: '2026-04-24 17:25'
updated_date: '2026-04-24 19:10'
labels:
  - sa-scoring
  - layer1
  - M5
milestone: m-1
dependencies:
  - AISDLC-55
  - AISDLC-56
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
New `orchestrator/src/sa-scoring/layer1-deterministic.ts` implementing §B.4 functions:

- `checkScopeGate(issueText, compiledScope)` — containsToken match; `hardGated=true` on core out-of-scope match, soft flag on evolving
- `detectConstraintViolations(issueText, compiledConstraints, depparseClient)` — calls Python sidecar per constraint pattern
- `detectAntiPatterns(issueText, compiledAntiPatterns)` — term matching across 4 scopes (product, design-principle, voice, visual)
- `checkMeasurableSignals(stateStoreMetrics, compiledSignals)` — threshold checks against Learn phase data

Produces `DeterministicScoringResult`:
- `scopeGate: ScopeGateResult`
- `constraintViolations: ConstraintViolationResult`
- `antiPatternHits: AntiPatternResult`
- `designAntiPatternHits: AntiPatternResult` (scope: design-principle | visual | voice)
- `measurableSignalChecks: MeasurableSignalResult`
- `hardGated: boolean` (true if core scope gate failed)
- `coreViolationCount: number`
- `evolvingViolationCount: number`
- `preVerifiedSummary: string` — formatted for Layer 3 injection per §B.6.1 template
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Core out-of-scope synonym match → hardGated=true, SA-1=0.0 downstream
- [x] #2 Evolving out-of-scope match → hardGated=false + scopeWarning
- [x] #3 Dep-parse-detected requirement violation on core constraint increments coreViolationCount
- [x] #4 preVerifiedSummary template matches §B.6.1 example format exactly (snapshot test)
- [x] #5 Unit tests using in-memory depparse stub
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Layer 1 deterministic SA scorer landed. Runs scope gate, constraint violations (via depparse), anti-pattern matching, and measurable-signal checks against a compiled DID, producing `DeterministicScoringResult` with hardGated flag, core/evolving violation counts, and a preVerifiedSummary for Layer 3 prompt injection.

## Changes
- `orchestrator/src/sa-scoring/layer1-deterministic.ts` (new): four pure detectors (`checkScopeGate`, `detectConstraintViolations`, `detectAntiPatterns`, `checkMeasurableSignals`), integration entrypoint `runLayer1(input)`, and `renderPreVerifiedSummary` template. Exported types: `ScopeGateResult`, `ScopeGateMatch`, `ConstraintViolation`, `ConstraintViolationResult`, `AntiPatternHit`, `AntiPatternResult`, `MeasurableSignalCheck`, `MeasurableSignalResult`, `DeterministicScoringResult`, `Layer1Input`.
- `orchestrator/src/sa-scoring/layer1-deterministic.test.ts` (new): 21 tests — scope gate core hard-gate + evolving warning (AC #1, #2), whole-word matching no partial hits, constraint violations via depparse (AC #3), depparse fail-soft on model-unavailable, bad-request propagation, must-require positive constraints not checked, anti-pattern dispatch across product/principle/voice/visual scopes, measurable signal pass/fail/missing + coreFailureCount, end-to-end runLayer1 hardGated aggregation, preVerifiedSummary template structure + empty-section placeholders + depparse-skipped note (AC #4), fake-depparse-only test suite (AC #5).

## Design decisions
- **Whole-word matching via regex with non-alphanumeric bounds**: `SAML` in "SAMLFederation" must NOT match (prevents `prefixSAMLsuffix` false positives), but `SAML` in "add SAML support" must match. Implemented with `(^|[^a-z0-9])term($|[^a-z0-9])` regex after escape.
- **Depparse fail-soft**: `DepparseError.kind` of `model-unavailable`, `network`, or `timeout` → `depparseSkipped=true` with zero violations. `bad-request` propagates (indicates caller bug). This keeps admission working when the Python sidecar is down; Layer 1 becomes a scope-gate-only check in that mode.
- **Only `must-not-require` / `must-not-include` constraints run through depparse**: positive constraints (`must-require` / `must-include`) are enforced via measurable signals (presence checks), not violation detection. Running depparse on them would flag legitimate uses as "violations" of their own constraint.
- **Scope gate walks labels + synonyms together** and stops at first match per entry — avoids double-counting the same label via multiple synonyms.
- **Core violations aggregate from 4 sources** (scope, constraints, anti-patterns, signals): every path increments `coreViolationCount` when the triggering element has `identityClass: 'core'`. Downstream composite (AISDLC-60) uses this count as a conflict penalty input.
- **`preVerifiedSummary` rendering is pure and deterministic** — snapshot-testable. Structure: top-level summary line, then four `###` sections in fixed order (scope → constraints → anti-patterns → signals). Empty sections emit "None detected" placeholders rather than being omitted, which makes the template LLM-prompt-stable.
- **Observed metrics injected as plain `Record<string, number>`** rather than querying state inside Layer 1: keeps the scorer testable without a database, and lets callers pre-compute or mock metric values for deterministic runs.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/sa-scoring/layer1-deterministic.test.ts` — 21/21 pass
- `pnpm vitest run` (full orchestrator) — 2087/2087 pass (+21)
- `pnpm lint` — clean

## Follow-up
AISDLC-58 (Layer 2 BM25) computes `domainRelevance` (SA-1 text vs. mission corpus) and `principleCoverage` (SA-2 text vs. per-principle corpus). AISDLC-60 combines Layer 1/2/3 with phase weights and the `w_structural ≥ 0.20` floor.
<!-- SECTION:FINAL_SUMMARY:END -->
