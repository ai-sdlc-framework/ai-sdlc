---
id: AISDLC-1088
title: 'vitest shared config sets a 30 s per-test timeout, the root test script does not stop at the first failing package, and the real-timer tests over 2.5 s use fake timers'
status: To Do
assignee: []
created_date: '2026-10-27'
labels:
  - testing
  - performance
priority: medium
dispatchable: true
dependencies: []
references:
  - vitest.shared.mjs
  - package.json
  - pipeline-cli/src/orchestrator/loop.filters.test.ts
  - pipeline-cli/src/orchestrator/chaos.test.ts
  - pipeline-cli/src/usage/replay.test.ts
  - pipeline-cli/src/orchestrator/loop.dor-decisions.test.ts
  - pipeline-cli/src/cli/decisions-persist.test.ts
  - pipeline-cli/src/orchestrator/loop.umbrella.test.ts
  - pipeline-cli/src/orchestrator/loop.dispatchability.test.ts
---

## Description

Timed full pipeline-cli run on 2026-10-27 (154 s wall, load 12 to 20): the slowest single test is 8.5 s (`loop.filters.test.ts`, "emits OrchestratorStuckCandidate exactly once after >5 ticks") and eleven more take 2.5 s to 3.7 s, all orchestrator tick loops, chaos ticks, usage replay and the remote decisions-persist test. They run under vitest's default 5 s per-test timeout, which nothing in `vitest.shared.mjs` or the package configs overrides, so under executor contention they are the first to fail in files a task never touched. Separately, the root `pnpm test` is `pnpm -r test && ...` and stops at the first failing package, so a developer whose pipeline-cli run fails never sees the orchestrator or plugin results (reported in completed tasks as "stopped at the first failing package, I did not see the remaining packages").

## Fix

**Five-step review (requirements first).** The requirement questioned is "5 s is the right per-test budget": it is vitest's default, chosen for unit tests, and this repo's tick-loop tests legitimately spend seconds in real I/O; a timeout exists to catch hangs, not slow tests, and 30 s still catches a hang. Deleted: the real `setTimeout` waits in the tests listed, replaced by `vi.useFakeTimers` and `advanceTimersByTimeAsync`, where the loop under test allows it. Simplified: one `testTimeout` and one `hookTimeout` in the shared preset, no per-file overrides. Accelerated: the listed tests drop from 2.5 to 8.5 s each to well under a second; the root script reports every package in one run with `--no-bail`. Automated: a shared-config test asserts the timeout values so a later edit cannot silently drop them.

1. `vitest.shared.mjs`: `testTimeout: 30_000`, `hookTimeout: 30_000`, exported with the existing `sharedTestConfig`; add a unit test next to `resolveMaxWorkers` that reads the preset.
2. Root `package.json`: `pnpm -r --no-bail test` so every package runs; the exit code stays non-zero when any fails.
3. Convert the tests over 2.5 s in the referenced files to fake timers where the code under test polls or sleeps; where it spawns a real process, reduce the fixture (fewer ticks, smaller corpus) so the test still proves the same assertion in under 1 s. Record the before and after per-test times from `vitest run --reporter=verbose` in the PR body.
4. Leave `*.flaky.test.ts` and the nightly flaky workflow untouched.

## Acceptance Criteria

- [ ] `vitest run --reporter=verbose` in pipeline-cli shows no test above 2 s on an idle machine; the before and after table is in the PR body.
- [ ] A test asserts `sharedTestConfig.testTimeout === 30000` and `hookTimeout === 30000`.
- [ ] With a deliberately failing test in pipeline-cli, root `pnpm test` still runs the orchestrator package tests and exits non-zero.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
