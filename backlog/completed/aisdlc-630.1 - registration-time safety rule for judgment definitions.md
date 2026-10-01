---
id: AISDLC-630.1
title: >-
  RFC-0049: registration-time safety rule for judgment definitions (seam, bidirectional, reducesReview)
status: Done
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - judgment-layer
  - reference
  - security
dependencies:
  - AISDLC-630
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/judgment/catalog.ts
  - reference/src/judgment/definition.ts
  - reference/src/judgment/evaluate.ts
  - reference/src/judgment/catalog.test.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A `bidirectional` definition with risk class `seam` or `tighten` can decide
permissively (`evaluate.ts` sets `permissiveAllowed` for bidirectional definitions on
backlog items) while being held to the lower promotion bar, sidestepping the stricter
`relax` bar. This task closes that at registration time.

Extend `JudgmentDefinition` with optional `fallback?: 'pending'`,
`reducesReview?: boolean` and `reducingOutcomes?: readonly string[]`, and enforce in
`registerJudgmentDefinition`, before any state change, failing closed with an error
naming the definition id and the rule:
- (a) `riskClass: 'seam'` requires `fallback === 'pending'`.
- (b) `seam` + `bidirectional` requires `reducingOutcomes` declared as an empty array.
- (c) `reducesReview: true` or a non-empty `reducingOutcomes` requires `riskClass: 'relax'`
  and mutual consistency; invalid runtime values are rejected.

Positive shapes must still register: tighten + bidirectional with no declarations, a
conforming seam, and a relax definition with reducing outcomes. Document the rules in
`docs/operations/judgment-definitions.md`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rule (a), rule (b) and rule (c) each reject their violating definitions with an error naming the id and the rule, covered by tests.
- [x] #2 Garbage runtime values and inconsistent declarations are rejected, and a rejected registration leaves the catalog unchanged.
- [x] #3 The tighten + bidirectional, conforming seam and relax-with-reducing-outcomes shapes register; existing tests pass.
- [x] #4 The rules are documented in docs/operations/judgment-definitions.md and linked from docs/operations/README.md.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added optional `fallback`, `reducesReview` and `reducingOutcomes` declarations to
`JudgmentDefinition` and enforced rules (a), (b) and (c) in `registerJudgmentDefinition`
before the map insert, failing closed with an id- and rule-naming error. Tests cover each
rule, garbage input, the positive shapes and no-state-on-reject. Rules documented in
`docs/operations/judgment-definitions.md`.
<!-- SECTION:FINAL_SUMMARY:END -->
