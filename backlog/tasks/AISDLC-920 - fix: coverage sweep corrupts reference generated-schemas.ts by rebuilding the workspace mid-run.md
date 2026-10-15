---
id: AISDLC-920
title: 'fix: coverage sweep corrupts reference generated-schemas.ts by rebuilding the workspace mid-run'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [bug, ci, build, reference, dogfood, velocity]
dependencies: []
references: [reference/scripts/generate-schemas.ts, reference/package.json, dogfood/package.json, .github/workflows/main-health-monitor.yml]
priority: high
dispatchable: true
---

## Description

main-health went red on main c1eca713 (2026-10-15 17:36Z, run 38781970493's sibling `Full Suite Health Check`): every suite passed (`full-test=success workflow-test=success plugin=success lint=success format=success schemas=success rfc=success smoke=success`) and only `coverage=failure`. The `Coverage (full)` step runs `pnpm test:coverage` = `pnpm -r test:coverage`, which runs every package's coverage in parallel. `dogfood`'s `pretest:coverage` is `pnpm -w --filter '@ai-sdlc/dogfood...' build`, so a second full workspace build starts while the other packages are already running their coverage. In that rebuild `reference`'s `prebuild` (`tsx scripts/generate-schemas.ts && prettier --write src/core/generated-schemas.ts`) failed with:

```
reference prebuild: [error] src/core/generated-schemas.ts: SyntaxError: Declaration or statement expected. (10445:1)
  10443 | };
  10444 |  true
> 10445 | } as const;
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @ai-sdlc/reference@0.34.0 prebuild: `pnpm generate-schemas`
```

`generate-schemas.ts` writes the file with a single non-atomic `writeFileSync` (`generate-schemas.ts:47`) and prettier then re-reads it; a concurrent reader or a second writer of the same tracked file sees a torn file. The `Build (full workspace)` step earlier in the same run had built `reference` cleanly from the same inputs, and regenerating locally on c1eca713 produces no diff against the tracked file, so the inputs are fine and the failure is the concurrent rebuild. The same `pnpm test:coverage` runs in `ai-sdlc-gate.yml` (line 222), so every PR's Coverage job carries the same race.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that `dogfood test:coverage` must rebuild the whole workspace before it runs. In CI the coverage step always follows a full `pnpm build` of the same tree, and CI is the only coverage gate (AISDLC-726), so the rebuild adds nothing there; it exists for a bare local `pnpm test:coverage`, which nothing requires. 2. Deleted: the `pretest:coverage` script in `dogfood/package.json` (the plain `pretest` build hook stays, AISDLC-404 forbids removing it). If the developer finds a reason a local coverage run must self-build, keep the hook but make it build only `dogfood`'s own package (`pnpm --filter @ai-sdlc/dogfood build`), never the dependency closure. 3. Simplified: `generate-schemas.ts` writes to a temp file in the same directory, runs prettier on that, and renames it over `generated-schemas.ts`; it skips the write when the formatted content equals the current file, so a rebuild never touches a tracked file it would leave unchanged. 4. Accelerated: the coverage sweep no longer pays for a second workspace build. 5. Automated: a unit test for the generator covers the unchanged-content skip and the atomic replace (tmp + rename, no window with a partial file); a `node --test` contract on `dogfood/package.json` asserts no `pretest:coverage` script builds other packages.

## Acceptance Criteria

- [ ] `pnpm -r test:coverage` runs no workspace-wide build from inside any package's pre-hook; `dogfood/package.json` keeps its `pretest` hook.
- [ ] `reference/scripts/generate-schemas.ts` replaces `generated-schemas.ts` atomically (write temp, format, rename) and leaves the file untouched when the generated content is unchanged.
- [ ] Tests cover both generator behaviours and the `dogfood` script contract.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass; the `Coverage (full)` step of `main-health-monitor.yml` and the Coverage job of `ai-sdlc-gate.yml` pass on the PR.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Observed once so far (first coverage failure in the day's twelve main-health runs); it is a race, so it will recur under load. The 17:19Z red on 7dfbfda2 was unrelated (a 5.4 s orchestrator test timeout that passed on the next run).
