---
id: AISDLC-338
title: 'feat: RFC-0019 Phase 2 — JSONL vector storage backend + `cli-embedding-gc`'
status: Done
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
blocked:
  reason: 'RFC-0019 lifecycle is Ready for Review with all 7 §15 OQs resolved per v0.3 operator re-walkthrough (2026-05-21); Phase 1 sibling AISDLC-337 already shipped under the same conditions. Implementation phases AISDLC-337..341 are explicitly authorised in RFC §11 Implementation Plan; final lifecycle promotion to Signed Off awaits Phase 5 soak completion.'
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
- [x] #1 `EmbeddingStorageBackend` interface ships
- [x] #2 JSONL backend ships as default at `_embeddings/*.jsonl`
- [x] #3 Backend factory keyed on `Pipeline.spec.embedding.storageBackend`
- [x] #4 `cli-embedding-gc` ships with mtime-based retention; per-org `gcRetentionDays` override
- [x] #5 Vectors carry `(embeddingProvider, embeddingModelVersion)` provenance per §2.3
- [x] #6 Write 1K entries; read by textHash in <100ms median
- [x] #7 Concurrent-write atomicity preserved
- [x] #8 GC removes >90d entries; tests verify retention boundary
- [x] #9 Scale-escalation heuristic emits operator-visible signal at >100K entries OR p95 read >250ms (re-walkthrough OQ-1)
- [x] #10 Operator runbook `docs/operations/embedding-providers.md` includes `#scale-escalation` section explaining JSONL→sqlite swap criteria (re-walkthrough)
<!-- AC:END -->

## Final Summary

### Summary

Shipped RFC-0019 Phase 2: the pluggable `EmbeddingStorageBackend` interface, the default JSONL backend with atomic write semantics and provenance preservation, a backend factory keyed on `Pipeline.spec.embedding.storageBackend`, the `cli-embedding-gc` CLI with mtime-based retention + per-org override + `stats` + dry-run + provider filter, and the operator runbook at `docs/operations/embedding-providers.md` codifying the OQ-1 re-walkthrough scale-escalation heuristic (>100K entries OR p95 read >250ms → swap to indexed backend).

### Changes

- `orchestrator/src/embedding/storage/types.ts` (new): `EmbeddingStorageBackend`, `VectorStoreEntry`, `VectorStoreFilter`.
- `orchestrator/src/embedding/storage/jsonl-backend.ts` (new): JSONL backend, scale-escalation thresholds, `ScaleEscalationSignal`, `hashText` helper, `gc()` + testable `gcWithCutoffDate()`.
- `orchestrator/src/embedding/storage/index.ts` (new): `createEmbeddingStorageBackend()` factory, public re-exports.
- `orchestrator/src/embedding/storage/jsonl-backend.test.ts` (new): 27 tests covering AC #1, #2, #5, #6 (1K-entry perf), #7 (concurrent writes), #8 (retention boundary), #9 (scale signals).
- `orchestrator/src/embedding/index.ts` (modified): re-export Phase 2 surface.
- `pipeline-cli/src/cli/embedding-gc.ts` (new): GC CLI router; exports `runGc()` + `collectStats()` for unit testing.
- `pipeline-cli/src/cli/embedding-gc.test.ts` (new): 9 tests covering AC #4 + #8 with real `runGc()` invocations (write→assert removal counts + on-disk rewrite verification).
- `pipeline-cli/bin/cli-embedding-gc.mjs` (new): bin shim.
- `pipeline-cli/package.json` (modified): wire `cli-embedding-gc` bin.
- `docs/operations/embedding-providers.md` (new): operator runbook — config overview, GC usage, stats, scale escalation section codifying the OQ-1 re-walkthrough thresholds + future JSONL→sqlite swap path.

### Design decisions

- **Backend factory is intentionally minimal** (a switch on `backendName`): no plugin auto-discovery, no DI container. Adopter backends register by editing the factory in their fork (consistent with `HarnessAdapter` and `DatabaseBranchAdapter` patterns per RFC-0019 OQ-5).
- **Sampled scale-escalation check on write** (`Math.random() > 0.01`) — `count()` is O(n) so checking every write would tank throughput; 1% sampling reaches 100K-crossing detection in expected O(100) writes after the threshold, well within operational sensitivity.
- **GC keeps malformed lines and entries without `writtenAt`** — don't silently drop data when the file is recoverable; surface as `(unknown)` in `stats` output instead.
- **CLI logic duplicated from backend** (rather than `pipeline-cli` importing `@ai-sdlc/orchestrator`) — pipeline-cli is orchestrator-free by design (per the explicit comment on `bin/cli-orchestrator.mjs`); reading + rewriting JSONL with a known layout is small enough to duplicate.
- **Pipe-buf-aware atomic write**: small entries (<4KB JSON line) use `appendFileSync` which is atomic at the OS level (`O_APPEND` for sub-PIPE_BUF writes); larger entries go through temp-then-rename. Tested under 50-way concurrent write (`Promise.all(50)`) with zero loss.

### Verification

- `pnpm --filter @ai-sdlc/orchestrator build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/orchestrator test` — 3605 passed | 1 skipped (170 files)
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 4602 passed | 1 skipped (242 files)
  - `src/embedding/storage/jsonl-backend.test.ts` — 27 passed (perf test: write 1K + sample 20 reads, median <100ms)
  - `src/cli/embedding-gc.test.ts` — 9 passed
- `pnpm lint` — clean
- `pnpm format:check` — clean
- End-to-end smoke test of `node pipeline-cli/bin/cli-embedding-gc.mjs {stats,run,run --dry-run}` against a fixture artifacts dir — all subcommands produce expected output.

### Follow-up

- Phase 3 (AISDLC-339) — migration tooling (`cli-embedding-bump`) consumes this interface for re-embed migrations.
- Phase 4 (AISDLC-340) — Pipeline config schema wires `spec.embedding.storageBackend` into the factory call site.
- sqlite backend (Phase 6+) plugs into the same `EmbeddingStorageBackend` interface; no consumer-code changes needed.
