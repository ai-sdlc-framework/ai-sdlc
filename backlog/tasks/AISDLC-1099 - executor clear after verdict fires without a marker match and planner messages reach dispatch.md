---
id: AISDLC-1099
title: 'hierarchy: an executor is cleared after its verdict whatever its last line says, a rotate request is honoured by an idle executor, dispatch waits across ticks for the acknowledgement, and planner messages to dispatch are submitted rather than left as pasted text'
status: In Progress
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
priority: high
dispatchable: true
dependencies: []
references:
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/hierarchy/brief-notify.ts
  - pipeline-cli/src/hierarchy/send.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Observed 2026-10-28, second drain stall of the day. All five executors reported a verdict between 16:45Z and 16:59Z (alpha, beta, gamma, delta, epsilon), then sat idle for more than 40 minutes with 87 eligible tasks queued and 0 inflight. Each pane ended with a reply of the shape "... [executor] verdict reported" followed by one more sentence ("The hierarchy hooks module or the dispatch session will clear this context next."). Dispatch's module sent each of them the message `rotate`; every executor answered that it cannot clear itself and kept waiting. No `rotate-request-<name>.json` existed under `.ai-sdlc/dispatch/handoff/` at 17:40Z. The dispatch module itself kept ticking (gh calls at 17:36Z).

Four causes, all in the hierarchy module and CLI:

1. **Self-clear marker is a suffix match.** The executor module's turn-complete hook calls `rotate()` only when the reply satisfies `reply.trimEnd().endsWith('[executor] verdict reported')` (`ai-sdlc-plugin/hooks/hierarchy/executor.ts`, the marker constant and the turn-complete check). The model routinely adds a sentence after the marker, so the check fails and `active` stays true until the 30 min stale timer.
2. **A `rotate` message to an idle executor does nothing.** On receipt, when `taskRunning(state)` is still true the module only sets `pendingRotate`, which is read at the next turn completion. An idle executor has no next turn, so the flag is never consumed.
3. **Dispatch's clear cannot be acknowledged inside the tick that issued it.** `clearExecutor` (`pipeline-cli/src/hierarchy/clear.ts`) writes `handoff/rotate-request-<name>.json` and waits up to 30 s for it to disappear, but the file is consumed only by the next dispatch tick, and `state.ticking` stops a tick from starting while one runs (`ai-sdlc-plugin/hooks/hierarchy/dispatch.ts`). A clear issued from `runDispatchTick` (`pipeline-cli/src/hierarchy/dispatch-loop.ts`) therefore always reports "not acknowledged". Executor status lines (`<name>: <task> <outcome> ...`) are classified as unclassified rather than `verdict`, so they do not trigger the immediate tick either.
4. **Planner messages to dispatch are pasted, not submitted.** `createTmuxBriefSender` (`pipeline-cli/src/hierarchy/brief-notify.ts`) runs `tmux send-keys -l -- <text>` immediately followed by `send-keys Enter`, with no delay and no check. Claude Code treats the burst as a paste ("[Pasted text #1]") and the Enter becomes part of it. The planner's 17:21Z rulings and the 17:24Z brief notification sat unsubmitted in the dispatch prompt until a human pressed Enter at 17:38Z. `cli-hierarchy send` to a roster name uses the same sender (`pipeline-cli/src/hierarchy/send.ts`). Executors are messaged through `$.session.send`, which is why their messages arrive as proper "Message from" entries.

## Fix

**Five-step review (requirements first).** The requirement questioned is "the executor decides when it is done by printing a marker as its last line": a model-written reply is not a protocol surface, and the board already holds the truth (a verdict file written by this executor for its claimed task). Deleted: the marker suffix check as the trigger (the marker line may stay as a human-readable cue) and the 30 s in-tick acknowledgement wait, which can never succeed. Simplified: one rule, "a verdict on the board from this executor means clear it", applied in both the executor's own hook and dispatch's tick; one delivery path for messages to dispatch (`$.session.send`, as executors already get), so the tmux paste path is used only when no session socket exists. Accelerated: the executor clears itself at the turn in which the verdict file appears, so no dispatch round trip is on the critical path. Automated: a `cli-hierarchy status` warning line "idle with verdict reported for N min" so a stall is visible on the first check, and a test for each cause below.

1. `executor.ts`: the turn-complete hook clears when a verdict file for the executor's claimed task exists in `done/` or `failed/` (board truth), independent of the reply text. On a `rotate` message while idle (no claim, or verdict present), act at once instead of setting `pendingRotate`.
2. `clear.ts` and `dispatch.ts`: `clearExecutor` returns after writing the request; acknowledgement is checked on the following tick and reported then (a request older than one tick interval with the executor still active is retried once, then escalated). Classify an executor line of the form `<name>: <task-id> <outcome>` as a verdict so it triggers the immediate tick.
3. `brief-notify.ts` and `send.ts`: deliver to the dispatch session through the hierarchy session socket when the roster has one, and only fall back to tmux; in the tmux fallback send the text, wait for the prompt to settle (a short delay), then send Enter, and verify by capturing the pane that the prompt is empty, retrying Enter once.
4. `cli-hierarchy status`: an executor idle with its own verdict on the board and no inflight claim shows a warning with the elapsed time.
5. Tests: (a) reply ends with prose after the marker, verdict file present → clear fires; (b) `rotate` received while idle → clear fires at once; (c) a clear issued inside a tick is acknowledged on the next tick, not reported as failed; (d) status line `alpha: AISDLC-1 failed ...` classifies as verdict; (e) tmux sender orders text, delay, Enter and verifies the prompt; (f) status prints the idle-with-verdict warning.
6. `docs/operations/cli-hierarchy.md`: describe the board-truth clear rule and the dispatch message path.

## Acceptance Criteria

- [ ] An executor whose verdict file exists is cleared at its next turn completion whatever its last reply line is.
- [ ] A `rotate` message to an idle executor results in a clear within one tick.
- [ ] A clear started from a dispatch tick is reported acknowledged on the next tick when the executor restarted; no "not acknowledged" from the issuing tick.
- [ ] A planner `cli-hierarchy send` or `brief --notify` to the dispatch session is submitted and answered without a human pressing Enter.
- [ ] `cli-hierarchy status` warns on an executor idle with a reported verdict for more than one tick.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
