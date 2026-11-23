---
id: AISDLC-1401
title: 'Journey scoring applies the v0.4 Cκ boost and Eρ₅ elevation rules'
status: To Do
assignee: []
created_date: '2026-11-23'
labels:
  - rfc-0018
  - journey
  - orchestrator
  - admission
dependencies:
  - AISDLC-1400
references:
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
  - orchestrator/src/journey-sa2-router.ts
  - orchestrator/src/journey-sa2-router.test.ts
  - orchestrator/src/journey-wcag-version.test.ts
  - orchestrator/src/journey/conformance.test.ts
  - spec/schemas/journey-config.v1.schema.json
  - docs/operations/journey-metrics.md
  - docs/operations/wcag-version-evolution.md
assumes:
  - RFC-0018
priority: medium
---

## Description

**Gap.** The admission router still scores journeys by the v0.3 rules (AISDLC-466 #802, AISDLC-469 #1531): the Cκ boost fires only when completion-rate is below `alertBelow` (`journey-sa2-router.ts:195-207`, `:313`); Eρ₅ elevation counts only a higher `wcagLevel` (`:165-188`, `:516-519`); `WCAG_VERSIONS` (`:216`) includes `3.0`; the advisory is `wcag-version-superseded` (`:223`, `journey-config.v1.schema.json:248-252`) and fires only for 2.0 (`WCAG_SUPERSEDED_VERSIONS`, `:220`); metric types carry `targetSeconds` (`:207`, `:291`).

**Source.** RFC-0018 §9 "v0.4 follow-ups", items 2, 4, 5, 8 and 9. Spec text: §5.4 (Cκ, Eρ₅, metric fields), §6.2, OQ-7 amendment item 2. Depends on AISDLC-1400 for the v0.4 metric shape.

**Out of scope.** Eρ₅ counting `additionalCriteria` and the advisory's emission point ("when a journey is declared or its version changes"): both wait on the RFC-0018 v0.4.1 amendment and are in AISDLC-1402. Until then the advisory keeps its current emission point.

## Fix

- Metric types gain `unit` and `direction` and drop `targetSeconds`.
- Cκ boost: work targeting a journey gets the boost when any metric is past its threshold in the wrong direction (below `alertBelow` for `higher-is-better`, above `alertAbove` for `lower-is-better`). Applied once per journey however many metrics are past threshold. A metric whose snapshot is stale (OQ-5, `journey/metric-snapshot.ts`) does not trigger it.
- Eρ₅ elevation: elevated when the journey's `wcagLevel` is higher than the parent floor OR its `wcagVersion` is later.
- Remove `3.0` from `WCAG_VERSIONS` and delete the WCAG 3.0 preview path.
- Rename `wcag-version-superseded` to `wcag-version-not-latest` (constant, `journey-config.v1.schema.json` const, docs); it fires for any declared version older than the latest in the enum (today 2.0 and 2.1); still advisory with no scoring impact.
- `docs/operations/journey-metrics.md`: Cκ boost table per §5.4 (direction, threshold field, stale rule, once per journey). Update `docs/operations/wcag-version-evolution.md` for the rename.

## Acceptance Criteria

- [ ] #1 Router tests: a `lower-is-better` `seconds` metric above `alertAbove` boosts Cκ; two metrics past threshold on one journey boost once; a past-threshold metric with a stale snapshot does not boost; a `higher-is-better` metric above `alertBelow` does not boost.
- [ ] #2 Router tests: journey 2.2 AA under a 2.1 AA parent is Eρ₅-elevated; 2.1 AA under 2.1 AA is not.
- [ ] #3 Tests: 2.1 emits `wcag-version-not-latest`; 2.2 emits nothing; the string `wcag-version-superseded` no longer appears outside the RFC and changelog history.
- [ ] #4 `orchestrator/src/journey/conformance.test.ts` OQ-5 and OQ-7 blocks updated to the v0.4 behaviour.
- [ ] #5 `docs/operations/journey-metrics.md` has the Cκ boost table.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
