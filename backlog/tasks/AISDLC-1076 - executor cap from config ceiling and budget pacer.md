---
id: AISDLC-1076
title: 'executor cap is min of executors.max and the budget pacer allowance'
status: In Progress
assignee: []
created_date: '2026-10-23'
labels:
  - pipeline-cli
  - hierarchy
  - token-cost
priority: high
dispatchable: true
dependencies: 
  - AISDLC-1074
  - AISDLC-1072
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/up.ts
  - docs/operations/cli-hierarchy.md
  - spec/rfcs/RFC-0059-ephemeral-executors.md
rfc: RFC-0059
---

## Description

Compute the spawn cap as `min(executors.max, budget pacer allowance)` per RFC-0059, reading the weekly utilization line from AISDLC-1072 (it may not be on main when this is picked up; the dependency stays). Add the `executors.max` config key and print BUDGET and cap lines in `status`. The cap never drops below one while the pacer allows any work.

**Five-step review (requirements first).** Requirement questioned: is a static ceiling enough? No, the week is the constraint. Deletion: the fixed pool size as the only limit. Simplification: one min of two numbers. Acceleration: the cap reacts on every tick. Automation last: no operator action to throttle at the end of the week.

## Acceptance Criteria

- [ ] The tick never spawns above `min(executors.max, allowance)`, proven by a unit test with a stubbed pacer.
- [ ] `status` prints BUDGET and cap lines.
- [ ] `executors.max` is a documented config key with a default.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
