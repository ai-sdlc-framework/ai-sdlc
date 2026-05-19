---
id: AISDLC-314
title: 'feat: RFC-0009 Phase 2.2 — Per-soul DSB authoring + Cκ per-soul calibration aggregation'
status: In Progress
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0009
  - tessellated-did
  - phase-2
  - calibration
dependencies:
  - AISDLC-312
  - AISDLC-313
references:
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2.2 of RFC-0009. Per-soul Design System Binding (DSB) authoring + Cκ calibration aggregation per-soul, per-dimension.

## Scope (RFC-0009 §10 Phase 2)

- Per-soul DSB authoring: one DSB per Soul DID at `.ai-sdlc/souls/<slug>/design-system-binding.yaml`.
- DSB reader resolves per-soul DSB when admission routes through soul scope (composes with AISDLC-313).
- Cκ calibration aggregates per-soul, per-dimension (N souls × M dimensions cells).
- Existing single-DSB authoring (one platform-root DSB yaml under .ai-sdlc/) remains valid; new per-soul DSB extends rather than replaces.
- Per-soul DSB fields are additive over the platform-root DSB; resolution rules per §6.3.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `init` scaffolds `.ai-sdlc/souls/<slug>/design-system-binding.yaml` template per soul
- [ ] #2 DSB reader resolves per-soul DSB when admission routes through soul scope
- [ ] #3 Cκ aggregator produces N×M cells (souls × dimensions)
- [ ] #4 Per-soul DSB extends platform-root DSB additively per §6.3 resolution rules
- [ ] #5 Backwards-compat: single-DSB layout still works (legacy platforms)
- [ ] #6 Test coverage: single DSB / multi-soul DSB / DSB-resolution edge cases
<!-- AC:END -->
