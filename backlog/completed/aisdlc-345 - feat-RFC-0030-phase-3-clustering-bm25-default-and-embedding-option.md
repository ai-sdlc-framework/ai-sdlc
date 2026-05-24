---
id: AISDLC-345
title: 'feat: RFC-0030 Phase 3 — clustering (BM25 default + embedding via RFC-0019)'
status: Done
assignee: []
created_date: '2026-05-16'
completed_date: '2026-05-24'
labels:
  - rfc-0030
  - signal-ingestion
  - phase-3
dependencies:
  - AISDLC-344
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
priority: high
blocked:
  reason: |
    RFC-0030 + RFC-0019 OQs all resolved (operator walkthrough 2026-05-16 / re-walkthrough 2026-05-21);
    both RFCs at lifecycle 'Ready for Review' pending operator promotion to 'Signed Off'.
    Predecessor tasks AISDLC-343 + AISDLC-344 (Phase 1 + Phase 2) landed under the same condition.
    Phase 3 is mechanical implementation against the resolved OQs — no new design decisions.
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0030 §7. Clusters signals into demand themes. BM25 default + optional embedding-based clustering when RFC-0019 adapter is configured.

## Scope (RFC-0030 §7)

- `orchestrator/src/signal-ingestion/clustering.ts` — clusters classified signals via configured algorithm.
- **BM25 default** (matches PPA v1.2 Sα₁ Layer 2 structural-scoring convention): deterministic, model-independent, interpretable.
- **Embedding option** (when RFC-0019 adapter configured): uses `embeddingProvider` from `.ai-sdlc/embedding-config.yaml` for semantic clustering. Per-org override via `clustering.algorithm: embedding`.
- `clustering.similarityThreshold` per-org configurable (default 0.6).
- Cluster output: deterministic IDs + member signals + aggregated tier/ICP/recency.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 BM25 clustering ships as default
- [x] #2 Embedding clustering ships when RFC-0019 adapter configured + `clustering.algorithm: embedding`
- [x] #3 `similarityThreshold` per-org configurable (default 0.6)
- [x] #4 Cluster output: deterministic IDs + member signals + aggregated tier/ICP/recency
- [x] #5 Composition with RFC-0019: embedding clustering reads from configured embedding provider
- [x] #6 BM25 path requires zero embedding infrastructure (graceful degradation)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
### Summary

Shipped `clusterSignals()` in `orchestrator/src/signal-ingestion/clustering.ts` — BM25 by default with optional embedding-based clustering via an injected RFC-0019 `EmbeddingAdapter`. Cluster IDs are deterministic SHA-256 derivations from the sorted member `sourceId` set; cluster output aggregates tier counts, ICP match rate, churn correlation, oldest/newest timestamp, and mean recency decay per §7. Graceful BM25 fallback when `algorithm: embedding` is configured but no adapter is wired (AC #6).

### Changes

- `orchestrator/src/signal-ingestion/clustering.ts` (new): main clusterer — `clusterSignals()`, `computeClusterId()`, `cosineSimilarity()`, BM25 + embedding similarity matrices, greedy single-linkage Union-Find clustering, deterministic output sort.
- `orchestrator/src/signal-ingestion/clustering-types.ts` (new): shared `ClusteredSignalInput` shape decoupled from the classifier's full output (avoids circular import).
- `orchestrator/src/signal-ingestion/clustering.test.ts` (new): 39 tests covering all 6 ACs + edge cases (empty input, singletons, empty payloads, length asymmetry, mock embedding adapter, fallback paths, cosine helper).
- `orchestrator/src/signal-ingestion/index.ts` (modified): re-exports the Phase 3 surface.

### Design decisions

- **Single-linkage Union-Find**: simplest correct connect-the-dots; O(N²); stable; no parameters to tune beyond threshold. Acceptable for the v1 ingestion window (10²–10³ signals per pipeline-load).
- **BM25 normalisation**: pairwise scores are normalised by the queried doc's self-score then averaged for symmetry. Keeps scores in [0, 1] and matches RFC-0030 §7's "similarity > 0.6" wording.
- **Graceful embedding fallback**: missing adapter OR unavailable adapter → log via `onFallback`, set `fallbackReason`, run BM25. Never silently swap semantics; the result envelope discloses which algorithm ran. Satisfies AC #6 head-on — the BM25 path requires zero embedding infrastructure.
- **Deterministic IDs**: SHA-256 of the sorted member sourceId set, space-delimited so `['a', 'bc']` !== `['ab', 'c']`. First 24 hex chars suffice for collision resistance within any realistic ingestion window and stay log-readable.
- **Output ordering**: clusters sorted by `clusterId` so identical inputs always produce identical output (auditable by construction).
- **Phase 4/5 deferral**: `saResonance` + `topSummary` left `undefined` per RFC-0030 §9 (Phase 4) and §7 LLM summary (post-MVP). `tier1SignalCount` + `tier2SignalCount` exposed for Phase 4's significance-threshold consumer.

### Verification

- `pnpm --filter @ai-sdlc/orchestrator build` — clean
- `pnpm --filter @ai-sdlc/orchestrator test` — 3617 tests passing, 1 skipped (39 new clustering tests)
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

Phase 4 (AISDLC-346): significance threshold + SA resonance filter + flooding detection — will consume `tier1SignalCount` / `tier2SignalCount` / `oldestSignalAt` from `DemandCluster` and populate `saResonance`.
<!-- SECTION:FINAL_SUMMARY:END -->
