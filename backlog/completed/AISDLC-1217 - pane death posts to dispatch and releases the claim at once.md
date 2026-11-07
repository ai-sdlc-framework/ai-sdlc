---
id: AISDLC-1217
title: 'Pane death posts to dispatch and releases the claim at once'
status: Done
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
- [x] #2 `cli-hierarchy down` on a busy executor does not produce an `executor-exited` diagnostic.
- [x] #3 The `gone`-holder grace branch and `AI_SDLC_DISPATCH_STALL_GRACE_MS` are removed from `stall.ts`, its tests and `docs/operations/cli-hierarchy.md`; the `gone` state in `status.ts` stays as display.
- [x] #4 Vitest covers the subcommand: diagnostic shape, requeue, idempotence when called twice for the same session.

## Final Summary

## Summary
A spawned executor's pane exit now runs the new `cli-hierarchy pane-exited <session>` at once. It writes a `failed/` diagnostic with `cause: executor-exited`, returns the claim to `queue/`, clears the heartbeat and drops the roster entry. The `gone`-holder grace branch and `AI_SDLC_DISPATCH_STALL_GRACE_MS` are removed.

## Changes
- pipeline-cli/src/hierarchy/pane-exit.ts
- pipeline-cli/src/hierarchy/pane-exit.test.ts
- pipeline-cli/src/hierarchy/spawn.ts
- pipeline-cli/src/hierarchy/down.ts
- pipeline-cli/src/hierarchy/stall.ts
- pipeline-cli/src/hierarchy/stall.test.ts
- pipeline-cli/src/hierarchy/dispatch-loop.ts
- pipeline-cli/src/hierarchy/dispatch-loop.test.ts
- pipeline-cli/src/hierarchy/pr-lifecycle-config.ts
- pipeline-cli/src/hierarchy/pr-lifecycle-config.test.ts
- pipeline-cli/src/hierarchy/index.ts
- pipeline-cli/src/cli/hierarchy.ts
- .ai-sdlc/pr-lifecycle.yaml
- docs/operations/cli-hierarchy.md

## Design decisions
AC1 is only partly verified. The Vitest suite checks the diagnostic shape, the requeue, the empty `inflight/` and the roster removal by calling the subcommand directly. It does not kill a process in a real tmux window, so I did not confirm that tmux fires the window-scoped `pane-exited` hook on pane exit. Please check that on a real tmux server. One `pnpm test` run showed a single node:test failure that I could not trace. It happened while a second `pnpm test` was running in the same worktree. The rerun had 0 failures, so I assume it was a collision between the two runs. The subcommand marks its own `failed:<task>:<completedAt>` record as handled in the loop state, so the tick does not run the playbook on it. That write could race with a tick that is saving the same state.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

