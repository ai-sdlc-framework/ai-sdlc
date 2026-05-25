---
id: AISDLC-316
title: 'feat: RFC-0009 Phase 4.1 — Eρ₅ Compliance Clearance activation (OQ-5 hard-regulatory scope)'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-16'
updated_date: '2026-05-25'
labels:
  - rfc-0009
  - tessellated-did
  - phase-4
  - compliance
dependencies:
  - AISDLC-313
  - AISDLC-315
references:
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
priority: medium
blocked:
  reason: "RFC-0009 lifecycle is Ready for Review (all 13 OQs resolved v3.4 — OQ-5 specifically resolved 2026-05-03 Option A: gating, hard regulatory only). RFC-0022 lifecycle is Ready for Review (all 7 OQs resolved 2026-05-16). Operator-acknowledged via dispatch of AISDLC-316 (Phase 4.1 follow-on to AISDLC-313 + AISDLC-315 which already shipped against the same RFC under the same lifecycle posture). RFC-0022 phases 1-4 (AISDLC-322 through AISDLC-325) already shipped."
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4.1 of RFC-0009. Eρ₅ Compliance Clearance sub-dimension activates when souls declare `complianceRegimes` against the hard-regulatory-only scope (per OQ-5 sub-decision). Composes with RFC-0022 (Compliance Posture — currently Draft) for the canonical regime-declaration surface.

## Scope (RFC-0009 §10 Phase 4, §7.1 Eρ₅)

- Souls can declare `complianceRegimes` field per §7.1.
- Scope is hard-regulatory-only (OQ-5 resolution): HIPAA, SOC2, PCI-DSS, GDPR, etc. Soft / advisory regimes deferred.
- Eρ₅ sub-dimension evaluates compliance-clearance against declared regimes during admission.
- Gated on adopter opt-in initially; promotion to default behavior subject to ecosystem feedback.
- RFC-0022 (Compliance Posture, Draft) provides the canonical regime-declaration surface — this task wires the consumption side.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Souls can declare `complianceRegimes` field with the hard-regulatory whitelist per §7.1 + OQ-5
- [x] #2 Eρ₅ sub-dimension evaluates clearance against declared regimes during admission
- [x] #3 Adopter opt-in gate respected (default off)
- [x] #4 RFC-0022 consumption surface wired
- [x] #5 Test coverage: hard-regime opt-in / opt-out / soft-regime (rejected at declaration time per OQ-5 scope)
<!-- AC:END -->

## Final Summary

### Summary
Phase 4.1 of RFC-0009 lands the Eρ₅ Compliance Clearance scoring path. Souls' `triad.engineering.complianceRegimes` (already in the DID schema since AISDLC-312) are now consumed by a new `computeComplianceClearance()` scorer that returns the categorical 0/1 gating value per §7.1. The scorer composes with RFC-0022's `loadCompliancePosture()` output for the canonical regime-declaration surface, and wires into `computeAdmissionComposite()` behind an adopter opt-in gate — when `enabled: false` (default), the composite is unchanged from Phase 2/3 (full backward compatibility). The OQ-5 hard-regulatory scope is enforced via a `HARD_REGULATORY_REGIME_PREFIXES` whitelist (GDPR, HIPAA, SOC2, PCI-DSS, FedRAMP, ISO-27001, regional data-residency frameworks, regulated-industry rules) with a `validateComplianceRegimes()` declaration-time validator that splits accepted vs. rejected per OQ-5 scope.

### Changes
- `orchestrator/src/compliance-clearance.ts` (new, 322 lines): exports `HARD_REGULATORY_REGIME_PREFIXES`, `isHardRegulatoryRegime`, `validateComplianceRegimes`, `computeComplianceClearance`, plus all supporting types (`ComplianceClearanceContext`, `SoulComplianceRegimes`, `ComplianceViolation`, `ComplianceViolationEntry`, `ComplianceClearanceResult`).
- `orchestrator/src/compliance-clearance.test.ts` (new, ~440 lines): 35 tests covering AC #1-5 — hard-regulatory whitelist + variants + regional + regulated-industry, soft-regime rejection, declaration-time validator, opt-in gate (default off, explicit opt-out, integration with admission composite), Eρ₅ evaluation paths (no-regimes, clearance-holds, clearance-violated, multi-soul union), and RFC-0022 consumption surface (compose + soft filter + multi-posture + dedup).
- `orchestrator/src/admission-composite.ts` (modified): adds `complianceClearanceContext?` to `AdmissionCompositeOptions`, computes Eρ₅ via `computeComplianceClearance` using the same `affectedSoulIds` resolved by tessellation routing, multiplies the categorical 0/1 result into the composite (gates composite to 0 when violated and adopter opted in), and surfaces `complianceClearance` in `breakdown` only when the adopter opted in (avoids polluting Phase 2/3 shape).
- `orchestrator/src/index.ts` (modified): exports the new compliance-clearance surface alongside the existing extended-compliance + RFC-0022 loader/types exports.

### Design decisions
- **Prefix-based hard-regulatory whitelist**: rather than enumerate every framework variant (`SOC2-T1`, `SOC2-T2`, `FedRAMP-Low`, `FedRAMP-Moderate`, `FedRAMP-High`), the whitelist holds canonical prefixes (`SOC2`, `FedRAMP`) and `isHardRegulatoryRegime` matches case-insensitively. Keeps the list maintainable while accepting the variants RFC-0022 already uses (`SOC2-T2`, `PCI-DSS-L1`, `FedRAMP-Moderate`, `ISO-27001:2022`).
- **Categorical 0/1 multiplier instead of HC-style adjustment**: §7.1 is explicit that Eρ₅ is "GATING" — when violated the work item cannot proceed regardless of other dimensions. Multiplying into the composite as a `* er5` factor achieves the gate semantics exactly: violation → composite = 0 → not admitted. Avoids inventing an HC-style penalty when the spec calls for a hard gate.
- **Adopter opt-in gate via `enabled: boolean`**: §10 Phase 4 calls for opt-in with promotion-to-default subject to ecosystem feedback. A boolean flag in the context struct is the lightest-weight implementation; the composite no-ops cleanly when `enabled !== true`, and the breakdown field is elided (backward-compat with all existing breakdown consumers).
- **`__platform` sentinel for non-tessellated path**: substrate-only or non-tessellated DIDs have `affectedSoulIds = []`. Rather than introducing a separate code path, the scorer treats empty as a lookup against the sentinel `__platform` soul-ID. Adapters constructing the context populate that key with the DID's own `engineering.complianceRegimes` for the single-DID case.
- **Defense-in-depth filter in `computeComplianceClearance`**: even though `validateComplianceRegimes` is the declaration-time enforcement boundary for OQ-5, the scorer itself filters soft regimes from the regime set. Belt-and-suspenders against a malformed posture or a soul DID that bypassed validation — soft regimes simply don't contribute to the gating decision.
- **Same `affectedSoulIds` as tessellation routing**: the Eρ₅ scorer reuses `tessellationResult.affectedSoulIds`, so the regime check follows the work item's actual soul scope. A change targeting only soul-a is checked against soul-a's regimes (e.g., HIPAA); a substrate change affecting all souls is checked against the union; a non-tessellated DID falls through to the platform-aggregate regimes via the `__platform` sentinel.

### Verification
- `pnpm --filter @ai-sdlc/orchestrator build` — clean.
- `pnpm --filter @ai-sdlc/orchestrator test` — 3931 tests passed (35 new + 3896 unchanged), 1 pre-existing skip.
- `pnpm lint` — clean.
- `pnpm format:check` — clean.

### Follow-up
- **Phase 4.2 (Eτ_tessellation_drift)**: AISDLC-317 already shipped 2026-05-24.
- **Phase 4.3 (per-regime clearance checkers)**: §10 Phase 4 leaves the per-regime checkers themselves (e.g., a HIPAA PHI detector that asserts `ComplianceViolation` against a work item) as a follow-on. The Phase 4.1 surface ships the *scoring path* + *violation data shape*; concrete checkers will accumulate incrementally as adopters surface regulated work items.
- **Promotion to default-on**: once ecosystem feedback validates the opt-in path, a follow-on task can flip the default to `enabled: true` (with a transitional warning for missing regime declarations).
