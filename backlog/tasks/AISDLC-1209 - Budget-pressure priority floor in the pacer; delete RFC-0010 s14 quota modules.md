---
id: AISDLC-1209
title: Budget-pressure priority floor in the pacer; delete RFC-0010 s14 quota modules
status: In Progress
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
- [ ] #1 With `budget.priorityFloor: high` and a projection past 100% before reset, `cli-dispatch` claims no medium or low task; when the projection recovers, claims resume (test drives the pacer with a fixed clock).
- [ ] #2 Default `none` reproduces today's behaviour byte for byte in the status line apart from the new `FLOOR` field.
- [ ] #3 The three modules, their tests and barrel exports are removed; `pnpm dark-code:check` passes with a smaller baseline; no token import is added anywhere.
- [ ] #4 `docs/operations/cli-hierarchy.md` documents the key; RFC-0010 §14 already carries the pointer from the walkthrough PR.
