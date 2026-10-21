---
id: AISDLC-1004
title: 'Dogfood runner export import test times out under coverage and keeps main-health red'
status: To Do
assignee: []
created_date: '2026-10-21'
labels:
  - ci
  - dogfood
  - main-health
dependencies: []
references:
  - dogfood/src/runner/exports.test.ts
  - dogfood/package.json
  - .github/workflows/main-health-monitor.yml
  - docs/operations/main-health-monitor.md
priority: high
dispatchable: true
---

## Description

`main-health-monitor.yml` has reported main RED on every push since 2026-10-17 02:29Z (first red at ee1f0084b, last green at 069f27f0a). Every one of those runs fails the same way: all suites pass except the `Coverage (full)` step, where `dogfood test:coverage` fails `src/runner/exports.test.ts > package.json exports > runner subpath re-exports expected symbols` with `Test timed out in 5000ms` (375 of 376 tests pass). The same test passes in the plain `Test (full suite)` step of the same run, and locally. The regression window contains exactly one dogfood change: ee1f0084b dropped the `pretest:coverage` build from `dogfood/package.json`, so the dynamic `import()` of `dist/runner/index.js` under V8 coverage instrumentation now exceeds the default 5 s timeout on the CI runner.

Because the monitor has been red for four days, its signal was lost: the dispatch tick reads the run conclusion and every real main regression in that window looked like the same known red.

**Five-step review (requirements first).**
1. Requirement questioned: does the test need to `import()` the built dist at all? Its purpose is to prove the `./runner` subpath export resolves and exposes `GitHubActionsRunner`; that is a packaging check, so the import stays, but it does not need coverage instrumentation.
2. Delete: nothing to delete.
3. Simplify: give the one import test an explicit timeout (`it(name, fn, 30_000)`) or hoist the import into a `beforeAll` with that timeout; alternatively exclude `dist/**` from the dogfood coverage `include`, which removes the instrumentation cost. Pick the smaller change that makes `pnpm --filter @ai-sdlc/dogfood test:coverage` green on CI.
4. Accelerate: nothing further.
5. Automate: the monitor already runs on every main push; the fix restores its signal. Add a line to `docs/operations/main-health-monitor.md` under the runbook: when `coverage=failure` is the only non-success outcome, read the `Coverage (full)` step log, not the rollup step.

Velocity impact: positive. A green monitor is the only way the dispatch tick distinguishes a new main regression from a known one.

## Acceptance Criteria

- [ ] AC-1: `pnpm --filter @ai-sdlc/dogfood test:coverage` passes on CI with `src/runner/exports.test.ts` green, using an explicit timeout on the import test and/or a coverage `include` that excludes `dist/**`; the chosen mechanism is named in the PR body.
- [ ] AC-2: The first `main-health-monitor.yml` run after this lands concludes `success` (link in the PR body once available, or the follow-up comment).
- [ ] AC-3: `docs/operations/main-health-monitor.md` runbook names the `Coverage (full)` step as the place to read when `coverage=failure` is the only failing outcome.
- [ ] AC-4: No change to the `Fail on test failure` rollup logic and no coverage floor change.

## Notes

Origin: planner diagnosis 2026-10-21 of run 39542564242 (attempt 2 identical), traced back through the monitor history to ee1f0084b (#1741, AISDLC-920).
