---
id: AISDLC-336
title: 'docs: RFC-0036 Phase 11 — adopter-authoring promotion runbook (hybrid promotion to default-on)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-11
  - docs
dependencies:
  - AISDLC-330
  - AISDLC-331
  - AISDLC-332
  - AISDLC-333
  - AISDLC-334
  - AISDLC-335
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - docs/operations/dor-promotion.md
  - docs/operations/orchestrator-promotion.md
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 11 of RFC-0036 §13. Hybrid promotion runbook to flip `AI_SDLC_ADOPTER_AUTHORING=experimental` flag to default-on. Operator dispatches the flip once corpus or spot-check evidence supports it.

## Scope

- `docs/operations/adopter-authoring-promotion.md` runbook.
- Covers: adopter-corpus accuracy threshold (≥N adopters using import-spec successfully); spot-check protocol; rollback procedure; monitoring after flip.
- Cross-references RFC-0011 + RFC-0014 + RFC-0015 promotion runbooks.
- Promotion ladder: `experimental` → shadow-mode → default-on documented.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `docs/operations/adopter-authoring-promotion.md` ships
- [ ] #2 Covers: adopter-corpus threshold, spot-check protocol, rollback, post-flip monitoring
- [ ] #3 Cross-references RFC-0011/0014/0015 promotion runbooks
- [ ] #4 Promotion ladder documented: experimental → shadow → default-on
- [ ] #5 Adopter-facing example walkthrough included
<!-- AC:END -->
