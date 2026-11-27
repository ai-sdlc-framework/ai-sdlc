---
id: AISDLC-1463
title: Delete the developer turn budget (AISDLC-651.3) and the Step 6 parked outcome
status: Done
priority: high
labels:
  - ai-sdlc-plugin
  - pipeline-cli
  - delete
dependencies: []
references:
  - ai-sdlc-plugin/hooks/collect-tool-sequence.js
  - ai-sdlc-plugin/agents/developer.md
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/steps/06-parse-dev-return.ts
  - pipeline-cli/src/types.ts
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/workflow/execute-host.ts
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/next-step/types.ts
  - pipeline-cli/src/next-step/gh-issue.ts
  - pipeline-cli/src/usage/scorecard-sources.ts
  - pipeline-cli/src/usage/scorecard.ts
  - pipeline-cli/src/steps/10-finalize.ts
  - backlog/completed/aisdlc-651.3 - developer run turn budget and parking.md
drift_log:
  - date: '2026-11-27'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/hooks/lib/developer-turn-budget.js
    resolution: flagged
  - date: '2026-11-27'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/hooks/developer-turn-budget.test.mjs
    resolution: flagged
  - date: '2026-11-27'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      pipeline-cli/test/fixtures/workflow/replay/developer-parked.json
    resolution: flagged
drift_checked: '2026-11-27'
---

## Description

**Five-step review (requirements first).**
1. Question: operator ruling 2026-11-27 (DEC-0446 a) after a planner audit triggered by AISDLC-1454 stalling: the executor obeyed a "TURN BUDGET REACHED ... STOP now" notice meant for its developer subagent. Audit findings: AISDLC-651.3 was agent-filed (PR #1148, `15034c274`) asserting "Operator-approved follow-up" with no quoted operator words; RFC-0050 asks for no turn cap; no decision record exists; `developer.turnBudget` is set nowhere. The 120 default (`developer-turn-budget.js:23`) has no derivation; developer runs since 2026-10-11 have median 20, p90 49, max 255 turns, and only 5 of 2,101 reached 120. No task has ever been parked by it. It is advisory (never blocks a tool call) and broken: `bumpCount` (`developer-turn-budget.js:106-114`) races under parallel tool calls and resets to 1; `resolveTaskId` returns null in 96% of records. Runaway runs stay bounded by the dev-run timeout (`hierarchy/system-runner.ts` `timeoutMs`, SIGKILL), the Step 9 iteration cap, the budget pacer and the usage scorecard.
2. Delete:
   - `ai-sdlc-plugin/hooks/lib/developer-turn-budget.js` and `ai-sdlc-plugin/hooks/developer-turn-budget.test.mjs`; the import (~line 16) and the turn-budget block (~lines 91-122) in `collect-tool-sequence.js`, keeping the rest of that hook intact.
   - The `### Turn budget and parking` section in `ai-sdlc-plugin/agents/developer.md` (~140-142) and the parked outcome in `ai-sdlc-plugin/commands/execute.md` (~101).
   - The parked outcome end to end: `06-parse-dev-return.ts` (~47-56, ~123-129), the parked types in `types.ts` (~230-231, ~400-413, ~462-466), `execute-pipeline.ts` (~447), `workflow/execute-host.ts` (~316), `next-step/next-step.ts` (~614), `next-step/types.ts` (~238), `next-step/gh-issue.ts` (~159), the `developer-parked.json` replay fixture and every test case for it. A developer return carrying `notes.parked` is then handled like any other return (no special branch).
   - Scorecard developer-turn fields fed by the hook log (`usage/scorecard-sources.ts` ~119-124, `usage/scorecard.ts` ~126 and ~287 `meanDeveloperTurns`) and any Step 10 use, unless they draw from a source other than `developer-turns.jsonl`; state which in the PR body.
   - Docs that describe the developer turn budget or `developer.turnBudget` (grep `docs/`, `ai-sdlc-plugin/`, `spec/`).
   - Out of scope, do NOT touch: the per-role `turnBudget` in `hooks/lib/context-budget.js` and `usage/usage-config.ts` (AISDLC-651.4), `hierarchy/turn-budget.ts` and `usage/dispatch-turns.ts` (AISDLC-667.1), and the `parked` concept in `decisions/escalation-chain.ts`.
3. Simplify: no replacement cap or counter. The hook stops writing `~/.ai-sdlc/usage/developer-turns.jsonl` and the `developer-turn-state/` files; existing files on disk are left alone (no migration).
4. Accelerate: none.
5. Automate: none.

## Acceptance Criteria
- [x] #1 `developer-turn-budget.js` and its test are gone; `git grep -niE "developer-turn-budget|developerTurnBudget|developer\.turnBudget|TURN BUDGET REACHED|developer-parked|developer-turns\.jsonl|developer-turn-state"` outside `backlog/completed`, CHANGELOG files and `.ai-sdlc/_decisions` returns nothing.
- [x] #2 The PostToolUse hook `collect-tool-sequence.js` still records tool sequences as before for every agent type, and adds no `additionalContext` about turns; a `node --test` case covers a developer-agent tool event producing no turn notice.
- [x] #3 Step 6 has no parked outcome; the parked types and next-step/execute-host handling are removed and the pipeline-cli tests pass.
- [x] #4 The per-role context budget (AISDLC-651.4), hierarchy turn budget (AISDLC-667.1) and escalation-chain `parked` are unchanged (no diff in those files).
- [x] #5 `pnpm dark-code:check` passes and `.ai-sdlc/dark-code-baseline.json` does not grow.
- [x] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary

Deleted the AISDLC-651.3 developer turn budget. The hook library and its test are gone, and collect-tool-sequence.js no longer counts turns, adds turn notices, or writes developer-turns.jsonl or developer-turn-state/. The Step 6 parked outcome is removed everywhere it appeared (parse-dev-return, types, execute-pipeline, execute-host, next-step, gh-issue, the replay fixture and its tests), as are the scorecard developer-turn fields, which were fed only by developer-turns.jsonl. The developer.md and execute.md docs no longer mention any of it.

## Changes

- ai-sdlc-plugin/agents/developer.md
- ai-sdlc-plugin/commands/execute.md
- ai-sdlc-plugin/commands/execute.test.mjs
- ai-sdlc-plugin/hooks/collect-tool-sequence.js
- ai-sdlc-plugin/hooks/collect-tool-sequence.test.mjs
- ai-sdlc-plugin/hooks/developer-turn-budget.test.mjs
- ai-sdlc-plugin/hooks/lib/developer-turn-budget.js
- backlog/tasks/AISDLC-1463 - delete the developer turn budget and the parked outcome.md
- pipeline-cli/src/execute-pipeline.test.ts
- pipeline-cli/src/execute-pipeline.ts
- pipeline-cli/src/next-step/gh-issue.ts
- pipeline-cli/src/next-step/next-step.test.ts
- pipeline-cli/src/next-step/next-step.ts
- pipeline-cli/src/next-step/types.ts
- pipeline-cli/src/steps/06-parse-dev-return.test.ts
- pipeline-cli/src/steps/06-parse-dev-return.ts
- pipeline-cli/src/types.ts
- pipeline-cli/src/usage/route-commands.ts
- pipeline-cli/src/usage/scorecard-commands.ts
- pipeline-cli/src/usage/scorecard-sources.ts
- pipeline-cli/src/usage/scorecard.test.ts
- pipeline-cli/src/usage/scorecard.ts
- pipeline-cli/src/workflow/execute-host.ts
- pipeline-cli/src/workflow/replay.test.ts
- pipeline-cli/test/fixtures/workflow/replay/developer-parked.json

## Design decisions

Two grep hits for the AC 1 pattern remain. (1) .ai-sdlc/reviews/aisdlc-762.jsonl is a historical review ledger on a blocked path that agents cannot edit. (2) The AISDLC-1463 task file's own description names the deleted items; the file moves to backlog/completed when the task lands. I ran backlog-drift fix on the task file to drop its references to the three deleted files; the committed file also carries the orchestrator's status change to In Progress. DeveloperReturn.notes is now typed string | Record<string, unknown> so an object notes value still renders through 10-finalize notesText. The replay fixture floor dropped from 29 to 28 because the developer-parked fixture was removed. The scorecard developer-turn fields came only from developer-turns.jsonl, and Step 10 never used them. pnpm dark-code:check passed and the baseline was not changed. The full pnpm test run passed before the rebase onto origin/main; the rebase applied cleanly and the pre-push hook passed.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 3 reviews approved (harness: code-reviewer=claude-code, test-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

(none)
