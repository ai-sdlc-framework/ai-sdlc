---
id: AISDLC-718
title: >-
  One role-resolution implementation: consolidate onto caller-identity
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - refactor
  - hierarchy
dependencies: []
references:
  - pipeline-cli/src/hierarchy/caller-identity.ts
  - pipeline-cli/src/hierarchy/caller-identity.test.ts
  - ai-sdlc-plugin/hooks/lib/hierarchy-role.js
  - pipeline-cli/src/cli/complete-task.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Session role is resolved in three places (`session-role.ts`, `hierarchy-role.js`, and
`caller-identity.ts`), and `completeTask` carries its own inline claim check. They were
written at different times against different review findings and can disagree, so a guard
may refuse in one path and allow in another.

Notes: `session-role.ts` does not exist on origin/main yet (it is in an in-flight PR), so
it is described here in prose; the implementer locates it after that PR lands. Run this
after the project-scoped session names task, which touches the same code.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared
  `/tmp` path.

## Acceptance Criteria
- [ ] One module (`pipeline-cli/src/hierarchy/caller-identity.ts`) owns: roster lookup, pid ancestry walk with a running-status filter, role lookup, and claim ownership. The other implementations are deleted or become thin re-exports; the hook's JavaScript copy (`ai-sdlc-plugin/hooks/lib/hierarchy-role.js`) and the TypeScript copy share one source or a generated artifact with a test that fails when they differ.
- [ ] `completeTask`'s inline claim check (`pipeline-cli/src/cli/complete-task.ts`) uses the shared function.
- [ ] A table-driven test runs the same fixtures (planner, dispatch, executor with a claim, executor without, stale pid, missing roster, linked worktree) through every entry point and asserts identical verdicts.
- [ ] No behaviour change other than removing disagreements; each removed disagreement is listed in the PR with which behaviour was kept and why.
- [ ] PR body carries a "Velocity impact" section.

## Out of scope
- New rules; changing roster format.
<!-- SECTION:DESCRIPTION:END -->
