---
id: AISDLC-1209
title: Budget-pressure priority floor in the pacer; delete RFC-0010 s14 quota modules
status: Done
assignee: []
created_date: '2026-11-06'
labels:
  - rfc-0062
  - phase-1
  - pacer
  - dark code
dependencies: []
references:
  - spec/rfcs/RFC-0062-algorithm-improvement-directions.md
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
  - pipeline-cli/src/hierarchy/budget.ts
  - .ai-sdlc/dark-code-baseline.json
priority: high
dispatchable: true
drift_log:
  - date: '2026-11-06'
    type: ref-deleted
    detail: 'Referenced file no longer exists: orchestrator/src/dispatch/worker-pool.ts'
    resolution: flagged
  - date: '2026-11-06'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      orchestrator/src/scheduling/schedule-decision.ts
    resolution: flagged
  - date: '2026-11-06'
    type: ref-deleted
    detail: 'Referenced file no longer exists: orchestrator/src/scheduling/ledger.ts'
    resolution: flagged
drift_checked: '2026-11-06'
---

## Description

**Source.** RFC-0062 OQ-1 (DEC-0385, 2026-11-06). Affected surface: `pipeline-cli/src/hierarchy/budget.ts` (the pacer that prints the `BUDGET` line and computes `EXECUTOR CAP`), and the RFC-0010 §14 modules `orchestrator/src/dispatch/worker-pool.ts`, `orchestrator/src/scheduling/schedule-decision.ts` and the SubscriptionLedger in `orchestrator/src/scheduling/ledger.ts` plus their barrel exports.

The three modules implement quota-aware scheduling but have no production caller; the pacer is the live quota control and is priority-blind: when the budget line projects past 100% before the window resets, the cap throttles every task equally, including the critical path.

## Fix

**Five-step review (requirements first).**
1. *Question the requirement.* Quota-aware ordering is wanted; a second quota source is not.
2. *Delete.* `worker-pool.ts`, `schedule-decision.ts`, the SubscriptionLedger and `burn-down.ts` if nothing else imports it; their tests; their barrel exports; their entries in `.ai-sdlc/dark-code-baseline.json` (the baseline only shrinks).
3. *Simplify.* One rule in the pacer: while `projected100At` is before the window reset, claims are limited to tasks whose priority is at or above `budget.priorityFloor` (`none | high | critical`, default `none` for one release); the status line shows `FLOOR high (budget pressure)` while active.
4. *Accelerate.* None.
5. *Automate.* Tests for the floor engaging and releasing around the projection; a dark-code check that the deleted modules are gone from the baseline.

## Acceptance Criteria
- [x] #1 With `budget.priorityFloor: high` and a projection past 100% before reset, `cli-dispatch` claims no medium or low task; when the projection recovers, claims resume (test drives the pacer with a fixed clock).
- [x] #2 Default `none` reproduces today's behaviour byte for byte in the status line apart from the new `FLOOR` field.
- [x] #3 The three modules, their tests and barrel exports are removed; `pnpm dark-code:check` passes with a smaller baseline; no token import is added anywhere.
- [x] #4 `docs/operations/cli-hierarchy.md` documents the key; RFC-0010 §14 already carries the pointer from the walkthrough PR.

## Final Summary

## Summary
Added a `budget.priorityFloor` setting (none, high or medium). When a budget window projects 100% before it resets, `cli-dispatch claim` and `peek --order` skip tasks ranked below the floor. Also deleted the unused RFC-0010 s14 quota modules (worker-pool, schedule-decision, the SubscriptionLedger and burn-down), their tests and their barrel exports. The `BUDGET` status line gains a trailing `FLOOR` field, and the key is documented in `docs/operations/cli-hierarchy.md`.

## Changes
- pipeline-cli/src/hierarchy/budget.ts
- pipeline-cli/src/hierarchy/budget.test.ts
- pipeline-cli/src/dispatch/board.ts
- pipeline-cli/src/dispatch/board-budget-floor.test.ts
- docs/operations/cli-hierarchy.md
- orchestrator/src/index.ts
- orchestrator/src/dispatch/index.ts
- orchestrator/src/dispatch/dispatch.test.ts
- orchestrator/src/dispatch/worker-pool.ts
- orchestrator/src/scheduling/index.ts
- orchestrator/src/scheduling/ledger.ts
- orchestrator/src/scheduling/schedule-decision.ts
- orchestrator/src/scheduling/burn-down.ts
- orchestrator/src/scheduling/scheduling.test.ts
- orchestrator/src/scheduling/coverage-gaps.test.ts
- scripts/clock-baseline.json

## Design decisions
The branch already held the implementation from an earlier run. This run rebased it onto origin/main, re-ran build, lint, format:check, dark-code:check and the full test suites (all green), pushed, and opened the draft PR. `.ai-sdlc/dark-code-baseline.json` is unchanged: the deleted modules were not in it, so the baseline did not shrink, and `dark-code:check` still reports OK. Removing `burn-down.ts` is beyond the three named modules, but it only served the ledger. No token import was added.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

