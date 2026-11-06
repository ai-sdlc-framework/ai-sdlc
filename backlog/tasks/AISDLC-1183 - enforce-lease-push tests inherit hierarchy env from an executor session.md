---
id: AISDLC-1183
title: 'enforce-lease-push tests fail when hierarchy env vars leak in from an executor session'
status: In Progress
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

**Problem.** `ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs` fails 14 tests when run from an executor session, and passes when the `AI_SDLC_HIERARCHY_*` and executor task variables are unset (observed by the AISDLC-1179 executor). The cause is not yet located: the `invoke` helper already passes an explicit environment built from scratch (`gitEnv` plus per-test extras), so the leak comes through another path, for example a helper that spawns without `env`, a git shim, or the hook reading session state from files. Every executor that runs `pnpm test` hits this, so a green local run depends on which session ran it.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the tests must model the hook's inputs exactly; inheriting the runner's session identity is not a requirement. 2. Deleted: whatever path carries the runner's hierarchy and task-binding state into the hook under test. 3. Simplified: every spawn in the suite uses one scrubbed base environment, with tests adding variables explicitly. 4. Accelerated: no false failures in executor runs. 5. Automated: a test runs the suite's helper with the variables set and asserts the outcome is unchanged.

## Acceptance Criteria

- [ ] AC-1: The PR body names the path that carried the session state into the failing tests, and the fix closes it; tests that need those variables pass them explicitly.
- [ ] AC-2: The suite passes with those variables exported in the shell, shown by a test or a documented command in the PR body.
- [ ] AC-3: `enforce-lease-any-branch.test.mjs` is checked for the same leak and fixed the same way if affected.
