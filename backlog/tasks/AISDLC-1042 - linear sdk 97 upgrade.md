---
id: AISDLC-1042
title: 'Dependency: upgrade @linear/sdk from 37 to the current 97 line and fix the node types resolution it breaks'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - dependencies
  - orchestrator
dependencies: []
references:
  - orchestrator/src/adapters/backlog-md/index.ts
  - orchestrator/package.json
  - pnpm-lock.yaml
priority: medium
dispatchable: true
---

## Description

Dependabot PR #1758 (@linear/sdk 37.0.0 to 97.2.0, sixty majors) has been red since 2026-10-17. The code failure, same in Build & Test and Integration Tests:

```
reference build: src/adapters/backlog-md/index.ts(54,40): error TS2591: Cannot find name 'node:fs/promises'. Do you need to install type definitions for node?
```

The bump changes peer resolution so `@types/node` is no longer visible to that package's reference build. Upgrade @linear/sdk in one PR, make `@types/node` an explicit devDependency where the reference build needs it, and adapt any Linear client call whose signature changed between 37 and 97 (check the adapter that uses it). Dependency review failed on the 2026-10-17 run because the dependency graph was not yet enabled (it is now, so that job passes on the next run), and issue-link fails because bot PRs carry no task; both are policy, not code, and go away when this task's own PR carries the bump.

**Five-step review (requirements first).** Requirement questioned: does the repository need this dependency at the new version at all, or can the bump be dropped? Deletion: the stale Dependabot PR is not closed by us; once main carries the bump Dependabot retires it on its own. Simplified: one PR that bumps the package and adapts the code, instead of pushing fixes onto a bot branch. Accelerated: the fix is scoped to the exact compile or format error quoted below, no refactor. Automated last: nothing new; the existing Dependabot group and auto-merge keep working after this lands.

## Acceptance Criteria

- [ ] @linear/sdk 97.x in `pnpm-lock.yaml`; the Linear adapter compiles and its existing tests pass.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
- [ ] A test exercises the Linear adapter entry point against the 97 client shape (mocked), failing on the 37 shape.
- [ ] PR body names Dependabot PR #1758 as superseded; nobody closes it by hand.
