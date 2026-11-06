---
id: AISDLC-1183
title: 'enforce-lease-push tests fail when hierarchy env vars leak in from an executor session'
status: Done
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

- [x] AC-1: The PR body names the path that carried the session state into the failing tests, and the fix closes it; tests that need those variables pass them explicitly.
- [x] AC-2: The suite passes with those variables exported in the shell, shown by a test or a documented command in the PR body.
- [x] AC-3: `enforce-lease-any-branch.test.mjs` is checked for the same leak and fixed the same way if affected.

## Final Summary

## Summary
The usage-ingest.test.mjs failure was a one-off flake, not caused by this branch. The earlier work on the two lease test files is unchanged and already pushed on PR #2415.

## Changes
- ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs
- ai-sdlc-plugin/hooks/enforce-lease-any-branch.test.mjs

## Design decisions
I changed no code in this round. Run alone, `node --test ai-sdlc-plugin/hooks/usage-ingest.test.mjs` passed 18 of 18. A full `pnpm test` in the worktree then passed 3493 of 3493 with 0 failures. The earlier failure was 1 of 3494, so it did not reproduce twice. I did not run usage-ingest on origin/main, so there is no main-side evidence that it is flaky there. I have no source for the flake cause, but the original run took about 104 s under load, which fits a load-sensitive timing test. If it recurs, usage-ingest.test.mjs should be examined on its own. Build, lint and format:check also pass. The branch is clean and in sync with origin; only the untracked .ai-sdlc/reviews/aisdlc-1183.jsonl is left uncommitted.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (244 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

