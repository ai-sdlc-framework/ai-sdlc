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
- **First downstream consumer spec-level wiring:** `Eτ_tessellation_drift` rule from RFC-0009 OQ-6 / RFC-0009 Phase 4.2 (AISDLC-317). Spec-level wiring lands here; runtime usage activates once RFC-0009 Phase 4.2 ships.
- Cost-tracker integration per RFC-0004 — `embeddingTokens` line item flows into pipeline-level cost-budget.
- `.ai-sdlc/embedding-config.yaml` schema published; `ai-sdlc init` template ships with documented defaults.
- Operator runbook: `docs/operations/embedding-providers.md` covering: choosing an adapter, configuring stale-vector policy, monitoring deprecation lifecycle, running `cli-embedding-bump`, GC strategy.

## Exit criteria

End-to-end pipeline run with `AI_SDLC_EMBEDDING_PROVIDER=on` writes vectors during a stage that calls `embed()`; cost-tracker records `embeddingTokens` line items; operator runbook published.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Schema amendment: `Pipeline.spec.embedding` per §10.1
- [ ] #2 Pipeline-load wires spec → registry lookup → adapter + storage instantiation
- [ ] #3 Spec-level wiring for `Eτ_tessellation_drift` rule (composes with RFC-0009 Phase 4.2)
- [ ] #4 Cost-tracker integration: `embeddingTokens` line item flows to pipeline cost-budget
- [ ] #5 `.ai-sdlc/embedding-config.yaml` schema published; `ai-sdlc init` template ships
- [ ] #6 Operator runbook `docs/operations/embedding-providers.md` published
- [ ] #7 End-to-end pipeline run with embedding enabled writes vectors + records cost
<!-- AC:END -->
