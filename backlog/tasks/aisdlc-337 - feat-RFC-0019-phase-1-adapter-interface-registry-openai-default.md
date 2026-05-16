---
id: AISDLC-337
title: 'feat: RFC-0019 Phase 1 — embedding adapter interface + registry + OpenAI default adapter + cost-tracker'
status: To Do
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
- **OQ-7 SubscriptionLedger separation:** `embeddingTokens` does NOT consume subscription window quota (separate dollar-denominated cost).
- **OQ-5 placement:** framework code in `orchestrator/src/embedding/`; CLIs (`cli-embedding-bump`, `cli-embedding-gc`) in `pipeline-cli/bin/` (CLIs ship in Phases 2-3).
- Unit tests: registry round-trip; adapter dimension validation; `isAvailable()` probe behavior; unknown-provider error path.

## Exit criteria

Unit tests pass; `getEmbeddingAdapter('openai-text-embedding-3-small')` returns a working adapter when `OPENAI_API_KEY` is set; pipeline-load fails with structured error when adapter is unknown; cost-tracker records `embeddingTokens` line item alongside every embedding call.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `EmbeddingAdapter` interface ships at `orchestrator/src/embedding/types.ts` per §5
- [ ] #2 Registry + `getEmbeddingAdapter()` ships at `orchestrator/src/embedding/registry.ts`
- [ ] #3 Default `openai-text-embedding-3-small` adapter ships + works when `OPENAI_API_KEY` set
- [ ] #4 Error classes `UnknownEmbeddingProvider`, `EmbeddingProviderUnavailable` exported
- [ ] #5 JSON Schema at `spec/schemas/embedding-adapter.v1.schema.json`
- [ ] #6 Cost-tracker integration: new `embeddingTokens` line item; records cost per call
- [ ] #7 Embedding cost does NOT consume SubscriptionLedger window quota (OQ-7)
- [ ] #8 Unit tests: registry round-trip, dimension validation, isAvailable() probe, unknown-provider error
<!-- AC:END -->
