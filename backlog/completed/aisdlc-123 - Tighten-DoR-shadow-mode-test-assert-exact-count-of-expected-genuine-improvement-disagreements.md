---
id: AISDLC-123
title: >-
  Tighten DoR shadow-mode test: assert exact count of expected
  genuine-improvement disagreements
status: Done
assignee: []
created_date: '2026-05-01 20:18'
labels:
  - testing
  - rfc-0011
  - phase-2b
  - follow-up
milestone: m-3
dependencies:
  - AISDLC-115.3
references:
  - pipeline-cli/src/dor/shadow-mode.test.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-115.3 test reviewer follow-up (minor).

`pipeline-cli/src/dor/shadow-mode.test.ts` (around line 2114) asserts `r.disagreementRate >= 0` then filters out gate-4/6 'genuine improvement' disagreements before comparing against the 5% threshold.

The honest framing in the file header explains the trade-off, but the test would be slightly stronger if it also asserted:
- The count of EXPECTED genuine-improvement disagreements equals exactly 10 (5 gate-4 fixtures + 5 gate-6 fixtures), so a future fixture rename or skipped fixture surfaces immediately
- `r.total === fixtures.length`, so empty-corpus regressions surface

Trivial change; defense against silent corpus drift.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Test asserts the count of genuine-improvement disagreements is exactly 10 (5 gate-4 + 5 gate-6 fixtures)
- [x] #2 Test asserts `r.total === fixtures.length` so an empty corpus or skipped fixtures fail loudly
- [x] #3 Test header comment updated to reflect the new exact-count assertion
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added 2 defense-in-depth assertions to the DoR shadow-mode test: exact count of genuine-improvement disagreements = 10 (5 gate-4 + 5 gate-6 fixtures), and `r.total === fixtures.length` to catch empty-corpus / skipped-fixture regressions.

## Verification
- pnpm build && pnpm test && pnpm lint && pnpm format:check — clean
- Combined review APPROVED (0c/0M/0m/1s; combined code+test+security since 26-line single-file diff)
<!-- SECTION:FINAL_SUMMARY:END -->
