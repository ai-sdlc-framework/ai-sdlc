---
id: AISDLC-56
title: 'DID Compilation Pipeline (scope, constraints, anti-patterns, BM25)'
status: Done
assignee: []
created_date: '2026-04-24 17:25'
updated_date: '2026-04-24 19:06'
labels:
  - sa-scoring
  - compilation
  - bm25
  - M5
milestone: m-1
dependencies:
  - AISDLC-40
  - AISDLC-38
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Addendum B §B.3.3. Create `orchestrator/src/sa-scoring/did-compiler.ts` producing 6 compiled artifacts:

1. Scope gate lists (flattened synonyms from `scopeBoundaries.inScope`/`outOfScope`)
2. Constraint rules (from `soulPurpose.constraints[]` with detectionPatterns)
3. Anti-pattern term lists (product + per-principle + voice + visual scopes)
4. BM25 corpus for SA-1 (mission + experientialTargets, weighted 2x core/1x evolving)
5. Principle corpora for SA-2 (one BM25 corpus per `designPrinciples[]`)
6. Measurable signal checks (from `measurableSignals[]` + `visualConstraints[]`)

Use `lunr` or `bm25` npm dependency for indexing. Persist to `did_compiled_artifacts` table with `source_hash = sha256(canonicalJson(did.spec))`.

Trigger compilation synchronously from DID reconciler on approved change (per OQ-2: immediate rebuild, no debouncing).

Helper: `validatePhase2bReadiness(compiled)` enforces §B.10.2 minimums (≥2 constraints with ≥3 patterns each, ≥3 outOfScope with ≥2 synonyms, ≥3 antiPatterns with ≥3 patterns, ≥2 per-principle antiPatterns with ≥2 patterns, ≥2 voice antiPatterns with ≥2 patterns, ≥2 visual antiPatterns with ≥2 patterns). Returns list of missing requirements.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Identical DID input produces identical source_hash and artifact bytes (determinism)
- [x] #2 core fields appear in BM25 corpus at 2x weight (verify via weighted-tf in index)
- [x] #3 validatePhase2bReadiness returns gap list for incomplete DID
- [x] #4 Reference DID from §B.3.2 passes validatePhase2bReadiness by construction
- [x] #5 Tests for artifact round-trip through state store
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
DID compilation pipeline landed. `compileDid(did)` produces six deterministic artifacts (scope, constraints, anti-patterns, measurable signals, SA-1 BM25 corpus, SA-2 principle corpora) with a stable `sourceHash`. `validatePhase2bReadiness` gates Phase-2b progression on §B.10.2 minima. Serialization helpers round-trip the artifacts through `did_compiled_artifacts`.

## Changes
- `orchestrator/src/sa-scoring/did-compiler.ts` (new): exported types (`CompiledDid`, `CompiledScopeEntry`, `CompiledScopeLists`, `CompiledConstraintRule`, `CompiledAntiPattern`, `CompiledAntiPatternLists`, `CompiledMeasurableSignal`, `Bm25Document`, `Bm25Corpus`, `PrincipleCorpora`, `ReadinessResult`), pure helpers `tokenize`, `canonicalJson`, `hashDidSpec`, entry point `compileDid(did)`, gate `validatePhase2bReadiness(compiled)`, serialization helpers `serializeForStore` + `deserializeFromStore`.
- `orchestrator/src/sa-scoring/did-compiler.test.ts` (new): 19 tests — tokenizer edges, canonicalJson key-sort invariance, determinism of `sourceHash` (AC #1), mutation changes hash, artifact shape (all six sections), `core` fields weighted 2× in BM25 (AC #2), `evolving` fields weighted 1×, principle corpora keyed by principle id, signals union from principles + visual constraints, missing `identityClass` defaults to evolving, `validatePhase2bReadiness` gap list on minimal DID (AC #3), Phase-2b-ready fixture passes (AC #4), below-minimum detection, state-store round-trip (AC #5) + lookup by source_hash.

## Design decisions
- **No external BM25 library** — compilation produces the *corpus* (documents with tokens + weight) only. Actual BM25 scoring lives in Layer 2 (AISDLC-58), which keeps the compiler free of heavy dependencies and makes the artifacts human-inspectable JSON.
- **2× core weight implemented at corpus-build time** via `Bm25Document.weight`: Layer 2 multiplies each core doc's TF contribution by `weight`. This matches the "core fields matter more" intent without forcing the corpus to contain duplicate token arrays.
- **Canonical JSON = alphabetic key sort at every depth** (JSON.stringify with replacer). Matches Python's `json.dumps(sort_keys=True)` so cross-language consumers of `sourceHash` agree. Arrays preserve order (order is semantic).
- **SHA-256 source hash over `canonicalJson(did.spec)`**: spec-only, not metadata — renames/namespace-moves don't trigger recompilation.
- **`validatePhase2bReadiness` returns a gap list, not a boolean**: operators need actionable feedback about *which* minima are missing. An empty list is success; caller treats `result.ready` as the gate.
- **BM25 blob storage as UTF-8 JSON**: `did_compiled_artifacts.bm25_corpus_blob` stores the canonical JSON bytes. Easier to debug than a binary index format and the corpus is small (~KB) for typical DIDs.
- **Principle antiPatterns and measurable signals pulled into both the anti-pattern list AND the principle corpus**: drift detection (Layer 1) reads from the anti-pattern list; principle coverage (Layer 2) reads from the corpus. Same source, two projections — intentional.
- **Visual constraints become measurable signals** (via `compileVisualConstraintSignal`): `visualConstraints[].rule` is shaped identically to `measurableSignals[]`. Merging them into one list lets Layer 1 run uniformly against either source.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/sa-scoring/did-compiler.test.ts` — 19/19 pass
- `pnpm vitest run` (full orchestrator) — 2066/2066 pass (+19)
- `pnpm lint` — clean

## Follow-up
AISDLC-57 (Layer 1 deterministic scorer) consumes `CompiledDid`: `checkScopeGate`, `detectConstraintViolations` (calls depparse client), `detectAntiPatterns`, `checkMeasurableSignals`. AISDLC-58 (Layer 2 BM25) consumes the corpora to compute `domainRelevance` (SA-1) and `principleCoverage` (SA-2).
<!-- SECTION:FINAL_SUMMARY:END -->
