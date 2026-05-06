---
id: AISDLC-212
title: >-
  Dogfood runner/exports.test.ts times out under concurrent pnpm -r — forces
  AI_SDLC_SKIP_COVERAGE_GATE on every push
status: Done
assignee: []
created_date: '2026-05-06 13:54'
updated_date: '2026-05-06 18:30'
labels:
  - bug
  - testing
  - tech-debt
  - framework-bug
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`@ai-sdlc/dogfood`'s `src/runner/exports.test.ts` (or similar test in that file) times out consistently when run under `pnpm -r --parallel test:coverage` but passes in isolation. Reported by 3+ dev subagents during 2026-05-06 autopilot session (AISDLC-206, 198, 178.1, 204) — every push required `AI_SDLC_SKIP_COVERAGE_GATE=1` to bypass the pre-push coverage gate.

## Impact

- Every PR push from agents/operators requires manual env-var bypass
- Hides real coverage regressions because the gate is always skipped
- Erodes the "ship-with-confidence" property the coverage gate is meant to provide
- Increases friction enough that the operator stops trusting the gate

## Suspected root cause

The test likely imports `@ai-sdlc/reference` or another workspace dep whose dist artifacts aren't built when `pnpm -r --parallel test:coverage` runs across all workspaces simultaneously. Race between dependent package's build and dependent test's import. Or: vitest's `testTimeout` default (5s) is too low for this specific test under parallel CPU pressure.

## Fix options

1. **Bump `testTimeout`** in `dogfood/vitest.config.ts` to 30s for that specific test (or globally in dogfood)
2. **Add `pnpm -r build` as a prerequisite** to `pnpm test:coverage` script so dist artifacts are guaranteed before tests run
3. **Mark the test `concurrent: false`** so it runs serially within its file
4. **Investigate + fix the actual import / build-order issue** — most principled

Recommend starting with option 4 (root-cause investigation) — read `src/runner/exports.test.ts`, identify the slow operation, fix it. If root cause is build-ordering, option 2 is the right structural fix. If it's a true async-resource-leak in the test, fix the test.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 #1 Identify the actual cause of the timeout (build-order race, async leak, or something else)
- [ ] #2 #2 Fix it so `pnpm test:coverage` from repo root passes without `AI_SDLC_SKIP_COVERAGE_GATE=1`
- [ ] #3 #3 No regression in test runtime budget (runner/exports.test.ts should complete in < 5s in normal CI conditions)
- [ ] #4 #4 Document any operator runbook changes if the fix involves new build-prereq semantics
<!-- SECTION:DESCRIPTION:END -->
<!-- AC:END -->

## Final Summary

Implementation shipped via PR #356 (`fix(dogfood): runner/exports.test.ts timeout under concurrent pnpm -r`). The lifecycle close was lost when the now-retired `.github/workflows/backlog-task-complete.yml` workflow failed to fire (one of the orphaned-PR cases that motivated AISDLC-220). This task file is moved to `backlog/completed/` retroactively as part of the post-AISDLC-220 sync sweep.
