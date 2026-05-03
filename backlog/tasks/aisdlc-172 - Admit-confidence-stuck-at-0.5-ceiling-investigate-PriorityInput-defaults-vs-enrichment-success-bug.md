---
id: AISDLC-172
title: 'Admit confidence stuck at 0.5 ceiling: investigate PriorityInput-defaults-vs-enrichment-success bug'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - bug
  - rfc-0008
  - orchestrator
  - admit-confidence
priority: medium
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
  - orchestrator/src/
---

## Description

This bug surfaces Alex's practitioner observation filed as RFC-0009 §13 OQ-9
(verbatim): "With DID + DSB + maintainers + soul-tracks all loaded, admit
confidence stayed at 0.5 (expected ≥0.7 given enrichment richness). Suggests
confidence is computed from `PriorityInput` field defaults rather than
enrichment success."

Operator triage: out-of-scope for RFC-0009 acceptance; the affected abstractions
(`PriorityInput`, the admit-confidence computation, the enrichment-success
signal contract) all live in RFC-0008 — file as a standalone bug against
RFC-0008 and resolve OQ-9 by reference.

## Hypothesized root cause (Alex's framing)

The 0.5 ceiling under maximum enrichment is the smoking gun: 0.5 is the natural
midpoint output of a Beta-prior or sigmoid-default computation that has received
no positive evidence to update against. If admit confidence is reading
`PriorityInput` field default values rather than the enrichment-success signal
(which would carry "DID loaded ✓ + DSB loaded ✓ + maintainers loaded ✓ +
soul-tracks loaded ✓" as four independent positive observations), the formula
will correctly return 0.5 because, from its perspective, no evidence ever
arrived.

The fix shape depends on whether (i) `PriorityInput` should receive the
enrichment-success signal but the wiring is missing, or (ii) the confidence
computation should query enrichment-success directly and bypass `PriorityInput`
defaults. Either fix must produce admit confidence ≥0.7 for the
fully-loaded-readers path described in OQ-9.

## Acceptance Criteria

- [ ] #1 Reproduce the issue in a hermetic test fixture: construct an
      admission input with DID + DSB + maintainers + soul-tracks all loaded,
      run the admit-confidence computation, and assert the resulting
      confidence value (capturing the observed 0.5 vs the expected ≥0.7
      delta).
- [ ] #2 Determine root cause: classify as
      defaults-instead-of-enrichment-success (Alex's hypothesis) or some other
      bug surfacing identically. Document the determination with the evidence
      chain (code path traced for the confidence formula's inputs, where
      `PriorityInput` defaults vs enrichment-success signals diverge).
- [ ] #3 Fix the confidence computation so admit confidence reflects actual
      enrichment richness. The fully-loaded-readers fixture from AC #1 must
      produce admit confidence ≥0.7.
- [ ] #4 Add regression test covering the DID + DSB + maintainers +
      soul-tracks fully-loaded path, asserting the ≥0.7 threshold and pinning
      the exact computed value to prevent silent regression to the 0.5
      ceiling.
- [ ] #5 Triage RFC-0009 §13 OQ-9 as RESOLVED, pointing the resolution at
      this task's outcome (link this task ID + the resolving PR from OQ-9).

## Notes

- Out-of-scope for RFC-0009 acceptance per operator triage — the abstractions
  affected (`PriorityInput`, admit-confidence computation) are RFC-0008
  surface area.
- The 0.5 ceiling is itself diagnostic: a Beta-prior or sigmoid-default
  formula with no positive evidence will return exactly 0.5; this is
  consistent with Alex's hypothesis that the formula is reading defaults
  rather than enrichment-success signals. Investigators should preserve this
  diagnostic value in the fixture (assert exact 0.5 for the bug-state, then
  assert ≥0.7 after fix).
- **Provenance reference (in-flight RFC):** the source observation lives in
  `spec/rfcs/RFC-0009-tessellated-design-intent-documents.md` §13 OQ-9. That
  RFC isn't on `main` yet (in-flight on a separate branch), so it is cited
  here in the body rather than in frontmatter `references:` (matches the
  AISDLC-165 precedent for in-flight RFC citations + keeps the
  `backlog-drift` gate green). Once RFC-0009 lands on main, a follow-up may
  promote the reference into frontmatter.
