---
id: AISDLC-1043
title: 'cli-dispatch block --task-id --reason: park a queued task without a manual file move (counterpart of unblock)'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - dispatch
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/bin/cli-dispatch.mjs
  - pipeline-cli/src/dispatch/board.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

The dispatch board has `cli-dispatch unblock --task-id <id>` but no `block`. When the planner rules that a queued task must not be claimed for a reason that is not a landed PR (today: a phase gated on a measurement table an operator still has to fill), the dispatch session has to move `queue/<id>.dispatch.json` to `blocked/` by hand and write the reason into the manifest itself. A manual file move is exactly the kind of unsanctioned path the governance rules say to replace with a command, and `unblock` has never been exercised against a manually parked manifest.

Add `cli-dispatch block --task-id <id> --reason <text>` in `pipeline-cli/bin/cli-dispatch.mjs` backed by the board module: it moves the manifest from `queue/` to `blocked/`, records `{ blockedAt, blockedBy, reason }` in the manifest, refuses a task that is inflight or done, and is idempotent on an already blocked task. `unblock` must accept the manifest `block` writes and return it to `queue/` with the dependency `after` list intact. Document both in `docs/operations/cli-hierarchy.md` next to `hold`.

**Five-step review (requirements first).** Requirement questioned: is a per-task park needed when `cli-hierarchy hold` exists? Yes: `hold` pauses every claim, and the case at hand parks one task while five others keep draining. Deletion: nothing to delete; the manual move procedure disappears from the dispatch notes. Simplified: one command, one manifest field, same folder the reconciler already reads. Accelerated: the planner's ruling becomes a one-line instruction the dispatch session runs in the same tick. Automated last: no automation; the planner still decides when to block and unblock.

## Acceptance Criteria

- [ ] `cli-dispatch block --task-id X --reason "..."` moves a queued manifest to `blocked/` with the reason recorded; refuses inflight and done tasks with a clear message.
- [ ] `cli-dispatch unblock --task-id X` returns it to `queue/` with `after` and `priority` unchanged; a Vitest test covers block then unblock round trip and the inflight refusal.
- [ ] `cli-hierarchy status` lists blocked tasks with their reason.
- [ ] `docs/operations/cli-hierarchy.md` documents `block` and `unblock` beside `hold`.
