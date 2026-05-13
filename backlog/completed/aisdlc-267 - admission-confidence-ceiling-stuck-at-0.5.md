---
id: AISDLC-267
title: Admission confidence ceiling stuck at 0.5 with fully-loaded inputs
status: Done
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - ppa
  - admission
  - confidence
  - rfc-0008
dependencies: []
priority: high
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
---

## Bug

With DID + DSB + maintainers + soul-tracks all loaded clean, the admission engine's confidence score never climbs above 0.5. Something in the field-fill ratio computation is treating an enriched field as defaulted (or as unset).

This caps every fully-prepared task at "medium confidence" and prevents the admission engine from ever recommending the high-conviction fast path.

## Hypotheses to test

1. **Default-vs-enriched conflation**: the confidence calculator's "field is defaulted" predicate uses an equality-with-default check rather than tracking provenance (was-loaded vs was-defaulted). When an adopter loads a value that happens to equal the default, the calculator counts it as defaulted.
2. **Schema field count mismatch**: the denominator (total expected fields) includes channels the loader doesn't yet populate (e.g. AISDLC-266's `HC_design` issue), so even fully-loaded inputs miss N/M fields.
3. **Pillar weight saturation**: confidence might be capped at 0.5 when one specific pillar is at 0, regardless of the others.

## Repro (forge)

```bash
# All four sources loaded clean
cli-admission score --task FORGE-XXX --pillar-breakdown
# overallConfidence: 0.5 (ceiling)
```

## Acceptance criteria

- [ ] Root cause identified — pinpoint which calculation step caps at 0.5.
- [ ] Fix implemented: a fully-loaded admission input produces confidence > 0.5 (specifically: above the high-conviction threshold the policy uses for the fast path).
- [ ] Regression test fixture: DID + DSB + maintainers + soul-tracks all populated → confidence in the high-conviction band.
- [ ] If AISDLC-266 (HC_design wire) is the root cause, this task closes with that fix as the reference. If not, separate fix needed.
- [ ] Adopter docs explain how to debug a stuck-at-0.5 confidence (which fields contribute, how to inspect the computation).

## Source

Adopter session 2026-05-13, ranked #7 by friction. Forge admission cap on fully-prepared work.

## finalSummary

## Summary

The confidence-ceiling bug was already resolved by the AISDLC-172 fix (commit `907662ce`, merged 2026-05-04). The root cause was `computeAdmissionComposite` delegating to `computeConfidence(priorityInput)` from `priority.ts`, which counts populated fields against the full 16-element `SCORABLE_FIELDS` list. The admission mapper only ever populates ~7-8 of those 16 fields, and the four RFC-0008 enrichment readers (DSB / DID / maintainers / soul-tracks) contribute none of them — so confidence was capped in the ~0.44-0.56 band even when every enrichment loader reported success.

The fix replaced it with `computeAdmissionConfidence`, a 50/50 blend of mapper coverage (7-9 admission-relevant fields) and enrichment loaded (5 enrichment slots). With all readers active this yields ~0.78-0.89 — well above the 0.7 high-conviction threshold.

This task ships the remaining AC #5: a `docs/troubleshooting.md` section explaining the confidence bands, how to inspect which mapper fields and enrichment slots were populated, and common causes/fixes for a stuck-at-0.5 reading.

## Changes

- `docs/troubleshooting.md` (modified): added "Admission Confidence" section with debug instructions, confidence bands table, common causes/fixes table, and inline TypeScript snippet for inspecting field coverage.

## Design decisions

- **Troubleshooting over API reference**: the debug guidance lives in `troubleshooting.md` (the adopter-facing runbook) rather than `docs/api-reference/priority.md`, because the primary audience is an adopter whose enrichment wiring is wrong, not an API consumer building new features.
- **No code changes needed**: AISDLC-172 already landed the correct formula + regression fixture suite. This task closes by documenting the fix for adopters.

## Verification

- `pnpm build` — clean
- `pnpm test` — 3099 tests passed (orchestrator + other packages)
- `pnpm lint` — clean

## Follow-up

AISDLC-266 (`enrichAdmissionInput` HC_design channel) is a separate wire-up bug that also contributes to zero `hcComposite.design` when DSB principals are present. That task should be addressed independently.
