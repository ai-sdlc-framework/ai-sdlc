---
id: AISDLC-1183
title: 'enforce-lease-push tests fail when hierarchy env vars leak in from an executor session'
status: To Do
assignee: []
created_date: '2026-11-04'
labels:
  - hooks
  - tests
  - bug
dependencies: []
references:
  - ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs
priority: medium
---

## Description

**Source.** AISDLC-1179 executor verdict, relayed by dispatch 2026-11-04; filed by the planner (class a).

**Problem.** `ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs` fails 14 tests when run from an executor session, and passes when the hierarchy variables are unset. The test's `invoke` helper builds the hook's environment from the parent process environment, so `AI_SDLC_HIERARCHY_*` and the executor task variables set by `cli-hierarchy` reach the hook under test and change its decision. Every executor that runs `pnpm test` hits this, so a green local run depends on which session ran it.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the tests must model the hook's inputs exactly; inheriting the runner's session identity is not a requirement. 2. Deleted: inheritance of hierarchy and task-binding variables from the parent process. 3. Simplified: one scrubbed base environment for the helper, with tests adding variables explicitly. 4. Accelerated: no false failures in executor runs. 5. Automated: a test runs the suite's helper with the variables set and asserts the outcome is unchanged.

## Acceptance Criteria

- [ ] AC-1: The test helper strips `AI_SDLC_HIERARCHY_*`, `AI_SDLC_ACTIVE_TASK_ID` and the executor task variables from the inherited environment; tests that need them pass them explicitly.
- [ ] AC-2: The suite passes with those variables exported in the shell, shown by a test or a documented command in the PR body.
- [ ] AC-3: `enforce-lease-any-branch.test.mjs` is checked for the same leak and fixed the same way if affected.
