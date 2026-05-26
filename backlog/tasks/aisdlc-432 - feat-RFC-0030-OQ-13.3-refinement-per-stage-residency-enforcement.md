---
id: AISDLC-432
title: 'feat: RFC-0030 OQ-13.3 re-walkthrough refinement — per-stage residency enforcement points + multi-posture composition'
status: To Do
assignee: []
created_date: '2026-05-26'
labels:
  - rfc-0030
  - signal-ingestion
  - re-walkthrough-refinement
  - compliance
dependencies: []
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Re-walkthrough refinement (2026-05-26) for RFC-0030 OQ-13.3 (data residency). Lands on top of shipped Phase 1, 3, 6 substrate.

## Scope (RFC-0030 §13.3 v0.3 refinements)

Keep RFC-0022 as the regime-declaration source (architecturally correct). Add per-stage enforcement spec:

### Enforcement points

- **At `fetchSignals()`** (each adapter): tag each fetched signal with `residencyRegion` (derived from upstream metadata — Zendesk org region, Salesforce sandbox region, Slack workspace region). Check tag against declared posture's `allowedRegions` from RFC-0022's `derivedGates`. Out-of-policy signal → `Decision: signal-residency-violation` → refuse signal + emit `compliance.yaml regimeOverrides` clarification task.
- **At clustering**: residency-tagged signals MUST NOT co-mingle across forbidden region boundaries (e.g., GDPR-strict adopter: EU customer signals never cluster with US customer signals). Clustering pass partitions signal-set by `residencyRegion` before similarity computation when residency segregation is required.
- **At storage**: signal records persist with `residencyRegion` field. Cross-region read requires elevated audit log entry.
- **At unified-cost-report** (composes with RFC-0019 OQ-7): cost attribution rows tagged with `residencyRegion`; reports broken out by region by default.

### Multi-posture forward-compat

When RFC-0022 OQ-7 ships multi-posture (adopter declares both HIPAA AND GDPR), signal-pipeline takes **UNION** of regime constraints — strictest applies (e.g., HIPAA + GDPR adopter: BAA-only routing + EU-residency-only + right-to-erasure all enforced).

### Operator runbook + audit export

- Runbook section "Residency enforcement points in signal-pipeline"
- Audit export includes per-stage residency-check log: who fetched what from where, what region tag was assigned, what cluster boundary was respected
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `residencyRegion` tag derived per signal at `fetchSignals()`; persisted on storage records
- [ ] #2 RFC-0022 `derivedGates` `allowedRegions` consulted on tag check; out-of-policy → `Decision: signal-residency-violation`
- [ ] #3 Clustering pass partitions by `residencyRegion` when regime requires segregation; cross-region merge blocked
- [ ] #4 Storage records persist `residencyRegion`; cross-region read logs elevated audit entry
- [ ] #5 Unified cost report rows tagged with `residencyRegion`; report can break out by region
- [ ] #6 Multi-posture UNION composition implemented; when adopter declares both HIPAA + GDPR, strictest of each constraint applies
- [ ] #7 Operator runbook section published explaining per-stage enforcement + audit export format
- [ ] #8 Hermetic tests: signal-tag derivation, cross-region cluster prevention, audit-export contents, multi-posture composition
<!-- AC:END -->
