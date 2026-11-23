---
id: AISDLC-1402
title: 'Journeys declare additionalCriteria checked against a WCAG success criteria table'
status: To Do
assignee: []
created_date: '2026-11-23'
labels:
  - rfc-0018
  - journey
  - schema
  - orchestrator
dependencies:
  - AISDLC-1400
  - AISDLC-1401
  - AISDLC-1403
references:
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
  - spec/schemas/journey.v1.schema.json
  - orchestrator/src/journey/inheritance-validator.ts
  - orchestrator/src/journey-sa2-router.ts
assumes:
  - RFC-0018
priority: medium
---

## Description

**Gap.** RFC-0018 v0.4 (§5.1, §5.3) adds `accessibility.additionalCriteria`: WCAG success criteria above the declared level, listed by number. Each entry MUST exist in the declared WCAG version and MUST be above the declared level. §5.4 counts any `additionalCriteria` toward Eρ₅ elevation. v0.4.1 (PR #2970) adds two rules: `additionalCriteria` MUST be empty at `wcagLevel: AAA`, and the checks run against a table generated from W3C's `wcag.json`. v0.4.1 also says the declaration validator emits `wcag-version-not-latest` by comparing the PR's base and head. Today no code knows which criteria exist in which version or at which level: for example, 4.1.1 has an empty level in 2.2, and 2.4.13 exists only from 2.2.

**Source.** RFC-0018 §9: v0.4 follow-ups 3 and 4 and the v0.4.1 follow-up naming AISDLC-1402. Rulings: OQ-7 "Engineering amendment (v0.4.1)" items 1 and 2.

**Depends on.** AISDLC-1401 (the advisory rename and the Eρ₅ elevation rule this task extends) and AISDLC-1403 (the PR base-and-head declaration comparator this task reuses).

## Fix

- **Criteria table:** a script generates a vendored data file of each success criterion's number, level and versions from https://www.w3.org/WAI/WCAG22/wcag.json. The file records the source URL and fetch date. In 2.2, a criterion whose level is `''` counts as not existing in that version. A test fails when the set of versions in the table differs from the `wcagVersion` enum.
- **Schema:** `additionalCriteria` is an array of unique criterion numbers (`^\d+\.\d+\.\d+$`).
- **Inheritance validator:** each entry exists in the declared `wcagVersion` and sits above the declared `wcagLevel`. At `AAA` the list must be empty. The list is tighten-only against the parent's `additionalCriteria`.
- **Eρ₅:** any non-empty `additionalCriteria` elevates the journey, extending AISDLC-1401's elevation rule.
- **Advisory:** the declaration validator emits `wcag-version-not-latest` through AISDLC-1403's comparator, only when a journey is added at an older-than-latest version or its `wcagVersion` changes to one. Remove the scoring-pass emission that AISDLC-1401 left in place.

## Acceptance Criteria

- [ ] #1 Tests: `["3.3.6"]` on a 2.2 AA journey passes. `["4.1.1"]` on 2.2 fails (not in the version). `["1.4.3"]` on an AA journey fails (not above the level). An unknown number fails. Any entry at `AAA` fails.
- [ ] #2 Test: a journey with non-empty `additionalCriteria` is Eρ₅-elevated under a parent at the same level and version.
- [ ] #3 Tests: the advisory is emitted when a 2.1 journey is added or changed to 2.1. It isn't emitted for an unchanged 2.1 journey on a PR, or on any scoring pass.
- [ ] #4 Test: the table's set of versions equals the `wcagVersion` enum, and the file names its W3C source URL and fetch date.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
