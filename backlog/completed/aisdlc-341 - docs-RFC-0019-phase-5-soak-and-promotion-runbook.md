---
id: AISDLC-341
title: 'docs: RFC-0019 Phase 5 — soak + promotion runbook for `AI_SDLC_EMBEDDING_PROVIDER` default-on flip'
status: Done
assignee:
  - '@claude-opus-4-7'
created_date: '2026-05-16'
updated_date: '2026-05-27'
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
  - docs/operations/deps-composition-promotion.md
  - docs/operations/embedding-substrate-promotion.md
  - docs/operations/embedding-providers.md
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
- [x] #1 `docs/operations/embedding-substrate-promotion.md` runbook ships
- [x] #2 Corpus-window threshold criteria documented
- [x] #3 Cost-alignment spot-check protocol documented
- [x] #4 Rollback procedure documented (flag-revert; data persists)
- [x] #5 Post-flip monitoring via RFC-0025 framework-quality metrics
- [x] #6 Cross-references RFC-0011 / RFC-0014 / RFC-0015 promotion runbooks
- [ ] #7 At least one downstream consumer shipped + corpus-window soak completed before promotion
<!-- AC:END -->

## Implementation Notes

AC #1-#6 ship as docs in this PR. AC #7 is deferred to operator
dispatch — the runbook documents the gate; the gate's satisfaction
is an operational event that happens when AISDLC-317 (RFC-0009 Eτ
drift consumer) ships AND has accumulated at least one full corpus
window of usage without regression. The flag flip itself is a
separate operator-dispatched PR per the runbook's "The flag flip"
section, gated on AC #7's satisfaction.

## Final Summary

Phase 5 runbook for RFC-0019 ships at
`docs/operations/embedding-substrate-promotion.md`. Structure mirrors
the sibling `deps-composition-promotion.md` and `orchestrator-promotion.md`
runbooks: hybrid corpus / override path, single-line flag flip,
single-line revert rollback, data-persists-across-rollback contract.

Covers all six docs ACs: corpus-window threshold (consumer-shipped +
one full pipeline iteration + Decision Catalog clean), cost-alignment
spot-check protocol (cli-cost-report vs OpenAI invoice within ±10%),
rollback procedure, post-flip monitoring against six RFC-0025
framework-quality metrics, and cross-references to RFC-0011 /
RFC-0014 / RFC-0015 promotion runbooks.

AC #7 (consumer-shipped + soak-completed) deferred to operator
dispatch — the runbook documents the gate; the gate's satisfaction
happens when AISDLC-317 ships and accumulates real usage. The flag
flip itself is a separate operator-dispatched PR per the runbook.
