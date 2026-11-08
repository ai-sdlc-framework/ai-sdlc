---
id: AISDLC-718
title: >-
  One role-resolution implementation: consolidate onto caller-identity
status: In Progress
assignee: []
created_date: '2026-10-04'
labels:
  - refactor
  - hierarchy
dependencies:
  - AISDLC-717
references:
  - pipeline-cli/src/hierarchy/session-role.ts
  - pipeline-cli/src/hierarchy/caller-identity.ts
  - pipeline-cli/src/hierarchy/caller-identity.test.ts
  - ai-sdlc-plugin/hooks/lib/hierarchy-role.js
  - pipeline-cli/src/cli/complete-task.ts
priority: low
dispatchable: true
dispatchableReason: 'Unparked 2026-11-07 by operator ruling (planner critical-path review).'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Unparked 2026-11-07 by operator ruling (planner critical-path review).

Session role is resolved in three places (`session-role.ts`, `hierarchy-role.js`, and
`caller-identity.ts`), and `completeTask` carries its own inline claim check. They were
written at different times against different review findings and can disagree, so a guard
may refuse in one path and allow in another.

Notes (2026-11-07): the three copies are on main: `pipeline-cli/src/hierarchy/session-role.ts` (carries a LOCKSTEP comment and test against `ai-sdlc-plugin/hooks/lib/hierarchy-role.js`), `pipeline-cli/src/hierarchy/caller-identity.ts`, and the inline claim check in `pipeline-cli/src/cli/complete-task.ts`. The project-scoped session names work has landed.

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
