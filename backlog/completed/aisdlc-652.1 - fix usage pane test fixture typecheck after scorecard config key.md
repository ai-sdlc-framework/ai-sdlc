---
id: AISDLC-652.1
title: >-
  Fix the usage pane data test fixture that no longer type-checks after the scorecard config key landed
status: Done
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - usage-ledger
  - tui
  - typecheck
dependencies:
  - AISDLC-652
references:
  - pipeline-cli/src/usage/pane-data.test.ts
  - pipeline-cli/src/usage/usage-config.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two changes merged in parallel and each passed its own checks, but together they break
`tsc --noEmit` on main. The scorecard change added a required `scorecardMinTasks` key to
`ResolvedUsageConfig` (integer, at least 1, default 30). The usage pane change builds a
`ResolvedUsageConfig` literal in `pipeline-cli/src/usage/pane-data.test.ts` that was written
before that key existed, so the literal is now missing a required property. The failure
breaks the pre-commit typecheck for every executor working in the repository.

This task restores a clean typecheck with the smallest possible change and no behaviour
change.

## Conventions
- Do not edit anything under `.ai-sdlc/`.
- TypeScript strict, ESM, `.js` import extensions; tests never read the real home directory.

## Scope
1. Verify in a fresh worktree off `origin/main` that `pnpm typecheck` fails and record where.
2. Fix the fixture by supplying `scorecardMinTasks` with the shared default value, using the
   existing default constant or resolver helper if one is exported, otherwise the literal 30.
3. Check whether any other fixture or literal of `ResolvedUsageConfig` is affected and fix
   those the same way.

## Acceptance Criteria
- [x] `pnpm typecheck` passes on the branch, and the failure it fixed was reproduced on a fresh worktree of `origin/main` first.
- [x] The usage and pane tests pass unchanged apart from the fixture.
- [x] The change touches only test fixtures, with no change to runtime behaviour.
- [x] No file under `.ai-sdlc/` is changed.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
Restored a clean `tsc --noEmit` on main. The usage pane data test built a `ResolvedUsageConfig` literal without the required `scorecardMinTasks` key that the scorecard change added, so the two changes, merged in parallel, broke the typecheck that every executor runs before committing.

## Changes
- `pipeline-cli/src/usage/pane-data.test.ts` (modified): the injected-config fixture now sets `scorecardMinTasks` to the shared `DEFAULT_SCORECARD_MIN_TASKS` constant from `usage-config.ts` instead of repeating the number 30.

## Design decisions
- **Shared constant, not a literal**: the default is exported by `usage-config.ts`, so the fixture follows it if the default ever changes.
- **Failure verified first**: after a full build in a fresh worktree off `origin/main`, `pnpm typecheck` reported exactly one error, at `pane-data.test.ts(88,7)`; no other `ResolvedUsageConfig` literal was affected. Before a build, a fresh worktree also reports unrelated unresolved-module errors from the missing `dist` of `@ai-sdlc/reference`, which are not this failure.

## Verification
- `pnpm typecheck` — clean (0 errors, was 1)
- usage and pane tests — 187 passing
- `pnpm dark-code:check`, `pnpm lint`, `pnpm format:check`, rfc-docs tests — clean
- main-health monitor was green on the main head, because vitest does not typecheck; no `[main-health]` issue exists

## Follow-up
- declined: add a typecheck step to the required pull request checks so merge skew like this is caught before it lands on main, because the check set is repository configuration that the operator owns
