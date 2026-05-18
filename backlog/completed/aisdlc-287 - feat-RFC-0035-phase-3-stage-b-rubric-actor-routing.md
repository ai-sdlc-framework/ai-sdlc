---
id: AISDLC-287
title: 'feat: RFC-0035 Phase 3 — Stage B rubric scorer + actor routing'
status: Done
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0035
  - decision-catalog
  - phase-3
  - critical-path
dependencies:
  - AISDLC-286
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0029-product-pillar-architectural-vision.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0035 Implementation Plan (§14). Stage B is the rubric-driven mid-tier (deterministic dimensions only — no LLM). Routes decisions to Engineering / Product / Operator pillars per the RFC-0029 actor model.

## Scope

- Rubric scorer per §6 deterministic dimensions
- Actor routing returns assigned actor + sub-actor list per §6
- Sub-decisions emitted for multi-actor decisions
- Composition with team-roles convention: dominique = Engineering + Operator, Alex = Product
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Rubric scorer evaluates Engineering + Product + Operator pillars per §6
- [ ] #2 Actor routing returns single primary actor + sub-actor list
- [ ] #3 Sub-decisions emitted for multi-actor decisions
- [ ] #4 Composition with team-roles convention works (never auto-fills all three)
- [ ] #5 No LLM calls in Stage B
- [ ] #6 Per-decision routing rationale stored on Decision record
<!-- AC:END -->
