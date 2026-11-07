---
id: AISDLC-1217
title: 'Pane death posts to dispatch and releases the claim at once'
status: To Do
assignee: []
created_date: '2026-11-07'
labels:
  - dispatch
  - hierarchy
  - dec-0392
dependencies: []
references:
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/hierarchy/spawn.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
priority: high
dispatchable: true
---

## Description

**Source.** DEC-0392, part 2 of 4. An executor whose tmux window dies is noticed only when the 30-second tick polls `listWindows` and then only reaped once the heartbeat is older than the 10-minute grace (`stall.ts`, `graceMs`). Nothing listens for the exit itself: there is no tmux `pane-died` hook and no `session.exit` handler in `ai-sdlc-plugin/hooks/hierarchy/*`.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a dead executor must release its claim; "dead" is a fact tmux knows the instant it happens, so no grace period is a requirement. 2. Deleted: the 10-minute `graceMs` path for a `gone` holder in `stall.ts` and the `AI_SDLC_DISPATCH_STALL_GRACE_MS` setting, once the event path exists. 3. Simplified: `cli-hierarchy spawn` sets `remain-on-exit` and a `pane-died` hook on the executor window that runs `cli-hierarchy pane-exited --session <name> --exit-code <n>`; that subcommand writes a `failed/` diagnostic with `cause: executor-exited` and the exit code, clears the holder, and requeues the claim (same requeue path as today, `cli/hierarchy.ts` reap branch), then kills the window. The dispatch module's `session.receive` already triggers a tick on a verdict line; the subcommand sends the same kind of line so the board refreshes. 4. Accelerated: release in seconds instead of up to 10 minutes plus a tick. 5. Automated: nothing beyond the hook.

Scope note: `kill-window` from `cli-hierarchy down` must not fire the hook as a death; the subcommand checks the board for a deliberate `down` marker (or `down` removes the hook before killing) and does nothing in that case.

## Acceptance Criteria
- [ ] #1 Killing the claude process inside a spawned executor window (test with a fake command in the window) produces a `failed/` diagnostic with `cause: executor-exited`, the claim back in `queue/`, and no `.state.json` left in `inflight/`, within one tick.
- [ ] #2 `cli-hierarchy down` on a busy executor does not produce an `executor-exited` diagnostic.
- [ ] #3 The `gone`-holder grace branch and `AI_SDLC_DISPATCH_STALL_GRACE_MS` are removed from `stall.ts`, its tests and `docs/operations/cli-hierarchy.md`; the `gone` state in `status.ts` stays as display.
- [ ] #4 Vitest covers the subcommand: diagnostic shape, requeue, idempotence when called twice for the same session.
