---
id: AISDLC-1463
title: Delete the developer turn budget (AISDLC-651.3) and the Step 6 parked outcome
status: In Progress
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
- [ ] #1 `developer-turn-budget.js` and its test are gone; `git grep -niE "developer-turn-budget|developerTurnBudget|developer\.turnBudget|TURN BUDGET REACHED|developer-parked|developer-turns\.jsonl|developer-turn-state"` outside `backlog/completed`, CHANGELOG files and `.ai-sdlc/_decisions` returns nothing.
- [ ] #2 The PostToolUse hook `collect-tool-sequence.js` still records tool sequences as before for every agent type, and adds no `additionalContext` about turns; a `node --test` case covers a developer-agent tool event producing no turn notice.
- [ ] #3 Step 6 has no parked outcome; the parked types and next-step/execute-host handling are removed and the pipeline-cli tests pass.
- [ ] #4 The per-role context budget (AISDLC-651.4), hierarchy turn budget (AISDLC-667.1) and escalation-chain `parked` are unchanged (no diff in those files).
- [ ] #5 `pnpm dark-code:check` passes and `.ai-sdlc/dark-code-baseline.json` does not grow.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
