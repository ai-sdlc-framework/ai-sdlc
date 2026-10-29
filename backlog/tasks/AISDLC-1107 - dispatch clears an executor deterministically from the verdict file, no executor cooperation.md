---
id: AISDLC-1107
title: >-
  Executor clear after verdict is owned by dispatch and driven by the verdict
  file: tmux /clear + resume from the dispatch tick, no marker line, no rotate
  handshake, no executor-side module
status: In Progress
assignee: []
created_date: '2026-10-28'
labels:
  - hierarchy
  - dispatch
  - stability
dependencies: []
references:
  - pipeline-cli/src/hierarchy/clear.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/restart.ts
  - ai-sdlc-plugin/hooks/hierarchy/executor.ts
  - ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
drift_log:
  - date: '2026-10-29'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      pipeline-cli/src/hierarchy/rotate-request.ts
    resolution: flagged
drift_checked: '2026-10-29'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An executor that has written its verdict must be cleared and re-armed before it can claim again. Today that depends on four things working in sequence, three of them inside the executor's own Claude Code process: (1) the model prints the exact marker line `[executor] verdict reported` as the last line of its reply (`ai-sdlc-plugin/hooks/hierarchy/executor.ts`, `VERDICT_MARKER`); (2) the executor's hooks module is loaded, at the right version, and sees that marker in `turn.complete`, or sees a `rotate` chat message delivered by dispatch through `session.receive`; (3) its `session.measure` payload carries a token count the module can read (AISDLC-1100 found it never did); (4) dispatch's module ticks and removes the request file, which `cli-hierarchy clear` reads as the acknowledgement (`pipeline-cli/src/hierarchy/clear.ts`). Every one of those links failed on 2026-10-28: executors sat "idle after verdict" for over an hour, three of them answered a rotate request with prose ("I can't clear my own context"), and the operator had to type the restarts by hand three times in one day.

The executor's cooperation is not needed. The verdict file under `done/` or `failed/` is already the deterministic proof that the task ended, and dispatch already owns the executor's tmux pane (that is how `restart` and `down` work). The operator's direction (2026-10-29 00:10Z): clearing an executor is dispatch's responsibility and must be deterministic code, not a probabilistic prompt.

**Five-step review (requirements first).** Requirement questioned: "an executor must consent to its own clear so a task in flight is never interrupted". The verdict file is a stronger guarantee of "no task in flight" than a marker line the model may or may not print, so the consent requirement goes. Deleted: the marker-line detection, the `rotate` chat message, the rotate-request file and its acknowledgement handshake, and the executor-side `measuredTokens` rotation for the post-verdict case (the 120k over-threshold rotation mid-task stays, it is a different concern and is covered by AISDLC-1100). Simplified: one function in the dispatch tick, `clearExecutorAfterVerdict(name)`: when a verdict file exists for the task the roster says the executor holds, and the pane shows the prompt (idle), send `/clear` + Enter, wait for the fresh prompt, send `/ai-sdlc:executor` + Enter, mark the roster entry cleared; the same code path `restart` already uses to relaunch a pane. Accelerated: the clear happens on the tick that consumes the verdict, not after a 1500-second after-task wait or an operator message. Automated: no operator or planner nag is needed; `cli-hierarchy status` stops printing "idle after verdict" because the state cannot persist past one tick. If the pane does not reach a fresh prompt within the ceiling, the tick falls back to `restart <name>` (kill and relaunch), which also needs no cooperation.

Fix: implement the tick step in `dispatch-loop.ts` (or the dispatch hooks module where the tick lives), sharing the pane-driving primitives with `restart.ts`; make `cli-hierarchy clear <name>` call the same deterministic path instead of writing a rotate request; remove the rotate-request file protocol and the `rotate` message handling in `executor.ts`, keeping the over-threshold rotation; delete `VERDICT_MARKER`/`IDLE_MARKER` detection once nothing reads it (the executor command may keep printing the line for humans); update `docs/operations/cli-hierarchy.md` and the `executor` command prose. AISDLC-1099 (landed) and AISDLC-1100 (open) touch the same files: the developer rebases over 1100 if it lands first, otherwise notes in the PR body which part of 1100 this supersedes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] A verdict file appearing for an executor's task causes the next dispatch tick to send `/clear` then the executor command to that pane, with no message to the executor model and no request file (test in the dispatch tick test with a fake pane driver asserting the key sequence).
- [ ] If the pane does not show a fresh prompt within the ceiling, the tick calls the restart path instead (test).
- [ ] `cli-hierarchy clear <name>` drives the pane directly and reports success without any acknowledgement handshake (test); the rotate-request file protocol is removed.
- [ ] `cli-hierarchy status` never reports "idle after verdict" for an executor whose verdict is older than one tick interval (test).
- [ ] The executor-side over-threshold rotation (120k mid-task) is unchanged (existing tests green).
- [ ] `docs/operations/cli-hierarchy.md` describes the clear as a dispatch-owned deterministic step and names the fallback.
- [ ] `pnpm build`, `pnpm test`, `pnpm lint`, `pnpm format:check` pass; the task file records the test command and its summary line.

## Notes

Evidence: `cli-hierarchy status` 2026-10-28 23:35Z listed all seven executors "idle after verdict ... not cleared" with the two dynamic ones idle for 1h8m; dispatch's clear at 23:50Z reported "rotate request not acknowledged: no hooks module consumed it" for alpha, gamma and epsilon; alpha's pane shows the rotate message reaching the model as chat, which replied that it cannot clear its own context. The operator typed restarts by hand at 20:45Z, 23:34Z and 23:55Z.

## Verification record

`pnpm build && pnpm test && pnpm lint && pnpm format:check` run on the branch. `pnpm test` summary line (pipeline-cli): `Tests 1 failed | 12216 passed | 13 skipped (12230)`; the single failure, `src/cli/orchestrator.test.ts > runs N ticks when --max-ticks is set` (30 s timeout under full-suite load), passes alone (`pnpm exec vitest run src/cli/orchestrator.test.ts`: 30 passed), and neither it nor its source is touched by this change. Hooks mod suite: 92 passed; plugin command suite: `node --test ai-sdlc-plugin/commands/*.test.mjs` 394 passed.
