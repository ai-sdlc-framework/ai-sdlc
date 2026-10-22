---
id: AISDLC-1040
title: 'Dependency: land the dev-dependency group (prettier 3.9, eslint 10.13, typescript-eslint 8.72) with the repo-wide reformat it requires'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - dependencies
  - tooling
dependencies: []
references:
  - package.json
  - pnpm-lock.yaml
  - .prettierrc.json
priority: medium
dispatchable: true
---

## Description

Dependabot PR #1753 (dev-dependencies group, 9 minor and patch updates: eslint 10.13.0, prettier 3.9.10, typescript-eslint 8.72.0, commitlint 21.2.4, lint-staged 17.6.0, tsx 4.23.15 and others) is red on one step only:

```
pnpm format:check
[warn] Code style issues found in 76 files. Run Prettier with --write to fix.
```

prettier 3.9 formats some constructs differently. ESLint passes. Bump the same nine packages in one PR, run `pnpm format` once, and commit the reformat. Keep the reformat as its own commit so reviewers can skip it. If the diff touches files with an inflight PR, note it in the PR body; the rebase resolver handles prettier drift as mechanical.

**Five-step review (requirements first).** Requirement questioned: does the repository need this dependency at the new version at all, or can the bump be dropped? Deletion: the stale Dependabot PR is not closed by us; once main carries the bump Dependabot retires it on its own. Simplified: one PR that bumps the package and adapts the code, instead of pushing fixes onto a bot branch. Accelerated: the fix is scoped to the exact compile or format error quoted below, no refactor. Automated last: nothing new; the existing Dependabot group and auto-merge keep working after this lands.

## Acceptance Criteria

- [ ] The nine dev-dependency versions from the Dependabot PR are in `pnpm-lock.yaml`.
- [ ] `pnpm format:check` is clean on the new prettier; `pnpm build && pnpm test && pnpm lint` green; `ai-sdlc/pr-ready` green.
- [ ] The reformat is a separate `style:` commit; no logic change in it.
- [ ] PR body names Dependabot PR #1753 as superseded; nobody closes it by hand.
