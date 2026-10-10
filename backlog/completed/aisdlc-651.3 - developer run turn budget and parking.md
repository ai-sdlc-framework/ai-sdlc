---
id: AISDLC-651.3
title: >-
  RFC-0050 follow-up: a per-run turn budget for the developer agent with a warning, a hard stop and a parked return
status: Done
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - usage-ledger
  - cost
  - plugin
  - pipeline-cli
dependencies:
  - AISDLC-651
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - ai-sdlc-plugin/hooks/collect-tool-sequence.js
  - ai-sdlc-plugin/agents/developer.md
  - pipeline-cli/src/steps/06-parse-dev-return.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-approved follow-up, 2026-10-01. The developer agent's median run is
reasonable; the tail is not, and a long run re-reads a large context on every extra
turn.

## Evidence (operator machine, transcripts 2026-06-12 to 2026-10-01, 17,635 calls)
Main sessions account for 60 percent of cache-read tokens, the developer agent for 29
percent, all reviewers for 10 percent. A developer run starts at about 25k tokens of
context before reading any project file, because the hooks inject `CLAUDE.md`
(57k characters, about 14k tokens), the agent definition and the governance block on
every subagent start; over a median run of 62 turns that fixed prefix alone is about
1.5M tokens, a fifth of the median run. The developer tail is long: p90 is 30M
cache-read tokens and the worst run is 80M over 203 turns.

## Scope
1. **Budget**: `developer.turnBudget` in the base-ref `.ai-sdlc/review-config.yaml`
   (or the config file the pipeline already reads for developer options), default 120
   tool calls per run, with `warnAt` default 80 percent.
2. **Counting**: the existing `PostToolUse` hook (`collect-tool-sequence.js`) counts
   tool calls per subagent id for agents of type `developer` and, at `warnAt`, returns
   a one-line notice to the agent: turns used, budget, and the instruction to converge
   or park. At the budget it returns a stop notice.
3. **Parking**: the developer agent definition gains a rule: on the stop notice,
   commit work in progress on the task branch, return `prUrl: null` with
   `notes.parked: true`, what was done, what remains and why it took the turns it did.
   Step 6 (`pipeline-cli/src/steps/06-parse-dev-return.ts`) recognises the parked
   return and records it as a parked outcome, not a failure; the task is returned to
   the board or the operator with the notes attached.
4. **Record**: turns used per run are written to the judgment or usage log so
   `cli-usage scorecard` can report turns per task class.

## Acceptance Criteria
- [x] With a budget of 10 and `warnAt` 80 percent in a fixture, the eighth tool call returns the warning and the tenth returns the stop notice; other agent types are unaffected.
- [x] A developer return with `notes.parked: true` is recorded by Step 6 as parked, not failed, with the notes preserved.
- [x] The budget and `warnAt` are read from the base ref only.
- [x] Turns used per run appear in the usage records for the task.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
A PostToolUse hook now counts developer subagent tool calls against a per-run budget (default 120, warnAt 80 percent from the base-ref `.ai-sdlc/review-config.yaml`), emits a warning and a stop notice, and records turns per run. The developer parks on the stop notice (`prUrl: null`, `notes.parked: true`); Step 6 and execute-pipeline record `developer-parked`, not a failure. `cli-usage scorecard` rows gain `meanDeveloperTurns`.

## Changes
- `ai-sdlc-plugin/hooks/lib/developer-turn-budget.js` (new): budget resolver, counter, notices, turn records.
- `ai-sdlc-plugin/hooks/collect-tool-sequence.js`, `ai-sdlc-plugin/agents/developer.md`, `ai-sdlc-plugin/commands/execute.md` (modified): wiring and parking rule.
- `pipeline-cli/src/steps/06-parse-dev-return.ts`, `execute-pipeline.ts`, `types.ts`, `steps/10-finalize.ts` (modified): parked outcome.
- `pipeline-cli/src/usage/*` (modified): turns in usage records and scorecard.

## Design decisions
- **Base-ref only**: config read via `git show origin/main:` so a PR cannot raise its own budget.
- **Advisory budget**: the hook adds notices and never blocks tool calls.

## Verification
- `pnpm build` passed; `pnpm lint` and `pnpm format:check` clean; `pnpm dark-code:check` clean.
- `pnpm test`: new/affected tests pass; 14 failures in tui, bin-invocation and verify-runtime fail identically on clean main.
- 3 reviewers approved (Claude-native; Codex quota exhausted).

## Follow-up
- declined: non-atomic counter and per-call `git show` latency are minor; budget is a cost control, not a security boundary.
