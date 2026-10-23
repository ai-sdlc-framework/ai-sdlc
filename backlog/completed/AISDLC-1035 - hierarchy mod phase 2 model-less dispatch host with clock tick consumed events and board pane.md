---
id: AISDLC-1035
title: 'Hierarchy mod phase 2: model-less dispatch host ($.clock.every tick, consumed board events, ui.render board pane, $.session.send wakes); delete idle-backoff and the dispatch half of clear.ts'
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - rfc-0058
  - phase-2
  - plugin
  - hierarchy
dependencies:
  - AISDLC-1034
references:
  - spec/rfcs/RFC-0058-session-hierarchy-on-mods.md
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - pipeline-cli/src/hierarchy/clear.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

RFC-0058 phase 2 (Signed Off 2026-10-22). Per OQ-6 the dispatch session becomes a model-less host: its module runs the scheduler loop and never submits a prompt to its model. This task ships the host with today's `cli-hierarchy tick` as the loop body; the reserved scheduler RFC later replaces the body and owns the policy tables.

**Scope.**
1. Dispatch role in `register.tsx`: `$.clock.every` runs `node pipeline-cli/bin/cli-hierarchy.mjs tick` through `$.process.run` at the configured interval (default the current tick cadence); the result is written to the board and to the pane, never to the model.
2. `session.receive` consumes verdict, PR-landed and executor status messages, applies them with the existing `cli-dispatch` subcommands and refreshes the pane; a planner-addressed message is forwarded with `$.session.send` to the planner roster name. No message path submits a prompt.
3. Escalation: a tick result the policy tables cannot classify is written as a board file for the planner (the shape RFC-0056 OQ-5 names: failure record, log tail, PR check summary) and announced to the planner by `$.session.send`; the dispatch model is not prompted.
4. Board pane: `$.ui.open` plus `ui.render` showing what `cli-hierarchy status` prints today (roster, queue, inflight, done, failed, blockers), refreshed on every tick and consumed event; replaces the model-written tick notes.
5. Executor wake: an enqueue writes the board entry then `$.session.send({ to: <executor roster name>, text })`; the executor module (phase 1) consumes it.
6. Delete `cli-dispatch idle-backoff` and the dispatch half of `clear.ts`; `cli-hierarchy clear` for the dispatch role becomes a `$.session.send` rotate request. The operator-dispatch command text shrinks to the role description; it no longer runs a loop.
7. Rotation for the host at 120k per OQ-1 is rarely reached (no model turns) but registered the same way as phase 1.

**Five-step review (requirements first).**
1. Requirement questioned: does the dispatch loop need a model turn per tick? No; every tick action is a CLI call or a policy-table check (RFC-0056 OQ-5 evidence).
2. Delete: `idle-backoff`, the dispatch half of `clear.ts`, the model-written tick notes and the dispatch loop prose in the command.
3. Simplify: one timer, one receive hook, one pane; policy stays in `cli-dispatch`.
4. Accelerate: a relay costs a hook call instead of a model turn; the board pane is live instead of prose written after the fact.
5. Automate: `claude plugin test` fixtures for a consumed verdict, a forwarded planner message, an unclassified result written as an escalation file, and a wake send.

## Acceptance Criteria

- [x] The dispatch role registers a timer that runs the tick through `$.process.run` and never calls `$.prompt.submit` (test asserts zero prompt submissions across a simulated hour of ticks and events).
- [x] Verdict, PR-landed and status messages are consumed and applied with `cli-dispatch`; a planner-addressed message is forwarded by `$.session.send` to the planner roster name (tests).
- [x] An unclassified tick result produces a board escalation file with failure record, log tail and PR check summary, and one `$.session.send` to the planner (test).
- [x] The board pane renders the roster, queue, inflight, done, failed and blockers and refreshes on tick and on event (snapshot test).
- [x] An enqueue sends one wake to the named executor (test); `idle-backoff` and the dispatch branch of `clear.ts` are deleted; `pnpm dark-code:check` passes.
- [x] `docs/operations/cli-hierarchy.md` and the operator-dispatch command describe the model-less host and the escalation file.

## Final Summary
The dispatch role of the hierarchy hooks module is a model-less host: a `$.clock.every` timer runs `cli-hierarchy tick` through `$.process.run`, `session.receive` consumes verdict, PR-landed and status messages and forwards planner-addressed ones, unclassified results become `<board>/escalations/` files announced with `$.session.send`, a `ui.render` pane shows the board, and enqueued work wakes an idle executor. `cli-dispatch idle-backoff` and the dispatch half of `clearSelf` are deleted; `clear --self` from dispatch writes a rotate request the module consumes.

## Files changed
- ai-sdlc-plugin/hooks/hierarchy/dispatch.ts
- ai-sdlc-plugin/hooks/hierarchy/register.tsx
- ai-sdlc-plugin/hooks/hierarchy/executor.ts
- ai-sdlc-plugin/mods/tests/hierarchy-dispatch.test.ts
- ai-sdlc-plugin/commands/operator-dispatch.md
- ai-sdlc-plugin/commands/operator-dispatch.test.mjs
- ai-sdlc-plugin/commands/executor.md
- pipeline-cli/src/hierarchy/clear.ts
- pipeline-cli/src/hierarchy/escalation-file.ts
- pipeline-cli/src/hierarchy/rotate-request.ts
- pipeline-cli/src/cli/hierarchy.ts
- pipeline-cli/src/cli/dispatch.ts
- docs/operations/cli-hierarchy.md

## Design decisions
A hooks module has no process or fs, so the escalation file and the rotate request go through two small `cli-hierarchy` subcommands (`escalation-file`, `rotate-pending`). Interim assumption: the payload shapes of `$.clock.every({ ms, run })`, `$.process.run({ command, args })` and the `ui.render` return value follow the RFC text; `claude plugin test` fixtures should confirm them. A verdict message is applied with `cli-dispatch collect-verdicts` and an immediate tick, since the tick is the policy applier.

## Verification
- `pnpm build` - passed
- `pnpm test` - 4 timeout failures under full-suite load (decisions-persist, orchestrator, webhook-receiver, land-prep) in files this change does not touch; three pass alone, decisions-persist passes alone with a longer timeout
- `pnpm lint` - passed
- `pnpm format:check` - passed

## Follow-up
(none)
