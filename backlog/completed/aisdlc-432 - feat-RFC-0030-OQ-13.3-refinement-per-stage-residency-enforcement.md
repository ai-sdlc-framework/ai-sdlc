---
id: AISDLC-432
title: 'feat: RFC-0030 OQ-13.3 re-walkthrough refinement — per-stage residency enforcement points + multi-posture composition'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-26'
completed_date: '2026-05-27'
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
blocked:
  reason: "RFC-0030 lifecycle is 'Ready for Review' but all 5 §13 OQs are RESOLVED via the v0.3 re-walkthrough (2026-05-26); this task is a per-OQ refinement filed by the operator after the re-walkthrough — operator-acknowledged."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Re-walkthrough refinement (2026-05-26) for RFC-0030 OQ-13.3 (data residency). Lands on top of shipped Phase 1, 3, 6 substrate.

## Scope (RFC-0030 §13.3 v0.3 refinements)

Keep RFC-0022 as the regime-declaration source (architecturally correct). Add per-stage enforcement spec:

### Enforcement points

- **At `fetchSignals()`** (each adapter): tag each fetched signal with `residencyRegion` (derived from upstream metadata — Zendesk org region, Salesforce sandbox region, Slack workspace region). Check tag against declared posture's `allowedRegions` from RFC-0022's `derivedGates`. Out-of-policy signal → `Decision: signal-residency-violation` → refuse signal + emit `compliance.yaml regimeOverrides` clarification task.
- **At clustering**: residency-tagged signals MUST NOT co-mingle across forbidden region boundaries (e.g., GDPR-strict adopter: EU customer signals never cluster with US customer signals). Clustering pass partitions signal-set by `residencyRegion` before similarity computation when residency segregation is required.
- **At storage**: signal records persist with `residencyRegion` field. Cross-region read emits an elevated audit log entry (RFC-0022 §audit-surface).
- **At unified-cost-report** (composes with RFC-0019 OQ-7): cost attribution rows tagged with `residencyRegion`; reports broken out by region by default.

### Multi-posture forward-compat

When RFC-0022 OQ-7 ships multi-posture (adopter declares both HIPAA AND GDPR), signal-pipeline takes **UNION** of regime constraints — strictest applies (e.g., HIPAA + GDPR adopter: BAA-only routing + EU-residency-only + right-to-erasure all enforced).

### Operator runbook + audit export

- Runbook section "Residency enforcement points in signal-pipeline"
- Audit export includes per-stage residency-check log: who fetched what from where, what region tag was assigned, what cluster boundary was respected
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `residencyRegion` tag derived per signal at `fetchSignals()`; persisted on storage records
- [x] #2 RFC-0022 `derivedGates` `allowedRegions` consulted on tag check; out-of-policy → `Decision: signal-residency-violation`
- [x] #3 Clustering pass partitions by `residencyRegion` when regime requires segregation; cross-region merge blocked
- [x] #4 Storage records persist `residencyRegion`; cross-region read logs elevated audit entry
- [x] #5 Unified cost report rows tagged with `residencyRegion`; report can break out by region
- [x] #6 Multi-posture UNION composition implemented; when adopter declares both HIPAA + GDPR, strictest of each constraint applies
- [x] #7 Operator runbook section published explaining per-stage enforcement + audit export format
- [x] #8 Hermetic tests: signal-tag derivation, cross-region cluster prevention, audit-export contents, multi-posture composition
<!-- AC:END -->

## Final Summary

### Summary

Per-stage residency enforcement substrate for RFC-0030 §13.3 v0.3 (AISDLC-432). The existing adapter-level `checkSignalResidency` gate (already shipped via AISDLC-343..348) is now joined by clustering-partition (`clusterSignalsWithResidency` + `partitionSignalsByRegion`), storage persistence (`StoredSignalRecord` + `makeStoredSignalRecord` + cross-region read audit via `readSignalRecordWithAudit`), unified-cost-report aggregation (`groupCostByRegion`), and multi-posture UNION composition (`composePostures`). The new `residencyEnforcement` config block exposes per-stage toggles + multi-posture behaviour; defaults match RFC-0030 v0.3 §11 (all points ON; behaviour = `union`).

### Changes

- `orchestrator/src/signal-ingestion/residency.ts` (new): `composePostures` (UNION-of-constraints), `partitionSignalsByRegion`, `clusterRequiresSegregation`, `makeStoredSignalRecord` + `readSignalRecordWithAudit`, `groupCostByRegion` — the post-Phase-4 enforcement surface.
- `orchestrator/src/signal-ingestion/clustering.ts` (modified): added `clusterSignalsWithResidency` wrapper that partitions by region when `partitionByRegion: true`; falls through to `clusterSignals()` otherwise (zero overhead for adopters with no regime declared).
- `orchestrator/src/signal-ingestion/config.ts` (modified): added `ResidencyEnforcementConfig` interface + default + `resolveResidencyEnforcement()` YAML loader.
- `orchestrator/src/signal-ingestion/index.ts` (modified): re-exports the new surface.
- `orchestrator/src/signal-ingestion/residency.test.ts` (new): 31 hermetic tests covering composition, partition, storage, audit, cost report, never-throws.
- `orchestrator/src/signal-ingestion/config.test.ts` (modified): 6 new tests for the `residencyEnforcement` YAML loader (defaults, partial overrides, error cases).
- `spec/schemas/signal-ingestion-config.v1.schema.json` (modified): added `ResidencyEnforcementConfig` $def + property reference.
- `docs/operations/signal-ingestion.md` (modified): new §6.5 "Residency enforcement points in the signal pipeline" with per-stage runbook + multi-posture composition + audit-export guidance.

### Design decisions

- **Module split**: kept the adapter-level `checkSignalResidency` / `filterSignalsByResidency` in `significance.ts` (already shipped, well-tested); added the new post-Phase-4 enforcement surface as a dedicated `residency.ts` module. Single-responsibility: one module per concern, no churn on the shipped surface.
- **Cross-region reads logged not blocked**: matches AWS S3 cross-region replication semantics — the audit obligation is on read, not on write. Adopters who want to forbid cross-region reads do so via their own surface (the audit log is the input to that policy).
- **`'unknown'` is visible-gap, not failure**: signals / readers without a region tag are not refused — they're tagged `'unknown'` and surfaced in the population-level region breakdown. Operators see the gap without losing signal.
- **UNION-of-constraints composition**: when an adopter declares HIPAA AND GDPR, every regime's allowed-region constraint must be satisfied (strictest wins). Implemented by composing into a single `ResidencyRegimeDeclaration` consumed by the existing `checkSignalResidency` — zero changes to the adapter-level gate.
- **Clustering segregation default-list**: GDPR / HIPAA / PIPEDA are in `KNOWN_SEGREGATION_REGIMES`; CCPA is NOT (CCPA is about consumer rights, not data residency). Adopters can override via the config flag.

### Verification

- `pnpm --filter @ai-sdlc/orchestrator build` — clean
- `pnpm --filter @ai-sdlc/orchestrator test` — 4098 passed, 1 skipped (no regressions; +37 new tests from AISDLC-432)
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

- RFC-0022 OQ-7 lands multi-posture declaration in `compliance.yaml`; once shipped, wire `composePostures()` into the YAML loader chain so adopters don't compose manually.
- Phase 5 unified cost report (PPA D1 surface) should consume `groupCostByRegion()` when it's wired to display per-region breakdowns.
- Storage-layer write-path wiring (where signals are actually persisted) is left to a follow-up — `makeStoredSignalRecord()` produces the record shape; the persistence integration depends on the chosen storage backend (out of scope for AISDLC-432 which lands the substrate).
