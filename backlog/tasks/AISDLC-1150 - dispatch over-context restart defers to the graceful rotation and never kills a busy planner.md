---
id: AISDLC-1150
title: 'Dispatch over-context restart defers to the graceful rotation: rotate request first, handoff written before any kill, no hard restart of a busy planner'
status: To Do
assignee: []
created_date: '2026-11-01'
labels:
  - hierarchy
  - dispatch
  - incident
dependencies: []
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/restart.ts
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/hierarchy/status.ts
  - ai-sdlc-plugin/hooks/hierarchy/planner.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

On 2026-11-01 at 22:23:26Z the dispatch tick hard-restarted the planner session while it was in the middle of a tool call. The planner was lease-pushing the signed head of AISDLC-1130 to PR #2263 (DEC-0285 relief); the pre-push coverage gate was running when the pane was killed, the command ended with exit 137 and the push never happened. No handoff was written and no `last-reply:` text reached the new session, so the operator found a fresh planner with a RESUME block four hours stale.

Cause: `runRestarts` in `dispatch-loop.ts` (AISDLC-1110) restarts any non-dispatch session whose `overThreshold` flag holds for `RESTART_AFTER_TICKS` consecutive ticks. The planner had been at about 156k tokens against its 150k threshold. The planner's hooks module (`ai-sdlc-plugin/hooks/hierarchy/planner.ts`) owns a graceful rotation for exactly this case: it writes the handoff, stores the last reply and clears, and it deliberately waits for `turn.complete` so it never rotates mid-turn. The dispatch rule does not know about that deferral, so the two race and the hard kill wins whenever the planner is inside a long turn. `restart()` in `restart.ts` only protects an executor that holds an inflight manifest; a busy planner or dispatch pane has no equivalent guard.

**Five-step review (requirements first).**
1. Requirement questioned: does dispatch need to restart an over-context planner at all? The planner's module already rotates at the threshold at the next turn boundary. Dispatch's rule exists for sessions whose module is absent or stuck. The requirement is therefore a backstop, not the primary path.
2. Delete: nothing to delete; the hard restart stays as the last resort for a pane that never reaches a turn boundary.
3. Simplify: one order of operations for every role: ask the session's module to rotate (the `cli-hierarchy clear <name>` request path, RFC-0058 phase 4, which `planner.ts` already consumes as `rotate`), wait, and only then hard-restart. The over-context rule becomes a request, not a kill.
4. Accelerate: the restart command writes the role's handoff itself (`handoff write --role <role>`) before stopping the window, so even the fallback preserves state; the new session's `handoff read` then reflects the moment of the kill.
5. Automate: unit tests on `runRestarts` (over-context on a busy session produces a rotate request, not a restart; the hard restart only after the grace lapses) and on `restart()` (refuses a busy planner or dispatch without `--force`; writes the handoff before `stopSessionWindow`).

Velocity impact: positive. A planner rotation at a turn boundary costs one `/clear`; a mid-command kill costs the interrupted work, a stale handoff and the operator's time to reconstruct it.

## Acceptance Criteria

- [ ] AC-1: In `dispatch-loop.ts`, the `over-context` cause for a session with a hooks module (planner, executor) first issues a rotate request through the existing clear/rotate request path instead of calling `restartSession`. The `RestartReport` gains a status `requested-rotate`. A hard restart for `over-context` happens only when the session is still over threshold and has not rotated after a grace of `N` ticks (default 6, configurable next to `RESTART_AFTER_TICKS`), and never while `status` reports the session `busy`.
- [ ] AC-2: `restart()` in `restart.ts` refuses a `planner` or `operator-dispatch` target whose live state is `busy` unless `force: true` is passed, with a refusal that names `cli-hierarchy clear <name>` as the next step. The CLI exposes `--force`.
- [ ] AC-3: Before `stopSessionWindow`, `restart()` for a `planner` target runs the equivalent of `cli-hierarchy handoff write --role planner --board-dir <board>` and records the path in the restart result; a failure to write is reported but does not block the restart. The same for `operator-dispatch` where a handoff role exists.
- [ ] AC-4: `cli-hierarchy status` shows, per session, the pending rotate request and its age so the operator can see a rotation that is waiting on a long turn.
- [ ] AC-5: Tests for AC-1 to AC-3 in the existing `dispatch-loop.test.ts` and `restart` test files; `docs/operations/cli-hierarchy.md` describes the order: module rotation at the turn boundary, dispatch rotate request, hard restart as last resort, and the handoff written in every path.

## Notes

Origin: operator question 2026-11-01 ~22:30Z after the planner restart ("shouldn't the planner be able to finish its active work and write a handoff before terminating"). Evidence: `.ai-sdlc/dispatch/restart-locks/ai-sdlc-planner.json` holder `ai-sdlc-operator-dispatch` at 22:23:25.965Z; new planner `startedAt` 22:23:26.503Z; the killed command's transcript shows exit 137 inside the pre-push patch-coverage gate. Related: the planner starts at roughly 90k tokens of fixed context, which leaves 60k of working room before the 150k threshold; reducing the starting load is RFC-0053's scope and is tracked separately.
