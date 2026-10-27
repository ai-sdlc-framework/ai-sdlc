---
id: AISDLC-1074
title: 'dispatch tick spawns per eligible claim up to the cap and downs on verdict'
status: In Progress
assignee: []
created_date: '2026-10-23'
labels:
  - pipeline-cli
  - hierarchy
priority: critical
dispatchable: true
dependencies: 
  - AISDLC-1073
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/down.ts
  - pipeline-cli/src/hierarchy/roster.ts
  - spec/rfcs/RFC-0059-ephemeral-executors.md
rfc: RFC-0059
---

## Description

Wire the dispatch tick per RFC-0059: after recording verdicts, run `cli-hierarchy down --role <name>` for the executor of every task whose verdict is in `done/` or `failed/` and remove its roster entry, then call spawn for each eligible claim up to the cap. Add a sweep that downs any executor still alive 5 minutes after its verdict. A crashed executor (no heartbeat for 10 minutes) is downed and its manifest requeued by the existing stall path.

**Five-step review (requirements first).** Requirement questioned: must the model end the session? No, dispatch owns it. Deletion: reliance on the executor's final turn. Simplification: reuse the stall path for crashes instead of a new one. Acceleration: down in the same tick as the verdict. Automation last: the sweep catches every miss without a human.

## Acceptance Criteria

- [ ] The tick that records a verdict downs that task's executor and removes its roster entry, proven by a unit test over the dispatch loop.
- [ ] An executor alive 5 minutes after its verdict is downed by the sweep.
- [ ] An executor with no heartbeat for 10 minutes is downed and its manifest requeued.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
