---
id: AISDLC-1087
title: 'verify-commands takes a shared board lock so at most two executors run a test suite at once, and caps vitest workers while others wait, so host load stops manufacturing timeout failures'
status: To Do
assignee: []
created_date: '2026-10-27'
labels:
  - pipeline-cli
  - hierarchy
  - performance
priority: high
dispatchable: true
dependencies:
  - AISDLC-1086
references:
  - pipeline-cli/src/steps/verify-commands.ts
  - pipeline-cli/src/runtime/worktree-mutex.ts
  - pipeline-cli/src/next-step/session.ts
  - vitest.shared.mjs
  - docs/operations/cli-hierarchy.md
---

## Description

Measured 2026-10-27 on the operator's 12-core machine: the pipeline-cli suite alone is 546 files and 12,143 tests and takes 154 s wall at load 12 to 20. Each vitest run forks min(4, cores/2) = 4 workers. With five executors up, several suites overlap and up to 20 forks compete for 12 cores while macOS indexing adds its own load; the 15-minute load average has been 20 to 60. Vitest's default per-test timeout is 5 s, so tests with real timers or spawned processes (orchestrator loop filters, chaos, decisions-persist, webhook-receiver, land-prep, the TUI) cross it and fail in files the task never touched. Completed task reports name this directly: "4 timeout failures under full-suite load", "failed three times in executor worktrees with the vitest default 5 s per-test timeout, load average of 25 to 30", "13 TUI timeouts in pipeline-cli under machine load". Those failures are what the developers then waive or reword. The verification node introduced by the task this one depends on would inherit the same contention and produce the same false reds, now as fix rounds.

## Fix

**Five-step review (requirements first).** The requirement questioned is "every executor verifies whenever it is ready": the suite is CPU-bound and the machine is shared, so verification throughput is a property of the machine, not of the executor count. Deleted: nothing. Simplified: one lock, in the board directory the executors already share, taken by the verifier around the test command only (build, lint and format stay unserialised, they are short). Accelerated: a waiting executor is not idle on load, it runs with the slot it gets; two concurrent suites at 4 workers each fit 12 cores with headroom for the rest of the hierarchy. Automated: the lock is taken by code, with a stale-holder age so a killed executor never blocks the board; `cli-hierarchy status` shows who holds a slot.

1. Add `withVerifySlot(boardDir, n, fn)` to `verify-commands.ts` using the atomic `mkdir` pattern from `runtime/worktree-mutex.ts`: slots are `<boardDir>/verify-slots/<i>` directories holding the pid and task id, `n` defaults to 2 and is overridable with `AI_SDLC_VERIFY_SLOTS`; a slot whose pid is gone or older than 30 minutes is reclaimed. Wait is polling with jitter, bounded at 40 minutes, then the run proceeds anyway and the record says `slot: timed out`.
2. `runVerifyCommands` takes the slot around any command that matches `pnpm test` or `vitest`, and sets `AI_SDLC_VITEST_MAX_WORKERS` to 4 when it holds slot 0 and to 2 when it holds slot 1, so the two concurrent suites never exceed 6 forks.
3. The board directory is resolved the way `next-step/session.ts` does (`AI_SDLC_DISPATCH_BOARD_DIR`, else `<workDir>/.ai-sdlc/dispatch`); no board directory means no lock and a logged warning.
4. `cli-hierarchy status` prints the held slots (task id, pid, age) on one line after the board counts.
5. Document the slot count, the env override and the stale rule in `docs/operations/cli-hierarchy.md`.

## Acceptance Criteria

- [ ] Three concurrent `runVerifyCommands` calls against one board directory run at most two test commands at a time (test with a fake command that records its start and end timestamps).
- [ ] A slot directory whose pid is dead is reclaimed by the next caller; a live holder is not.
- [ ] The second concurrent run sees `AI_SDLC_VITEST_MAX_WORKERS=2` in its environment and the first sees 4.
- [ ] `cli-hierarchy status` shows held slots; an empty slot set prints nothing extra.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
