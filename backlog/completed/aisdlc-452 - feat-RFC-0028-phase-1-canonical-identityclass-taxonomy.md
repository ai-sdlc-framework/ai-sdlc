---
id: AISDLC-452
title: 'feat: RFC-0028 Phase 1 — canonical `identityClass` taxonomy + harmonize with shipped `layer1-deterministic.ts`'
status: Done
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
blocked:
  reason: "RFC-0028 lifecycle 'Ready for Review' acknowledged — operator OQ walkthrough complete 2026-05-27 (v0.2 resolution); all 4 §7 OQs resolved with full rigor rubric. This task IS one of the 5 phase tasks (AISDLC-452..456) authored by the operator as the explicit execution path for the resolved RFC. Design sign-off (Morgan) is the remaining lifecycle gate and tracks orthogonally to phase-task dispatch."
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
- [x] #1 `orchestrator/src/substrate/identity-class.ts` ships with canonical taxonomy enumerated
- [x] #2 `spec/schemas/substrate-contract.v1.schema.json` declares field-level `identityClass` discriminant
- [x] #3 Shipped-code audit (`orchestrator/src/sa-scoring/layer1-deterministic.ts`) classifications cross-checked against canonical taxonomy
- [x] #4 Each discrepancy emits `Decision: identityclass-classification-disagreement` for operator routing
- [x] #5 Tightening-only enforcement at type system: boolean compliance locks typed as `true` literals when locked; numeric caps as bounded discriminated unions; categorical inheritance via template-literal types
- [x] #6 Novel fields default to `core` (with warning if `identityClass` omitted from contract authoring)
- [x] #7 Hermetic tests cover taxonomy enumeration, tightening-only enforcement, default-`core` behavior, audit discrepancy emission
<!-- AC:END -->

## Final Summary

### Summary
RFC-0028 Phase 1 ships the canonical `identityClass` taxonomy module + Substrate Contract schema. The taxonomy module (`orchestrator/src/substrate/identity-class.ts`) enumerates the `core`/`evolving` enum, lists the canonical bucket assignments from §7.1 v0.2 (compliance locks, regime declarations, director, complianceFloor on the core side; operational cadence, scoring tuning, similarity thresholds, quotas on the evolving side), provides a novel-field default helper (conservative `core`), and ships type-level tightening-only primitives (`LockedBoolean` = `true` literal, `BoundedNumericCap` discriminated union, `TightenedCategorical` template-literal helper). The substrate-contract JSON schema (`spec/schemas/substrate-contract.v1.schema.json`) declares the per-field `identityClass` discriminant with the same enum. The shipped-code audit against `layer1-deterministic.ts` surfaces one defensible cross-layer discrepancy — `did-compiler.ts ic()` defaults missing classifications to `'evolving'` whereas canonical RFC-0028 §7.1 says novel fields default to `'core'` — filed as DEC-0003 (open, source=subagent-escalation, scope=rfc:RFC-0028) for operator routing rather than inline-resolved.

### Changes
- `orchestrator/src/substrate/identity-class.ts` (new): canonical taxonomy enum, bucket assignments, novel-field default helper with optional warning hook, tightening-only type primitives + `assertTightenedCap` runtime check, `auditLayer1DeterministicClassifications()` discrepancy emitter, `IdentityClassError` error class
- `orchestrator/src/substrate/identity-class.test.ts` (new): 23 hermetic tests across 5 describe blocks covering taxonomy enumeration, novel-field default + warning-hook behavior, tightening-only enforcement at the type level (`@ts-expect-error` directives) + runtime (`assertTightenedCap`), and audit discrepancy shape contract
- `spec/schemas/substrate-contract.v1.schema.json` (new): minimum Substrate Contract surface for AC-2 — `SubstrateContractField` declares per-field `identityClass` with the canonical `core`/`evolving` enum, named-consumer rule, default-fallback rule, optional `complianceLockKind` for tightening-only typing
- `backlog/completed/aisdlc-452 - feat-RFC-0028-phase-1-canonical-identityclass-taxonomy.md` (moved from `backlog/tasks/`)
- `.ai-sdlc/_decisions/events.jsonl` (appended): DEC-0003 `identityclass-classification-disagreement` (3 options: align/exempt/revise)

### Design decisions
- **Single discrepancy filed rather than per-field**: the audit found one root-cause divergence (default fallback in `ic()` helper) rather than per-field misclassifications. Filing one DEC-0003 with three actionable routing options (align / exempt / revise canonical) is more useful to the operator than fanning out N decisions that all collapse to the same default-fallback choice.
- **`LockedBoolean = true` literal vs `Brand<boolean, 'Locked'>`**: chose the literal-`true` type because RFC-0028 §6 specifies "boolean compliance locks as `true` literals when locked" verbatim — branded types would have required a runtime constructor and obscured the structural contract.
- **`BoundedNumericCap` discriminated union + runtime assertion**: TypeScript's structural type system cannot enforce "child max ≤ parent max" purely at the type level (dependent types would be needed). The discriminated union forces authors to DECLARE tightening intent (`kind: 'tightened'` carries `previousMax`); `assertTightenedCap` catches loosening at module-load time. Documented this tradeoff in the module JSDoc.
- **Schema is minimum-surface**: AC-2 only mandates the field-level discriminant. Phases 2-5 (AISDLC-453..456) extend the schema with CI integrity assertions, structural drift detection, and operator runbooks. Schema is `additionalProperties: false` per repo convention so future additions land via explicit RFC.
- **Audit decision routed via cli-decisions add (not inline-resolved)**: Per AISDLC-298 / RFC-0035 escalation contract, this is a cross-layer architectural question — the DID-scoring domain may legitimately defend a different default than the substrate-contract domain. Operator decision required.

### Verification
- `pnpm --filter @ai-sdlc/orchestrator build` — clean (tsc passes)
- `pnpm --filter @ai-sdlc/orchestrator test` — 188 files, 4074 tests pass, 1 skipped (substrate module contributes 23 tests)
- `pnpm lint` — clean (eslint passes across workspace)
- `pnpm format:check` — clean (prettier)
- `node pipeline-cli/bin/cli-decisions.mjs add ...` — DEC-0003 emitted, decision-opened event landed in `.ai-sdlc/_decisions/events.jsonl`

### Follow-up
- AISDLC-453 (Phase 2): CI integrity gate — type-registry assertions + structural drift detection
- AISDLC-454 (Phase 3): drift composition wiring + cold-start handling + Decision routing
- AISDLC-455 (Phase 4): RFC-0009 cross-reference edits
- AISDLC-456 (Phase 5): operator runbook + glossary + conformance test suite
- DEC-0003 awaits operator routing — once resolved, either align `did-compiler.ts ic()` default to `core`, document the cross-layer exemption, or revise canonical taxonomy to per-domain defaults.
