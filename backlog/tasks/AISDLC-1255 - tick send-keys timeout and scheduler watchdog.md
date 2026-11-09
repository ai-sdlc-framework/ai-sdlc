---
id: AISDLC-1255
title: 'The hierarchy tick bounds every tmux child with a timeout and the reconcile scheduler reports and replaces a tick older than its interval'
status: To Do
assignee: []
created_date: '2026-11-09'
labels:
  - pipeline-cli
  - hierarchy
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/tmux.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/cli/dispatch.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: 'DRAFT, awaiting operator go (peer report from ai-sdlc-io-planner 2026-11-09 03:4xZ). Both hierarchies on the machine lost their scheduler tick to a hung tmux send-keys: monorepo tick pid 96384 for 46h on pane %556 (child 2911), io tick pid 41745 for 2h07m on pane %719. status kept printing "scheduler: up".'
---

## Description

**Gap.** `sendExit` in `pipeline-cli/src/hierarchy/tmux.ts` runs `tmux send-keys -t <pane> /exit Enter` through the synchronous command runner with no timeout. When the target pane is gone or tmux blocks, the child never returns and the whole `cli-hierarchy tick` process hangs. The reconcile scheduler (`cli-dispatch reconcile --watch`) runs ticks single-flight, so one hung tick stops every scheduled tick for good while `cli-hierarchy status` still prints `scheduler: up` and `last tick` ages silently.

**Evidence 2026-11-09.** Monorepo: tick pid 96384 (orphaned, ppid 1) blocked 46 hours on child pid 2911 `tmux send-keys -t %556 /exit Enter`; pane %556 no longer existed; the planner killed both by hand at 03:4xZ. ai-sdlc-io: tick pid 41745 blocked 2h07m on pane %719 while IO-42 sat eligible with 0 inflight; killing the child unblocked the tick within seconds. The monorepo board survived only because the dispatch host runs its own ticks.

**Shape.** Every tmux call made from a tick passes a timeout (a few seconds) through the command runner; on timeout `sendExit` falls back to `killPane`/`kill-session` for the retired executor and records the fallback in the tick result. The scheduler records the pid and start time of the tick it launched; when a tick exceeds N minutes (default: twice the tick interval) it kills it, logs a `tick-stalled` board event and starts the next one. `cli-hierarchy status` prints `scheduler: STALLED (last tick <age>, pid <n>)` when `last tick` exceeds the interval instead of `up`.

## Fix

**Five-step review (requirements first).**
1. Requirement questioned: retiring an idle executor must never stop the drain. Stands.
2. Deleted: nothing; the single-flight guard stays (it prevents overlapping ticks).
3. Simplified: one timeout in the shared command runner covers every tmux call rather than per-call wrappers.
4. Accelerated: a stalled tick is replaced within one interval instead of after an operator notices.
5. Automated: the watchdog and the status line make the stall visible and self-healing; tests cover timeout, fallback and the stall line.

## Acceptance Criteria

- [ ] AC-1: the command runner used by hierarchy tmux calls accepts a timeout; `sendExit`, `confirmExitDialog` and the brief/notify `send-keys` calls pass one (default 5s, env-overridable); a timed-out call returns a non-zero status with `timedOut: true`; unit tests with a fake runner.
- [ ] AC-2: when `sendExit` times out or the pane does not exist, the retire path falls back to `killPane` (then `kill-session`) and the tick result names the fallback; test.
- [ ] AC-3: the reconcile scheduler persists `{pid, startedAt}` of the running tick in `reconcile-scheduler.json`; a tick older than `tickStallMinutes` (default 2x interval) is killed (SIGTERM then SIGKILL), a `tick-stalled` event is appended to `board-events.jsonl`, and the next tick starts; test with a fake clock and process table.
- [ ] AC-4: `cli-hierarchy status` prints `scheduler: STALLED (last tick <age>)` when `last tick` exceeds the interval and the scheduler pid is alive; `up` otherwise; test.
- [ ] AC-5: `docs/operations/cli-hierarchy.md` documents the timeout, the watchdog and the status line, with the manual recovery (`kill <child pid>`).
- [ ] AC-6: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
