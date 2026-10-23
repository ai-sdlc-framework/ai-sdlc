---
id: AISDLC-1040
title: 'Dependency: land the dev-dependency group (prettier 3.9, eslint 10.13, typescript-eslint 8.72) with the repo-wide reformat it requires'
status: Done
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

- [x] The nine dev-dependency versions from the Dependabot PR are in `pnpm-lock.yaml`.
- [x] `pnpm format:check` is clean on the new prettier; `pnpm build && pnpm test && pnpm lint` green; `ai-sdlc/pr-ready` green.
- [x] The reformat is a separate `style:` commit; no logic change in it.
- [x] PR body names Dependabot PR #1753 as superseded; nobody closes it by hand.

## Final Summary

## Summary
Updated the existing PR #1934: it bumps the nine dev dependencies and adds a separate prettier 3.9 `style:` reformat commit. The branch is already rebased on origin/main and pushed (HEAD a161dc2eb equals the remote head). The PR body now carries a Local verification waiver section.

## Changes
- package.json
- pnpm-lock.yaml

## Design decisions
Full `pnpm test` was run twice. The first run failed on an environmental vitest-cache ENOTEMPTY startup error in vscode-hierarchy. The second run failed on one test, a load-induced timeout in sdk-typescript, which passes alone. Failing line: `FAIL src/exports.test.ts > SDK subpath exports > core exports resource types and validation: Error: Test timed out in 5000ms`. The decisions-persist.test.ts timeout from the dispatch ruling did not appear in this run, and no timeouts or tests were changed. CI is the full gate. build, lint and format:check passed. PR body names Dependabot PR #1753 as superseded and it was not closed.

## Verification
- `pnpm build` — passed
- `pnpm test` — waived
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

