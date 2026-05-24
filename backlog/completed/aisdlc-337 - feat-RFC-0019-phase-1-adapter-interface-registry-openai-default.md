---
id: AISDLC-337
title: 'feat: RFC-0019 Phase 1 — embedding adapter interface + registry + OpenAI default adapter + cost-tracker'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0019
  - embedding-substrate
  - phase-1
  - critical-path-rfc-0009
dependencies: []
references:
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0019 §11 Implementation Plan. Establishes the embedding-substrate interface + registry + default OpenAI adapter + cost-tracker integration. Foundation for all later phases AND for RFC-0009 Phase 4 Eτ rule #2 (embedding-distance drift detection).

## Scope (RFC-0019 §11 Phase 1)

- `orchestrator/src/embedding/types.ts` — `EmbeddingAdapter` interface per §5.
- `orchestrator/src/embedding/registry.ts` — registry + `getEmbeddingAdapter()` lookup (mirrors HarnessAdapter / DatabaseBranchAdapter pattern from RFC-0010 §13).
- `orchestrator/src/embedding/adapters/openai-text-embedding-3-small.ts` — default adapter (OpenAI text-embedding-3-small; 1536 dims).
- `orchestrator/src/embedding/errors.ts` — `UnknownEmbeddingProvider`, `EmbeddingProviderUnavailable`, etc.
- `spec/schemas/embedding-adapter.v1.schema.json` — JSON Schema for the adapter contract.
- **OQ-6 cost-tracker integration:** new `embeddingTokens` line item in cost-tracker; records per-call cost from the very first vector written. Composes with RFC-0004 `CostPolicy`.
- **OQ-6 RE-WALKTHROUGH:** `embed()` API accepts optional `consumerLabel?: string` parameter (default `'unspecified'`); cost-tracker records the dimension alongside `(provider, modelVersion, accountId)`. Enables per-consumer attribution from day-1 (e.g., `'rfc-0009-tessellation-drift'` vs `'rfc-0008-ppa-similarity'`). One-line API addition; retrofit cost later would be re-instrumenting every consumer call site.
- **OQ-7 SubscriptionLedger separation:** `embeddingTokens` does NOT consume subscription window quota for pay-per-token adapters.
- **OQ-7 RE-WALKTHROUGH:** Adapter capability matrix gains `billingModel: 'pay-per-token' | 'subscription-quota'` field. Today's adapter declares `'pay-per-token'` → `consumeSubscriptionQuota: false`. Forward-compat for future Anthropic embeddings (would declare `'subscription-quota'` → route through SubscriptionLedger via existing inputTokens/outputTokens mechanism). One-field addition to existing capability matrix.
- **OQ-5 placement:** framework code in `orchestrator/src/embedding/`; CLIs (`cli-embedding-bump`, `cli-embedding-gc`) in `pipeline-cli/bin/` (CLIs ship in Phases 2-3).
- **OQ-5 RE-WALKTHROUGH:** Explicit `spec/schemas/` placement for both `embedding-adapter.v1.schema.json` AND `vector-store-entry.v1.schema.json` (v0.2 was silent on this — drift-prone gap; closed by explicit placement matching every other substrate's schema convention).
- Unit tests: registry round-trip; adapter dimension validation; `isAvailable()` probe behavior; unknown-provider error path; `consumerLabel` propagates through to cost-tracker (re-walkthrough); `billingModel` field on adapter is correctly read by framework (re-walkthrough).

## Exit criteria

Unit tests pass; `getEmbeddingAdapter('openai-text-embedding-3-small')` returns a working adapter when `OPENAI_API_KEY` is set; pipeline-load fails with structured error when adapter is unknown; cost-tracker records `embeddingTokens` line item alongside every embedding call.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `EmbeddingAdapter` interface ships at `orchestrator/src/embedding/types.ts` per §5
- [x] #2 Registry + `getEmbeddingAdapter()` ships at `orchestrator/src/embedding/registry.ts`
- [x] #3 Default `openai-text-embedding-3-small` adapter ships + works when `OPENAI_API_KEY` set
- [x] #4 Error classes `UnknownEmbeddingProvider`, `EmbeddingProviderUnavailable` exported
- [x] #5 JSON Schemas at `spec/schemas/embedding-adapter.v1.schema.json` AND `spec/schemas/vector-store-entry.v1.schema.json` (re-walkthrough explicit placement)
- [x] #6 Cost-tracker integration: new `embeddingTokens` line item with `(provider, modelVersion, accountId, consumerLabel)` dimensions (re-walkthrough adds `consumerLabel`)
- [x] #7 `embed()` API accepts optional `consumerLabel?: string` parameter (default `'unspecified'`); propagates through to cost-tracker (re-walkthrough)
- [x] #8 Adapter capability matrix includes `billingModel: 'pay-per-token' | 'subscription-quota'` field; OpenAI default adapter declares `'pay-per-token'` (re-walkthrough)
- [x] #9 Embedding cost does NOT consume SubscriptionLedger window quota when adapter `billingModel = 'pay-per-token'` (OQ-7 + re-walkthrough)
- [x] #10 Unit tests: registry round-trip, dimension validation, isAvailable() probe, unknown-provider error, consumerLabel propagation, billingModel field read
<!-- AC:END -->
