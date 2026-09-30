---
id: AISDLC-660
title: 'Patch-coverage gate: exclude top-level src/index.ts barrels'
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - ci
  - coverage
priority: high
references:
  - scripts/check-pr-patch-coverage.mjs
  - scripts/check-pr-patch-coverage.test.mjs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`NON_INSTRUMENTED_PATTERNS` excluded index shims with `/(^|\/)src\/.*\/index\.ts$/`, which requires a subdirectory, so top-level `src/index.ts` barrels (`reference/src/index.ts`, `pipeline-cli/src/index.ts`) were demanded to have coverage data although tests never load them. The dark-code gate requires new modules to be re-exported from a barrel, so every new-module PR failed the required patch-coverage gate (PRs #1098, #1099, #1100, #1103).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Pattern becomes `/(^|\/)src\/(?:.*\/)?index\.ts$/`, comment updated; no other relaxation, 80% threshold unchanged
- [x] #2 Tests assert reference/src/index.ts, pipeline-cli/src/index.ts, reference/src/usage/index.ts are excluded
- [x] #3 Tests assert indexer.ts, index.tsx, myindex.ts stay instrumented and fail without coverage
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Widened the barrel exclusion to include top-level `src/index.ts` only; added positive and negative tests in `scripts/check-pr-patch-coverage.test.mjs`.
<!-- SECTION:FINAL_SUMMARY:END -->
