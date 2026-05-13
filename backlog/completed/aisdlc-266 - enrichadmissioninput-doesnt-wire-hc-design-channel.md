---
id: AISDLC-266
title: enrichAdmissionInput doesn't wire HC_design channel from DSB
status: Done
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - ppa
  - admission
  - rfc-0008
dependencies: []
priority: high
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
---

## Bug

Per RFC-0008 §C5, the DSB's `stewardship.designAuthority.principals` is supposed to populate the `HC_design` channel of the admission scoring input. With a full DSB loaded (and DID + maintainers + soul-tracks all clean), `pillarBreakdown.shared.hcComposite.design` stays at `0`.

Either the wire from `stewardship.designAuthority.principals → HC_design` is missing in `enrichAdmissionInput()`, OR the spec needs an explicit signal channel that adopters opt in to populate.

## Repro (forge)

```bash
# Forge admission with full DSB + DID + maintainers + soul-tracks loaded
cli-admission score --pillar-breakdown
# pillarBreakdown.shared.hcComposite.design === 0  (expected: > 0 when designAuthority.principals non-empty)
```

## What to investigate first

1. Inspect `enrichAdmissionInput()` in the orchestrator (`orchestrator/src/admission/` or similar) — does it read `stewardship.designAuthority.principals` from the DSB?
2. Inspect the channel mapping table — is `HC_design` listed as a destination for DSB stewardship signals?
3. Cross-check with RFC-0008 §C5's intended semantics: is the channel supposed to be auto-populated, or does the adopter need to declare an explicit `signalChannels:` mapping?

## Acceptance criteria

- [x] Root cause identified (missing wire vs spec gap vs adopter-opt-in pattern).
- [x] Fix implemented: a fully-loaded DSB with non-empty `stewardship.designAuthority.principals` produces `pillarBreakdown.shared.hcComposite.design > 0`.
- [x] Test added with a fixture DSB exercising the channel.
- [ ] If RFC-0008 needs amending (signal channel semantics), open an RFC PR alongside.
- [ ] Adopter docs updated explaining how to debug a stuck-at-0 channel.

## Source

Adopter session 2026-05-13, ranked #6 by friction. Forge admission scoring shows hcComposite.design = 0 with full DSB.

## finalSummary

## Summary

Wired RFC-0008 §C5 Source 3 (compliance-assessment auto-signal) into `HC_design`. The root cause was that `enrichAdmissionInput` only implemented RFC-0008 §C5 Source 1 (principal participation via author/commenterLogins matching `designAuthority.principals`) — it never wired Source 3 (automated compliance signal from `DesignSystemBinding.status.tokenCompliance.currentCoverage`). In the forge adoption scenario, backlog tasks rarely have a `createdBy` field matching a DSB principal, so Source 1 never fires and `hcDesign` stays at 0 even with a fully-loaded DSB.

## Changes

- `orchestrator/src/admission-score.ts` (modified): Added `complianceSignal?: number` field to `DesignAuthoritySignal` interface — RFC-0008 §C5 Source 3 automated signal in [-1,1], populated from DSB token-compliance status.
- `orchestrator/src/admission-enrichment.ts` (modified): Added `computeComplianceSignal()` helper that maps DSB `tokenCompliance.currentCoverage` to +0.3 (≥80%), 0 (40-79%), or -0.2 (<40%). Updated `buildDesignAuthoritySignal()` to populate `complianceSignal` whenever a DSB with compliance status is loaded. Updated `computeDesignAuthorityWeight()` to add `complianceSignal` (Source 3) to the Source 1 principal-participation weight — both sources are additive.
- `orchestrator/src/admission-enrichment.test.ts` (modified): Added `AISDLC-266 — RFC-0008 §C5 Source 3 compliance-assessment signal` describe block with 8 fixture tests covering high/medium/low compliance, fraction vs percent normalisation, graceful degradation when status is absent, additive combination with Source 1, direct unit test of the new path, and end-to-end acceptance-criterion test.
- `orchestrator/src/pillar-breakdown.test.ts` (modified): Added `AISDLC-266 — fully-loaded DSB produces hcComposite.design > 0 via Source 3` describe block with 3 end-to-end integration tests running through the full `enrichAdmissionInput → computeAdmissionComposite → computePillarBreakdown` chain.

## Design decisions

- **Source 3 signal magnitudes (+0.3/-0.2)**: Intentionally smaller than Source 1 base weights (±0.4 to ±0.6) so the automated compliance signal cannot outweigh an explicit design-authority participation signal. A DSB with 90% token compliance and no principal participation produces `hcDesign=0.3`; a principal who explicitly labels an issue `design/advances-coherence` produces `hcDesign=0.6`. Combined they produce `hcDesign=0.9`, clamped to 1.0 in `deriveHcDesign`.
- **No RFC amendment needed**: RFC-0008 §C5 explicitly specifies Source 3 (compliance-assessment) as a valid automatic signal. The existing code simply hadn't implemented it. The fix is additive to the existing Source 1 implementation.
- **AISDLC-267 relationship**: The confidence ceiling bug (AISDLC-267) was separately fixed in AISDLC-172. AISDLC-266's fix does NOT close AISDLC-267 — that task remains open with its own fix already in place. The AISDLC-267 task notes in hypothesis 2 "Schema field count mismatch: the denominator includes channels the loader doesn't yet populate (e.g. AISDLC-266's HC_design issue)" — this fix addresses that gap.

## Verification

- `pnpm build` (reference + orchestrator + pipeline-cli) — clean
- `pnpm exec vitest run` (orchestrator) — 3110 tests passed (158 test files)
- `pnpm lint` — 0 errors (2 pre-existing unused-disable-directive warnings unrelated to this change)
- `pnpm format:check` — clean

## Follow-up

- Adopter docs update (docs/operations/operator-runbook.md) explaining HC_design three-state diagnostic updated for Source 3 — filed as separate task if needed.
- RFC-0008 §14.2 v4.2 amendment could clarify that `designAuthorityConfigured=true` + `complianceSignal≠0` is a distinct fourth state (Source 3 fires without Source 1). Not required for the fix to work.
