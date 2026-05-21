---
id: AISDLC-338
title: 'feat: RFC-0019 Phase 2 — JSONL vector storage backend + `cli-embedding-gc`'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0019
  - embedding-substrate
  - phase-2
dependencies:
  - AISDLC-337
references:
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0019 §11. Pluggable storage substrate + JSONL default backend + mtime-based GC.

## Scope (RFC-0019 §11 Phase 2, OQ-1 resolution)

- `orchestrator/src/embedding/storage/types.ts` — `EmbeddingStorageBackend` interface.
- `orchestrator/src/embedding/storage/jsonl-backend.ts` — default JSONL backend (matches `_dor/`, `_deps/`, `_subscription-ledger/`, `_captures/`, `_decisions/` convention).
- `orchestrator/src/embedding/storage/index.ts` — backend factory keyed on `Pipeline.spec.embedding.storageBackend`.
- `pipeline-cli/bin/cli-embedding-gc.mjs` — mtime-based retention (default 90d; per-org override in `embedding-config.yaml`).
- Vectors written with `(embeddingProvider, embeddingModelVersion)` provenance per §2.3.
- **OQ-1 RE-WALKTHROUGH:** Scale-escalation heuristic codified in operator runbook (`docs/operations/embedding-providers.md#scale-escalation`): emit operator-visible signal (Decision or log) when count per `(provider, modelVersion)` exceeds 100K entries OR p95 read latency exceeds 250ms — recommends swap to sqlite or vector DB via `EmbeddingStorageBackend` interface. Makes the JSONL→indexed transition operator-visible and corpus-driven, not tribal knowledge. Heuristic thresholds configurable via `embedding-config.yaml: storage.scaleEscalationHeuristic`.
- Unit tests: write→read round-trip; concurrent-write atomicity; GC behavior; index rewrite atomicity; scale-escalation signal emission at threshold (re-walkthrough).

## Exit criteria

Can write 1K entries, read by textHash in <100ms median, GC removes >90d entries cleanly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `EmbeddingStorageBackend` interface ships
- [ ] #2 JSONL backend ships as default at `_embeddings/*.jsonl`
- [ ] #3 Backend factory keyed on `Pipeline.spec.embedding.storageBackend`
- [ ] #4 `cli-embedding-gc` ships with mtime-based retention; per-org `gcRetentionDays` override
- [ ] #5 Vectors carry `(embeddingProvider, embeddingModelVersion)` provenance per §2.3
- [ ] #6 Write 1K entries; read by textHash in <100ms median
- [ ] #7 Concurrent-write atomicity preserved
- [ ] #8 GC removes >90d entries; tests verify retention boundary
- [ ] #9 Scale-escalation heuristic emits operator-visible signal at >100K entries OR p95 read >250ms (re-walkthrough OQ-1)
- [ ] #10 Operator runbook `docs/operations/embedding-providers.md` includes `#scale-escalation` section explaining JSONL→sqlite swap criteria (re-walkthrough)
<!-- AC:END -->
