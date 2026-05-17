---
id: AISDLC-286
title: 'feat: RFC-0035 Phase 2 — Stage A deterministic scorer + dep-graph blast-radius'
status: In Progress
assignee: []
created_date: '2026-05-15'
labels:
  - rfc-0035
  - decision-catalog
  - phase-2
  - critical-path
dependencies:
  - AISDLC-285
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0035 Implementation Plan (§14). Stage A is the deterministic-first tier of the evaluation ladder. Integrates the RFC-0014 dependency graph for blast-radius computation. Depends on RFC-0014 Phase 1 (already Implemented).

## Scope

- Stage A deterministic scorer per §5
- Blast-radius computed from the existing RFC-0014 dependency graph (no graph-code duplication)
- Decisions with all-deterministic inputs route to Stage A only — no Stage B/C call
- Per-decision Stage A signal breakdown stored on the Decision record
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Stage A scorer ships per §5 deterministic ladder
- [ ] #2 Blast-radius computed from RFC-0014 dependency graph
- [ ] #3 Decisions with all-deterministic inputs route to Stage A only (no Stage B/C call)
- [ ] #4 Per-decision Stage A signal breakdown stored on Decision record
- [ ] #5 Composes cleanly with existing RFC-0014 substrate (no graph code duplication)
- [ ] #6 Stage A coverage metric exposed (target: ≥40% of decisions resolved by Stage A alone)
<!-- AC:END -->
