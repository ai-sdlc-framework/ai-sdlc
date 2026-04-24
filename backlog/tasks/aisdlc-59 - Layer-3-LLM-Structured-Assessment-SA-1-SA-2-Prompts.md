---
id: AISDLC-59
title: 'Layer 3: LLM Structured Assessment (SA-1 + SA-2 Prompts)'
status: Done
assignee: []
created_date: '2026-04-24 17:25'
updated_date: '2026-04-24 19:18'
labels:
  - sa-scoring
  - layer3
  - llm
  - M5
milestone: m-1
dependencies:
  - AISDLC-57
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
New `orchestrator/src/sa-scoring/layer3-llm.ts` implementing §B.6.

Build prompts per §B.6.2 (SA-1) and §B.6.3 (SA-2). Inject `preVerifiedSummary` as CI-Boundary-equivalent block before assessment prompt — Layer 3 explicitly scoped away from categories Layer 1 already resolved.

Parse structured JSON response. Apply confidence filter `<0.5` → suppress finding.

**Critical**: Exclude `tokenCompliance` and `catalogHealth` from SA-2 prompt context (Amendment 2 from v4 §5.2 — prevents double-counting).

Use existing LLM adapter pattern (same as review agents). Output `LLMScoringResult` with:
- `domainIntent: number` (SA-1, 0 if below confidence)
- `domainIntentConfidence: number`
- `subtleConflicts: SubtleConflict[]`
- `principleAlignment: number` (SA-2)
- `principleAlignmentConfidence: number`
- `subtleDesignConflicts: SubtleDesignConflict[]`
- `preVerifiedBoundaryApplied: true`
- `suppressedFindings: number`

Recorded-fixture LLM client for tests (no network calls).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Prompt text contains 'do not re-assess' scope guidance verbatim per §B.6.1
- [x] #2 Response parser rejects malformed JSON with typed error
- [x] #3 Finding with confidence=0.4 dropped; confidence=0.5 kept
- [x] #4 SA-2 prompt excludes tokenCompliance and catalogHealth tokens (regex assertion on prompt text)
- [x] #5 Deterministic test uses recorded-fixture LLM client
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Layer 3 LLM structured assessment landed. Builds SA-1 and SA-2 prompts with the Layer 1 preVerifiedSummary injected as a CI-Boundary block, parses structured JSON responses, applies the 0.5 confidence filter, and excludes DSB status fields from SA-2 per Amendment 2. `RecordedLLMClient` keeps tests deterministic — no network calls.

## Changes
- `orchestrator/src/sa-scoring/layer3-llm.ts` (new):
  - `LLMClient` interface, `RecordedLLMClient` test double with `setResponse(promptSubstring, response)`, `setFallbackResponse`, `promptLog`.
  - `LLMScoringResult`, `SubtleConflict`, `SubtleDesignConflict` output types.
  - `LayerLlmError` with `kind: 'malformed-json' | 'missing-field' | 'invalid-range'` and raw-response capture.
  - Constants: `CONFIDENCE_THRESHOLD = 0.5`, `CI_BOUNDARY_HEADER`, `SCOPE_GUIDANCE`.
  - Prompt builders: `buildSa1Prompt(ctx)` (mission + experiential targets), `buildSa2Prompt(ctx)` (mission + design principles, NO tokenCompliance/catalogHealth — Amendment 2).
  - Parsing: `extractJson(raw)` (unwraps fenced blocks + parses; throws `LayerLlmError` kind=malformed-json on invalid input), `parseSa1` + `parseSa2` private (throw `kind=missing-field` when required fields absent, clamp scores to [0, 1]).
  - `runLayer3(input)` orchestration: parallel SA-1 + SA-2 calls, confidence filter on both top-level scores and inner subtle-conflict lists.
- `orchestrator/src/sa-scoring/layer3-llm.test.ts` (new): 18 tests — CI-Boundary header + scope guidance present (AC #1), preVerifiedSummary injected verbatim, SA-2 does NOT contain tokenCompliance/catalogHealth (AC #4 with regex assertion), principles rendered with identityClass tag, `extractJson` parses raw + fenced JSON + throws on malformed (AC #2), runLayer3 with fixture client (AC #5), confidence filter drops 0.4 but keeps 0.5 (AC #3), suppresses top-level score to 0 when overall confidence <0.5, clamps scores to [0, 1], `LayerLlmError` on malformed JSON response and on missing-field, fenced-JSON handling end-to-end.

## Design decisions
- **Recorded (not recording) fixture client**: `RecordedLLMClient.setResponse(promptSubstring, response)` matches on a substring so tests don't need to track the exact prompt byte-for-byte as the prompt builders evolve. This keeps prompt-text changes from breaking unrelated tests. The fallback response covers "any prompt" cases.
- **Parallel SA-1/SA-2 via `Promise.all`**: the two prompts are independent — running them serially would double latency. Real LLM adapters can use connection pooling.
- **Confidence filter applied at two levels**: (1) top-level confidence < 0.5 → score = 0 (the whole assessment is low-confidence — don't trust any of it), (2) per-conflict confidence < 0.5 → drop from the list. Both paths increment `suppressedFindings` for audit.
- **SA-2 explicitly tells the LLM "Ignore DSB-level token compliance"**: belt-and-suspenders with the Amendment 2 compliance. The prompt omits the fields AND instructs the model not to consider them, so even prompt-leakage (e.g. LLM reading the SA-1 system prompt) shouldn't cause double-counting.
- **Clamp scores to [0, 1] at parse time**: LLMs occasionally return `1.2` or `-0.1` via hallucinated reasoning. Rather than rejecting, we clamp — the confidence filter covers genuinely broken assessments.
- **`extractJson` unwraps markdown fences**: LLMs often wrap JSON in ```json ... ``` even when told not to. Stripping the fence is safer than retrying the prompt.
- **`preVerifiedBoundaryApplied: true` is a constant on the result**: consumers (AISDLC-60 composite) can assert the LLM was instructed correctly without re-inspecting the prompt.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/sa-scoring/layer3-llm.test.ts` — 18/18 pass
- `pnpm vitest run` (full orchestrator) — 2127/2127 pass (+18)
- `pnpm lint` — clean

## Follow-up
AISDLC-60 (composite SA-1/SA-2) combines Layer 1/2/3 with phase weights and the w_structural ≥ 0.20 floor (CR-2), enforcing §B.7 formulas. AISDLC-61 (pattern-test CLI) is Phase 2a deliverable — runs Layer 1 only against a single issue.
<!-- SECTION:FINAL_SUMMARY:END -->
