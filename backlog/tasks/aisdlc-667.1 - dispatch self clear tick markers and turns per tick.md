---
id: AISDLC-667.1
title: >-
  RFC-0051 follow-up: dispatch session clears itself after a brief, records tick markers, and files a Decision when turns per tick exceed budget
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - rfc-0051
  - dispatch
  - usage-ledger
  - plugin
dependencies:
  - AISDLC-667
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/orchestrator/events.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-approved on 2026-10-02 as part of turning the token-usage findings into
process: a practice holds when it is measured, nudged at the moment it matters, and
defaulted by the tooling. The usual conventions apply (strict TypeScript, ESM, hermetic
tests; plugin hooks under `node --test`; no writes under `.ai-sdlc/` by the developer
agent; no edits to RFC Open Questions).

RFC-0051 section 6 says the dispatch loop is mostly mechanical. This task makes that
measurable and gives the dispatch session the same context hygiene it enforces on
executors.

## Scope
1. **Self-clear**: when a brief completes (every manifest from it in `done/` or
   `failed/`), the dispatch loop records the completion, then sends `/clear` and
   `/ai-sdlc operator-dispatch` to its own pane through the same `cli-hierarchy clear`
   path used for executors (the roster has its pane). Refused while any inflight
   manifest is unreconciled.
2. **Tick markers**: each dispatch tick writes a `DispatchTick` marker (tick id, step
   list, start and end) to the orchestrator events so the usage ledger can bucket the
   dispatch session's calls per tick.
3. **Turns per tick**: `cli-usage scorecard` gains a row for `operator-dispatch` with
   turns per tick (median and p90) over a window, and the usage config gains
   `dispatch.turnsPerTickBudget` (default 5).
4. **Decision on overrun**: when the rolling median exceeds the budget over the last
   20 ticks, the loop files one operational Decision naming the step that consumed
   the most turns (the loop knows its step when each call is made), at most one open
   at a time. The Decision's options are to move the step into `cli-dispatch`, raise
   the budget, or accept.
5. **Rule in the skill body**: every step that touches files or git is a
   `cli-dispatch` or `cli-hierarchy` subcommand; the skill body is those commands plus
   the judgment calls.

## Acceptance Criteria
- [ ] A completed brief triggers exactly one self-clear through the injected runner; an unreconciled inflight manifest prevents it.
- [ ] Each tick emits a `DispatchTick` marker that validates against the events schema.
- [ ] The scorecard reports turns per tick from a fixture ledger and marker set, and the budget is read from config.
- [ ] A rolling median above budget files one Decision naming the costliest step; a second overrun while it is open files none.
- [ ] The skill body states the mechanical-steps rule.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
