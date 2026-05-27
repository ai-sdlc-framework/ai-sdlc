---
id: AISDLC-452
title: 'feat: RFC-0028 Phase 1 — canonical `identityClass` taxonomy + harmonize with shipped `layer1-deterministic.ts`'
status: To Do
assignee: []
created_date: '2026-05-27'
labels:
  - rfc-0028
  - substrate-enforcement
  - phase-1
  - identityclass
dependencies: []
references:
  - spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0028 §7.1 resolution. Defines the canonical taxonomy for per-field `identityClass: 'core' | 'evolving'` and harmonizes the Substrate Contract pattern with the already-shipped discriminant in `orchestrator/src/sa-scoring/layer1-deterministic.ts`.

## Scope (RFC-0028 §7.1 v0.2 resolution)

### Canonical taxonomy

Three buckets — ship in `orchestrator/src/substrate/identity-class.ts` (new module):

- **`core`** (cannot be loosened by child Soul DIDs; pivot rescoring fires on change):
  - Categorical compliance locks: `requiresTenantPhysicalIsolation`, `requiresVulnerableAudienceLockout`, and analogous categorical-gate fields
  - Compliance regime declarations: HIPAA / PCI-DSS / SOC2 / FedRAMP / GDPR posture
  - Director / orchestrator agent identifier (changing the director IS a Soul-level event)
  - `complianceFloor: inherit` lock (per RFC-0028 §6 tightening-only)
- **`evolving`** (free movement within tightening-only bounds; admission-queue rescoring only):
  - Operational cadence: `observerCooldownMs`, `cadenceMinIntervalDays`
  - Scoring tuning weights: bid diversity weight, recency half-life
  - Similarity thresholds: `clustering.similarityThreshold`
  - Quota quantities: `tenantQuotaShare`
- **Default `core` for novel fields** — promotion to `evolving` needs an RFC amendment with Design + Engineering sign-off (conservative default; burden-of-proof is "argue why operational").

### Harmonization with shipped code

`orchestrator/src/sa-scoring/layer1-deterministic.ts` already uses `identityClass: 'core' | 'evolving'` on multiple fields (verified via grep at walkthrough). This phase:

1. Audits every existing usage against the canonical taxonomy.
2. Documents any discrepancy as a `Decision: identityclass-classification-disagreement` for operator routing — the shipped code may have classifications that conflict with the canonical taxonomy.
3. Migrates aligned classifications inline; defers conflicting classifications via Decision until operator-resolved.

### Tightening-only enforcement at the type system

Per RFC-0028 §6, when a Substrate Contract field declares `identityClass: 'core'` AND a categorical compliance lock value, the type system enforces tightening-only inheritance — `boolean compliance locks typed as `true` literals when locked, numeric caps as bounded discriminated unions, categorical inheritance via TypeScript template-literal types`. Child Soul DIDs that attempt to loosen the value fail at compile time.

### Schema

`spec/schemas/substrate-contract.v1.schema.json` ships with the field-level `identityClass` discriminant declared and the canonical taxonomy enumerated.

### Hermetic tests

- Taxonomy enumeration matches RFC-0028 §7.1 resolution exactly
- Tightening-only enforcement: child Soul DID attempting to loosen a `core` lock fails type check
- Novel-field default behavior: omitting `identityClass` defaults to `core` with a warning
- Shipped-code audit produces a Decision per discrepancy
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `orchestrator/src/substrate/identity-class.ts` ships with canonical taxonomy enumerated
- [ ] #2 `spec/schemas/substrate-contract.v1.schema.json` declares field-level `identityClass` discriminant
- [ ] #3 Shipped-code audit (`orchestrator/src/sa-scoring/layer1-deterministic.ts`) classifications cross-checked against canonical taxonomy
- [ ] #4 Each discrepancy emits `Decision: identityclass-classification-disagreement` for operator routing
- [ ] #5 Tightening-only enforcement at type system: boolean compliance locks typed as `true` literals when locked; numeric caps as bounded discriminated unions; categorical inheritance via template-literal types
- [ ] #6 Novel fields default to `core` (with warning if `identityClass` omitted from contract authoring)
- [ ] #7 Hermetic tests cover taxonomy enumeration, tightening-only enforcement, default-`core` behavior, audit discrepancy emission
<!-- AC:END -->
