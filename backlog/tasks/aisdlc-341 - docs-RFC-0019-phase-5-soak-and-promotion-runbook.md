---
id: AISDLC-341
title: 'docs: RFC-0019 Phase 5 — soak + promotion runbook for `AI_SDLC_EMBEDDING_PROVIDER` default-on flip'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0019
  - embedding-substrate
  - phase-5
  - docs
dependencies:
  - AISDLC-340
references:
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
  - docs/operations/dor-promotion.md
  - docs/operations/orchestrator-promotion.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0019 §11. Corpus-driven soak + promotion runbook (matches RFC-0014 / RFC-0015 promotion convention). Hybrid promotion: operator dispatches default-on flip when corpus + spot-check evidence supports it.

## Scope (RFC-0019 §11 Phase 5)

- Run dogfood pipeline with embeddings enabled for at least one full corpus window.
- Verify: no operator-reported regressions; storage growth matches expectations; cost-tracker aligns with provider invoice.
- `docs/operations/embedding-substrate-promotion.md` runbook covering:
  - Corpus-window threshold (at least one downstream consumer shipped + one full corpus window without regressions).
  - Cost-alignment spot-check protocol (cost-tracker `embeddingTokens` total vs provider invoice for same period).
  - Rollback procedure (revert flag; data persists).
  - Post-flip monitoring (RFC-0025 framework-quality metrics).
- Cross-references RFC-0011 / RFC-0014 / RFC-0015 promotion runbooks.
- Operator dispatches `AI_SDLC_EMBEDDING_PROVIDER` default-on flip from the runbook.

## Exit criteria (per RFC-0014 model — corpus-driven, NOT calendar-driven)

- At least one downstream consumer shipped that depends on the framework (e.g., RFC-0009 Phase 4.2 Eτ rule #2 — AISDLC-317).
- One full corpus window with the framework enabled completes without operator-flagged regressions.
- Cost-tracker totals align with provider invoice within tolerance.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `docs/operations/embedding-substrate-promotion.md` runbook ships
- [ ] #2 Corpus-window threshold criteria documented
- [ ] #3 Cost-alignment spot-check protocol documented
- [ ] #4 Rollback procedure documented (flag-revert; data persists)
- [ ] #5 Post-flip monitoring via RFC-0025 framework-quality metrics
- [ ] #6 Cross-references RFC-0011 / RFC-0014 / RFC-0015 promotion runbooks
- [ ] #7 At least one downstream consumer shipped + corpus-window soak completed before promotion
<!-- AC:END -->
