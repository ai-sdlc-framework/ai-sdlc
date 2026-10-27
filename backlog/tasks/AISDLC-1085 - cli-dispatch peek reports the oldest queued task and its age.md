---
id: AISDLC-1085
title: 'cli-dispatch peek reports the oldest queued task and how long it has waited'
status: To Do
assignee: []
created_date: '2026-10-27'
labels:
  - pipeline-cli
  - dispatch
  - enhancement
  - demo
priority: low
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/cli/dispatch.ts
  - pipeline-cli/demo/scenarios/context-pressure.json
  - docs/operations/cli-hierarchy.md
---

## Description

`cli-dispatch peek` prints only counts: `{"queued":63,"inflight":1,"done":368,"failed":0}`. When the queue is long, the number nobody can read from it is how long the head of the queue has been waiting, which is the first thing the planner and the dispatch session ask when deciding whether the pool is starved or the brief is stale. The dispatched-at time is already in every queued manifest; nothing surfaces it.

This task is also the target of the ai-sdlc.io home-page demo clip: it is deliberately small, real and self-contained so a demo run can take it from request to merged pull request end to end. The demo scenario for it ships in this task under `pipeline-cli/demo/scenarios/queue-age.json`, so the clip can be regenerated from the repository later.

## Fix

**Five-step review (requirements first).** The requirement questioned is "the queue needs a dashboard": one more field in the existing JSON answers the question, so no new command. Nothing to delete. Simplified: `peekQueue` in `board.ts` returns two more fields, `oldestQueued` (`{ taskId, dispatchedAt, ageSeconds }`) or `null` when the queue is empty; the CLI prints whatever the function returns. Accelerated: reading the manifests it already lists, no extra I/O. Automated: a unit test over a board fixture with two queued manifests of different ages.

1. Extend `peekQueue` in `pipeline-cli/src/dispatch/board.ts`: among queued manifests pick the smallest `dispatchedAt`; return `oldestQueued: { taskId, dispatchedAt, ageSeconds }`, computed against an injectable `now` for tests; `null` on an empty queue.
2. `cli-dispatch peek` prints the extended object unchanged (JSON stays one line).
3. Add `pipeline-cli/demo/scenarios/queue-age.json` with this task's request and decisions (the scenario file in the sibling `context-pressure.json` is the format).
4. One line in the cli-hierarchy runbook's dispatch section naming the new field.

## Acceptance Criteria

- [ ] With two queued manifests dispatched at different times, `peekQueue` returns the older one's id, its `dispatchedAt` and a non-negative `ageSeconds` computed from the injected clock (unit test).
- [ ] With an empty queue the field is `null`, not absent (unit test).
- [ ] `cli-dispatch peek` output includes `oldestQueued` and remains valid single-line JSON.
- [ ] `pipeline-cli/demo/scenarios/queue-age.json` exists and matches the scenario schema used by `cli-hierarchy demo`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
