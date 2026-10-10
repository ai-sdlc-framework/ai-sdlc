---
id: AISDLC-651.4
title: >-
  RFC-0050 follow-up: per-role context and turn budgets, Stop-hook over-budget notice, turns-since-clear and growth-per-turn in cli-usage context
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - rfc-0050
  - rfc-0051
  - usage-ledger
  - plugin
  - hooks
dependencies:
  - AISDLC-651
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - ai-sdlc-plugin/plugin.json
  - pipeline-cli/src/usage/report.ts
  - ai-sdlc-plugin/commands/planner.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-approved on 2026-10-02 as part of turning the token-usage findings into
process: a practice holds when it is measured, nudged at the moment it matters, and
defaulted by the tooling. The usual conventions apply (strict TypeScript, ESM, hermetic
tests; plugin hooks under `node --test`; no writes under `.ai-sdlc/` by the developer
agent; no edits to RFC Open Questions).

Main sessions are 60 percent of cache-read tokens on the operator machine: median 420
turns per session at 444k tokens of context per turn. The unit of work is one RFC or
one brief for the planner, one brief for the dispatch session, one task for an
executor; a session that outlives its unit re-reads everything on every turn. This task
makes the budget visible in the session where it matters.

## Scope
1. **Budgets in config**: `roles.<role>.contextBudgetTokens` and `roles.<role>.turnBudget`
   in the usage config (defaults: planner 150000 / 300, operator-dispatch 100000 / 200,
   executor 120000 / 150), with the role resolved from the hierarchy roster or the
   session name.
2. **`Stop` hook notice**: a new hook script registered beside the existing `Stop`
   entry in `ai-sdlc-plugin/plugin.json` reads the current session's own transcript
   tail (its path is in the hook input), takes the last call's context size from its
   usage block and the turns since the last `SessionStart` with matcher `clear`, and
   when either exceeds the role budget returns a one-line notice the model sees on its
   next turn: context size, budget, turns since clear, and "finish this unit and
   `/clear`". Below budget it returns nothing. It never blocks and completes within
   the hook time limit on a 1,000-turn transcript.
3. **Report**: `cli-usage context` gains `turnsSinceClear` and `overBudget` per session
   and lists the ten largest single-turn context growths per session
   (`cache_creation_input_tokens` per call) with the tool that produced each.
4. **Status line**: document in the usage runbook how to colour the context segment
   against the role budget (the status-line input carries `session_name`, the roster
   gives the role).
5. **Planner skill**: `ai-sdlc-plugin/commands/planner.md` states the unit of work
   and the hand-off-then-clear rule in one line.

## Acceptance Criteria
- [ ] With a fixture transcript over the role's context budget, the `Stop` hook returns the one-line notice; under budget it returns nothing; it never exits non-zero.
- [ ] Turns since clear are counted from the last `SessionStart` with matcher `clear`, not from session start (fixture with one clear).
- [ ] The hook completes within the configured limit on a 1,000-turn fixture transcript.
- [ ] `cli-usage context` prints `turnsSinceClear`, `overBudget` and the ten largest growths with tool names for a fixture ledger.
- [ ] Budgets are read from the usage config with the documented defaults when absent.
- [ ] The planner skill carries the unit-of-work and hand-off-then-clear line.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
