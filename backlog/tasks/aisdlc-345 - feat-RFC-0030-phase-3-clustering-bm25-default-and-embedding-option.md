---
id: AISDLC-345
title: 'feat: RFC-0030 Phase 3 — clustering (BM25 default + embedding via RFC-0019)'
status: To Do
assignee: []
created_date: '2026-05-16'
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
- [ ] #1 BM25 clustering ships as default
- [ ] #2 Embedding clustering ships when RFC-0019 adapter configured + `clustering.algorithm: embedding`
- [ ] #3 `similarityThreshold` per-org configurable (default 0.6)
- [ ] #4 Cluster output: deterministic IDs + member signals + aggregated tier/ICP/recency
- [ ] #5 Composition with RFC-0019: embedding clustering reads from configured embedding provider
- [ ] #6 BM25 path requires zero embedding infrastructure (graceful degradation)
<!-- AC:END -->
