---
id: AISDLC-990.1
title: 'Autonomy tracker reads the AutonomyPolicy and rejects an initial level above 1'
status: Done
assignee: []
created_date: '2026-10-21'
labels:
  - orchestrator
  - autonomy
dependencies: []
references:
  - orchestrator/src/autonomy-tracker.ts
  - orchestrator/src/autonomy-tracker.test.ts
  - spec/autonomy.md
  - spec/schemas/autonomy-policy.schema.json
priority: medium
dispatchable: true
---

## Description

`spec/autonomy.md:116-117` says an agent MUST NOT be initialised at level 2 or 3, and an implementation MUST enforce it by rejecting an AutonomyPolicy whose initial level is above 1. `orchestrator/src/autonomy-tracker.ts` caps promotion at level 3 (the parent task) but never reads an AutonomyPolicy resource, so there is nothing to reject: the only entry point is the tracker's own state, and a caller can seed it at any level. This is the AC4 gap the parent task's PR body names.

Fix: the tracker takes the policy (validated against `spec/schemas/autonomy-policy.schema.json`) at construction or on `load`, and refuses one whose initial level is 2 or 3 with an error that names the agent, the level and the spec line. Promotion and demotion keep working from the policy's `promotionCriteria` and `demotionTriggers` as they do today.

Out of scope: where the policy file lives on disk and how the orchestrator discovers it; a follow-up if that discovery does not exist yet.

**Five-step review (requirements first).**
1. Requirement questioned: is the spec rule enforceable in the tracker at all? Yes, once the tracker sees the policy, which is the only input that carries the initial level.
2. Delete: nothing; the cap at 3 stays.
3. Simplify: one validation at the point the policy enters the tracker, no per-call checks.
4. Accelerate: a bad policy fails at load, not after a promotion cycle.
5. Automate: the schema validation and the level check run in the same step, so no reviewer checks the initial level by eye.

## Acceptance Criteria

- [ ] The tracker accepts an AutonomyPolicy and rejects an initial level of 2 or 3 with an error naming the agent and the level.
- [ ] Initial levels 0 and 1 are accepted; promotion from them still caps at 3.
- [ ] Tests in `orchestrator/src/autonomy-tracker.test.ts` cover rejection at 2 and 3 and acceptance at 0 and 1.
- [ ] `spec/autonomy.md:116-117` is cited in the error message or a comment next to the check.
