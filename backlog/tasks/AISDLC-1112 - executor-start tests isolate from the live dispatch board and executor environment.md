---
id: AISDLC-1112
title: >-
  executor-start tests isolate from the live dispatch board and the executor environment (14 failures in every task worktree while a hold or a claim is live)
status: To Do
assignee: []
created_date: '2026-10-29'
labels:
  - hierarchy
  - tests
  - stability
dependencies: []
references:
  - pipeline-cli/src/hierarchy/executor-start.test.ts
  - pipeline-cli/src/hierarchy/executor-start.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Three developer passes on 2026-10-29 (PRs #2025, #2077, #2100) reported `pnpm test` red on 14 tests in `pipeline-cli/src/hierarchy/executor-start.test.ts` with messages such as `board is held: spend paused` and `cannot claim ... not in the queue or not eligible`. None of the touched files were in the hierarchy module, the same tests were red on unmodified main inside the worktree, and they fail alone, so the DEC-0202 flake waiver did not apply and the runs ended `developer-failed` with no reviews.

The tests resolve the board directory and the executor identity from the process environment and the repository (`AI_SDLC_DISPATCH_BOARD_DIR`, `AI_SDLC_ACTIVE_TASK_ID`, the hierarchy session variables, the `.ai-sdlc/dispatch` folder found by walking up from the worktree). Inside an executor session those point at the live board, so a live hold, a live claim or a queue that does not contain the fixture task changes the outcome. The landed loop-guard work papered over one variable with `env -u` in a single test; the leak is general.

**Five-step review (requirements first).** The requirement questioned is "the tests exercise the real board resolution": a unit test of claim logic must not depend on what the machine is doing; the real resolution is covered by the canary. Deleted: the `env -u` workarounds and any test that only passed because the live board was empty. Simplified: every test in the file builds its own temporary board dir and passes it explicitly, and a single `beforeEach` scrubs every `AI_SDLC_*`, `HIERARCHY_*` and `CLAUDE_*` variable. Accelerated: no process-wide state, so the file can run in parallel with the rest of the suite. Automated: a shared `withIsolatedBoard()` test helper in the hierarchy module used by every hierarchy test, with a lint-level check (a test in the same module) that no hierarchy test reads `process.env.AI_SDLC_DISPATCH_BOARD_DIR` without the helper.

Fix: add the helper, migrate `executor-start.test.ts` and the other hierarchy tests that resolve the board from the environment, and make the claim path accept an explicit board dir and worker identity from its options so the tests never fall back to discovery.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `executor-start.test.ts` passes inside a task worktree while the live board has a hold and inflight claims (reproduce by setting `AI_SDLC_DISPATCH_BOARD_DIR` to a board dir with a hold file and an unrelated queue during the test run).
- [ ] Every hierarchy test that needs a board uses the shared isolated-board helper; no hierarchy test reads the live `.ai-sdlc/dispatch` folder (test in the module asserts it).
- [ ] The `env -u` workaround introduced by the loop-guard change is removed.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: `.ai-sdlc/dispatch/failed/` verdicts dated 2026-10-29 for the PRs listed above.
