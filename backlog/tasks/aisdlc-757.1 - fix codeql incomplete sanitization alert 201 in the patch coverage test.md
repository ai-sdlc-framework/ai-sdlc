---
id: AISDLC-757.1
title: >-
  Fix CodeQL alert 201 (js/incomplete-sanitization) in scripts/check-pr-patch-coverage.test.mjs left on main by AISDLC-757
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - ci
  - security
  - codeql
  - follow-up
dependencies: []
references:
  - scripts/check-pr-patch-coverage.test.mjs
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-757 (#1302) merged at 20:38 UTC on 2026-10-10 while its executor was still fixing the CodeQL finding that had turned the PR's CodeQL check red, so main now carries open CodeQL alert 201: `js/incomplete-sanitization` (warning) at `scripts/check-pr-patch-coverage.test.mjs:473`, "This does not escape backslash characters in the input". The test builds a RegExp from a string after escaping only some metacharacters; the same pattern appears in the `notBarrel` helper near line 403.

The fix is already written and verified locally: commit ab28d2b5 in `.worktrees/aisdlc-757` ("fix: avoid incomplete regex sanitization in patch-coverage test") replaces the RegExp construction with a plain substring `includes` check at both sites. Reuse that commit as the starting point (cherry-pick it onto a fresh branch from main), confirm the alert closes on the PR's CodeQL run, and do not dismiss the alert by hand.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] `scripts/check-pr-patch-coverage.test.mjs` no longer builds a RegExp from partially escaped input at line 473 or in `notBarrel`; both use substring matching.
- [ ] The PR's CodeQL check is green and alert 201 is closed by the fix, not dismissed.
- [ ] `pnpm test:patch-coverage-gate` passes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Parent: AISDLC-757. Starting point: `.worktrees/aisdlc-757` commit ab28d2b5 (executor epsilon). Sub-id filed by the planner on dispatch's request.
