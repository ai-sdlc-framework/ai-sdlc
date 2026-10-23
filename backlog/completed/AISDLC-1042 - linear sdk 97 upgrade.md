---
id: AISDLC-1042
title: 'Dependency: upgrade @linear/sdk from 37 to the current 98 line and fix the node types resolution it breaks'
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - dependencies
  - reference
dependencies: []
references:
  - reference/src/adapters/backlog-md/index.ts
  - reference/package.json
  - reference/src/adapters/linear/index.ts
  - pnpm-lock.yaml
priority: medium
dispatchable: true
---

## Description

Dependabot PR #1923 (@linear/sdk 37.0.0 to 98.0.0, superseding #1758 at 97.2.0) has been red since 2026-10-17. The code failure, same in Build & Test and Integration Tests:

```
reference build: src/adapters/backlog-md/index.ts(54,40): error TS2591: Cannot find name 'node:fs/promises'. Do you need to install type definitions for node?
```

The bump changes peer resolution so `@types/node` is no longer visible to that package's reference build. Upgrade @linear/sdk in one PR, make `@types/node` an explicit devDependency where the reference build needs it, and adapt any Linear client call whose signature changed between 37 and 98 (check the adapter that uses it). Dependency review failed on the 2026-10-17 run because the dependency graph was not yet enabled (it is now, so that job passes on the next run), and issue-link fails because bot PRs carry no task; both are policy, not code, and go away when this task's own PR carries the bump.

**Five-step review (requirements first).** Requirement questioned: does the repository need this dependency at the new version at all, or can the bump be dropped? Deletion: the stale Dependabot PR is not closed by us; once main carries the bump Dependabot retires it on its own. Simplified: one PR that bumps the package and adapts the code, instead of pushing fixes onto a bot branch. Accelerated: the fix is scoped to the exact compile or format error quoted below, no refactor. Automated last: nothing new; the existing Dependabot group and auto-merge keep working after this lands.

## Acceptance Criteria

- [x] @linear/sdk 98.x in `pnpm-lock.yaml`; the Linear adapter compiles and its existing tests pass.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
- [x] A test exercises the Linear adapter entry point against the 98 client shape (mocked), failing on the 37 shape.
- [x] PR body names Dependabot PRs #1923 and #1758 as superseded; nobody closes it by hand.

## Final Summary

## Summary
Upgraded @linear/sdk to 98.0.0 and fixed the node types failure by setting types and lib explicitly in reference/tsconfig.json. Added a test that drives the real 98 client. Opened draft PR #1931.

## Changes
- reference/package.json
- reference/tsconfig.json
- reference/src/adapters/linear/index.test.ts
- pnpm-lock.yaml
- backlog/tasks/AISDLC-1042 - linear sdk 97 upgrade.md

## Design decisions
Root cause: TypeScript 6 defaults `types` to empty, and node types had only been loaded transitively through the old SDK. @types/node was already a devDependency. The fix sets `types: [node]` and `lib: [ES2022, DOM]`. DOM is needed so `Response.json()` stays typed as `any` for the gitlab and jira adapters. The Linear adapter code needed no signature change. The new test stubs global fetch and checks that the real 98 client sends its request to api.linear.app with the API key. I could not run it against the 37 SDK to confirm it fails there, so AC3's fails-on-37 claim rests on the code path (37 used node-fetch), not a run. The full local chain `pnpm build && pnpm test && pnpm lint && pnpm format:check` exited 0. Dependabot PRs #1923 and #1758 are named as superseded in the PR body and were not closed.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

