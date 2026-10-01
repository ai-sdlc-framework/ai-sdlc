---
id: AISDLC-662.1
title: 'CI coverage: diff against the merge-ref base and fall back to a full run'
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - ci
  - coverage
priority: high
references:
  - .github/workflows/ci.yml
  - scripts/pr-coverage.sh
  - scripts/pr-coverage.test.mjs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The CI coverage job fetched `origin main` with `--depth=1` and ran `vitest run --coverage --changed origin/main || pnpm test:coverage`. For a PR that is behind main, the depth-1 fetch makes `origin/main` the current tip, so `--changed origin/main` selects no test files, prints "No test files found, exiting with code 0" and exits 0. The full-run fallback never runs, the patch-coverage gate then sees no coverage data and reports MISSING for every changed file even though real coverage is fine (found on PR #1118 and reproduced on a scratch worktree).

The fix runs `scripts/pr-coverage.sh`: it diffs against the pull_request merge ref's first parent (`HEAD^1`), so the selected tests always match the PR's own changes however far main has moved, and it falls back to the full `pnpm test:coverage` run when the changed-only run fails or selects no tests although source files changed. The 80% patch-coverage gate is unchanged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 The PR coverage step in `.github/workflows/ci.yml` runs `scripts/pr-coverage.sh` and no longer shallow-fetches main or runs `--changed origin/main`
- [x] #2 `scripts/pr-coverage.sh` diffs against `HEAD^1` and falls back to the full run when the changed run fails or selects no tests though source files changed
- [x] #3 Hermetic tests reproduce the behind-main case in a scratch git repo with a stub pnpm
- [x] #4 The 80% patch-coverage threshold and the gate step are unchanged
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Coverage for PRs behind main now diffs against the merge ref's first parent with a full-run fallback, so the patch-coverage gate no longer sees zero coverage data.

## Changes
- `.github/workflows/ci.yml` (modified): coverage PR step calls `scripts/pr-coverage.sh`.
- `scripts/pr-coverage.sh` (new): HEAD^1 base, full-run fallback.
- `scripts/pr-coverage.test.mjs` (new): hermetic tests; wired as `pnpm test:pr-coverage-gate`.

## Design decisions
- **Base is HEAD^1 of the merge ref**: it equals the base the merge was computed against, so it never drifts when main moves.
- **Fallback keyed on zero test summaries plus changed source files**: packages with no relevant tests still print "No test files found", so that string alone cannot trigger the full run.

## Verification
- `node --test scripts/pr-coverage.test.mjs` - 5 pass

## Follow-up
(none)
<!-- SECTION:FINAL_SUMMARY:END -->
