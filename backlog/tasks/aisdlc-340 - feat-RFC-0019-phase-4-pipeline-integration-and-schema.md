---
id: AISDLC-340
title: 'feat: RFC-0019 Phase 4 — `Pipeline.spec.embedding` schema + first downstream consumer (RFC-0009 Eτ wiring) + operator runbook'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0019
  - embedding-substrate
  - phase-4
  - critical-path-rfc-0009
dependencies:
  - AISDLC-337
  - AISDLC-338
references:
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
  - spec/rfcs/RFC-0004-cost-governance-and-attribution.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0019 §11. Pipeline schema integration + spec-level wiring for RFC-0009 Phase 4 Eτ rule #2 + operator runbook.

## Scope (RFC-0019 §11 Phase 4)

- Schema amendment: add `Pipeline.spec.embedding` per §10.1 (provider + storageBackend + staleVectorPolicy + deprecation overrides).
- Pipeline-load wires `Pipeline.spec.embedding` → registry lookup → adapter instantiation → storage backend instantiation.
- **First downstream consumer spec-level wiring:** `Eτ_tessellation_drift` rule from RFC-0009 OQ-6 / RFC-0009 Phase 4.2 (AISDLC-317). Spec-level wiring lands here; runtime usage activates once RFC-0009 Phase 4.2 ships. Eτ consumer pins `staleVectorPolicy: 'fail-loud'` at API site (re-walkthrough OQ-2 — preserves historical-trajectory fidelity for drift signal).
- Cost-tracker integration per RFC-0004 — `embeddingTokens` line item flows into pipeline-level cost-budget.
- **OQ-6 RE-WALKTHROUGH per-consumer attribution:** cost-tracker records `consumerLabel` dimension alongside `(provider, modelVersion, accountId)`; pipeline-load wires `consumerLabel` propagation from `embed()` call sites through to cost-tracker.
- **OQ-7 RE-WALKTHROUGH unified-cost-report:** new cost-tracker view `cli-cost-report --unified` aggregates `inputTokens` + `outputTokens` + `embeddingTokens` + SubscriptionLedger window consumption (cost-converted) with explicit `costModel` label per row. Answers finance's monthly-spend query in one place. Documented in operator runbook.
- `.ai-sdlc/embedding-config.yaml` schema published; `ai-sdlc init` template ships with documented defaults.
- Operator runbook: `docs/operations/embedding-providers.md` covering: choosing an adapter, configuring stale-vector policy (incl. per-consumer override examples), monitoring deprecation lifecycle (milestone dedup), running `cli-embedding-bump`, GC strategy, scale-escalation heuristic (JSONL→sqlite swap criteria), unified cost report.

## Exit criteria

End-to-end pipeline run with `AI_SDLC_EMBEDDING_PROVIDER=on` writes vectors during a stage that calls `embed()`; cost-tracker records `embeddingTokens` line items; operator runbook published.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Schema amendment: `Pipeline.spec.embedding` per §10.1
- [ ] #2 Pipeline-load wires spec → registry lookup → adapter + storage instantiation
- [ ] #3 Spec-level wiring for `Eτ_tessellation_drift` rule; consumer pins `staleVectorPolicy: 'fail-loud'` (re-walkthrough OQ-2)
- [ ] #4 Cost-tracker integration: `embeddingTokens` line item with `consumerLabel` dimension propagated from embed() call sites (re-walkthrough OQ-6)
- [ ] #5 `cli-cost-report --unified` ships aggregating embeddingTokens + chat tokens + SubscriptionLedger with `costModel` labels (re-walkthrough OQ-7)
- [ ] #6 `.ai-sdlc/embedding-config.yaml` schema published; `ai-sdlc init` template ships with re-walkthrough fields (scaleEscalationHeuristic, perConsumerOverridesAllowed, crossProviderPolicy split, catalogDedup milestones, unifiedCostReport, adapterBillingModelRespected)
- [ ] #7 Operator runbook `docs/operations/embedding-providers.md` published with sections: choosing an adapter, stale-vector policy (incl. per-consumer override examples), deprecation lifecycle (milestone dedup), `cli-embedding-bump`, GC, scale-escalation heuristic, unified cost report (re-walkthrough)
- [ ] #8 End-to-end pipeline run with embedding enabled writes vectors + records cost with consumerLabel
<!-- AC:END -->
