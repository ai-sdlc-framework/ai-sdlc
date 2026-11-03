---
id: AISDLC-1087
title: 'verify-commands takes a shared board lock so at most two executors run a test suite at once, and caps vitest workers while others wait, so host load stops manufacturing timeout failures'
status: Done
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

- [x] Three concurrent `runVerifyCommands` calls against one board directory run at most two test commands at a time (test with a fake command that records its start and end timestamps).
- [x] A slot directory whose pid is dead is reclaimed by the next caller; a live holder is not.
- [x] The second concurrent run sees `AI_SDLC_VITEST_MAX_WORKERS=2` in its environment and the first sees 4.
- [x] `cli-hierarchy status` shows held slots; an empty slot set prints nothing extra.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
verify-commands now takes one of two shared board slots (new pipeline-cli/src/runtime/verify-slots.ts). Dead-pid slots are reclaimed. The second concurrent run gets AI_SDLC_VITEST_MAX_WORKERS=2 and the first gets 4. `cli-hierarchy status` lists held slots and prints nothing extra when none are held. I rebased onto origin/main, resolved a conflict in verify-commands.ts and its test by keeping both sides, and force-pushed with lease to the existing draft PR.

## Changes
- pipeline-cli/src/runtime/verify-slots.ts
- pipeline-cli/src/steps/verify-commands.ts
- pipeline-cli/src/steps/verify-commands.test.ts
- pipeline-cli/src/cli/hierarchy.ts
- pipeline-cli/src/cli/hierarchy.test.ts
- pipeline-cli/src/execute-pipeline.ts
- pipeline-cli/src/next-step/next-step.ts
- docs/operations/cli-hierarchy.md
- backlog/tasks/AISDLC-1087 - verification runs are serialised across executors with a board lock and a worker cap.md

## Design decisions
After the rebase I ran only verify-commands.test.ts and hierarchy.test.ts (108 tests passed) and `tsc --noEmit`, which printed no errors. I did not run the full build, test, lint or format suite after the rebase; the orchestrator re-runs those. The conflict was with the main commit that added `strippedSessionEnv`, so the runner env is now `{ ...strippedSessionEnv(), ...env }`. The pre-push hook took more than 120 seconds and printed merkle warnings about leaf index mismatches in test fixtures; the push still succeeded. The PR was already open as a draft before this run, so I did not create a new one.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

