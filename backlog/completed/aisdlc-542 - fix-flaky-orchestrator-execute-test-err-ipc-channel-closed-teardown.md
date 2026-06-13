---
id: AISDLC-542
title: >-
  fix(test): de-flake orchestrator execute.test.ts — ERR_IPC_CHANNEL_CLOSED
  worker-pool teardown race fails the full-suite gate
status: To Do
assignee: []
labels:
  - bug
  - test
  - flaky
  - ci
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - orchestrator/src/execute.test.ts
  - orchestrator/src/execute.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The `@ai-sdlc/orchestrator` vitest run intermittently fails with an unhandled
`Serialized Error: { code: 'ERR_IPC_CHANNEL_CLOSED' }` whose stack is the worker-pool
plumbing (`MessagePort.<anonymous>` / `[nodejs.internal.kHybridDispatch]`), NOT a test
assertion. **Every orchestrator test FILE reports ✓ (passing)** — but the dangling async
error fires after a test finishes, so vitest marks the whole run failed
(`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @ai-sdlc/orchestrator test: vitest run`).

**Observed:** 2026-06-12, PR #907 (AISDLC-518, a pipeline-cli-only change) had its "AI-SDLC
PR Ready Gate" Build-and-Test fail on this error, while the affected-package "CI" run (which
doesn't run orchestrator tests for a pipeline-cli PR) PASSED, and `main-health-monitor` was
green throughout. So the orchestrator suite passes on main and this is an intermittent
worker-pool teardown race, not a real break — but it blocks the full-suite `ai-sdlc/pr-ready`
gate of UNRELATED PRs at random, forcing reruns.

**Likely root cause:** a test in `orchestrator/src/execute.test.ts` (the error fired around
the `executePipeline()` cases — "runs the full pipeline successfully" / "rejects when agent
produces no test files") leaves a child process / IPC channel (or a `process.send`-capable
handle) alive past the test, and Node fires `process.send` on it after the vitest worker's
channel has already closed → `ERR_IPC_CHANNEL_CLOSED`. The `SubagentSpawner` / pipeline path
may `child_process.fork`/`spawn` (or a mock thereof) without an `afterEach` that kills the
child + closes/`unref`s the IPC channel.

**Fix direction (implementer confirms against the code):**
- Identify the test(s) in `execute.test.ts` that cause a child process / IPC handle to
  outlive the test. Look for `fork`/`spawn`/`process.send`/`MessageChannel`/timers/the
  spawner mock not being awaited or cleaned up.
- Ensure deterministic teardown: an `afterEach` (or per-test `finally`) that kills any spawned
  child, closes the IPC channel, and awaits in-flight async work so nothing posts a message
  after the worker tears down. `unref()` alone is not enough if a `send` can still fire.
- If the leak is in production code (`execute.ts`/spawner) rather than the test harness, fix
  the lifecycle there (close the channel on completion/abort) — that's the better fix.
- As a containment-only fallback (NOT the primary fix), an explicit handler that swallows a
  post-teardown `ERR_IPC_CHANNEL_CLOSED` is acceptable only if the real leak can't be removed;
  prefer eliminating the dangling handle.

Cross-ref: same flake CLASS as AISDLC-533 (capture.test.ts real-subprocess timeout) and
AISDLC-518 (test `_artifacts/` pollution) — tests must be hermetic and clean up the OS-level
resources (subprocesses, IPC, temp dirs) they create.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The test(s) in `orchestrator/src/execute.test.ts` that leave a child process / IPC channel alive past the test are identified (name the test + the spawned/forked handle).
- [ ] #2 Deterministic teardown is added so no `process.send` / MessagePort write can fire after the vitest worker channel closes — the spawned child is killed and its IPC channel closed/awaited in an `afterEach`/`finally` (or the lifecycle is fixed in `execute.ts`/the spawner).
- [ ] #3 Test assertions are not weakened — the executePipeline() cases still verify the same behavior.
- [ ] #4 `pnpm --filter @ai-sdlc/orchestrator test` passes consistently across repeated runs (run it several times — no `ERR_IPC_CHANNEL_CLOSED` unhandled error); lint + format clean.
- [ ] #5 Audit sibling orchestrator tests (`execute.guards.test.ts`, `runners/*.test.ts`) for the same fork/spawn/IPC-leak class and apply the same teardown where present.
<!-- AC:END -->
