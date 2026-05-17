---
id: AISDLC-347
title: 'feat: RFC-0030 Phase 5 — D1 formula reformulation + RFC-0008 PPA integration'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0030
  - signal-ingestion
  - phase-5
  - ppa-integration
dependencies:
  - AISDLC-346
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0030 §10. Reformulates D1 to consume cluster-level demand from the signal-ingestion pipeline + integrates with RFC-0008 PPA Triad.

## Scope (RFC-0030 §10)

- D1 formula reformulation per §10: D1 now consumes cluster-level demand with explicit weight + filter components (instead of raw backlog items).
- **Non-replacement:** human-authored backlog items continue to feed D1 alongside signal-pipeline-generated demand. The pipeline adds a parallel input path; existing path preserved.
- RFC-0008 PPA Triad integration: signal-pipeline D1 inputs flow through Sα₁ + Eρ₅ admission composite per §12 DoR composition note.
- Backward compatibility: pipeline disabled (`enabled: false` default) → D1 reads from backlog items only (existing behavior). Enabled → reads from both sources with weight balancing per §10.4.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 D1 formula reformulated per §10: cluster-level demand with weight + filter components
- [ ] #2 Non-replacement: backlog-item-derived demand + signal-pipeline demand both feed D1
- [ ] #3 RFC-0008 PPA Triad integration: signal-pipeline D1 flows through Sα₁ + Eρ₅ admission composite
- [ ] #4 Backward compat: pipeline disabled → D1 reads from backlog items only (existing behavior)
- [ ] #5 Weight balancing per §10.4 when both inputs active
- [ ] #6 Integration test: full pipeline → cluster → D1 → admission scoring
<!-- AC:END -->
