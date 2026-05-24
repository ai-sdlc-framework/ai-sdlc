---
id: AISDLC-347
title: 'feat: RFC-0030 Phase 5 — D1 formula reformulation + RFC-0008 PPA integration'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-16'
completed_date: '2026-05-24'
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
blocked:
  reason: "RFC-0030 lifecycle is Ready for Review; all 5 §13 OQs explicitly resolved via operator walkthrough 2026-05-16 (see §13.1-13.5 Resolution markers); sibling phases AISDLC-344/345/346 shipped under the same override; RFC-0008 lifecycle is Implemented with all 7 OQs resolved (§B.12)."
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
- [x] #1 D1 formula reformulated per §10: cluster-level demand with weight + filter components
- [x] #2 Non-replacement: backlog-item-derived demand + signal-pipeline demand both feed D1
- [x] #3 RFC-0008 PPA Triad integration: signal-pipeline D1 flows through Sα₁ + Eρ₅ admission composite
- [x] #4 Backward compat: pipeline disabled → D1 reads from backlog items only (existing behavior)
- [x] #5 Weight balancing per §10.4 when both inputs active
- [x] #6 Integration test: full pipeline → cluster → D1 → admission scoring
<!-- AC:END -->

## Implementation Notes

- Phase 5 ships as a new `orchestrator/src/signal-ingestion/d1.ts` module exposing `computeClusterD1` + `aggregateD1FromClusters` (§10 formula + normalisation), `composeD1Inputs` (non-replacement blend; backward-compat fast path when `enabled: false`), and `enrichDemandSignalFromClusters` (overlays the composed score onto `PriorityInput.demandSignal`, which is the integration surface the existing RFC-0008 admission composite already reads).
- `d1Composition: { signalPipelineWeight, backlogItemWeight }` was added to `SignalIngestionConfig` with 50/50 defaults; weights are normalised inside `composeD1Inputs` so any positive pair is meaningful.
- §10.4 wasn't explicit in the RFC; implemented weight balancing as a config-driven linear blend with explicit `pipelineBypass` audit field on every composition.
- Cluster-to-item routing is left to a caller-supplied `ClusterMatcher` (v2 will wire to RFC-0024 capture matching).
- 26 unit tests in `d1.test.ts` + 2 end-to-end integration tests in `signal-ingestion.test.ts` (pipeline-enabled and pipeline-disabled backward-compat paths).
- Full workspace verify: build/test (3697 orchestrator tests pass)/lint/format clean.
