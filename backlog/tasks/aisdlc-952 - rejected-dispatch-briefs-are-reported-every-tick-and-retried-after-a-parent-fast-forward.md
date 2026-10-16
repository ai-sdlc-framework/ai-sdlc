---
id: AISDLC-952
title: 'Rejected dispatch briefs are reported on every tick and retried after a parent fast-forward, instead of being silently skipped until their mtime changes'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - dispatch
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.test.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

`ingestBriefs` in `dispatch-loop.ts` catches an ingest error, records `state.rejected[file] = mtime` in `operator-dispatch.state.json` and pushes the error into `ingestErrors` of that one tick. Every later tick skips the file while its mtime is unchanged and says nothing. The error text is not persisted. On 2026-10-16 the briefs for AISDLC-946, AISDLC-949 and AISDLC-950 were written before the parent was fast-forwarded to the commits that held their task files, the first ingest threw, and the three tasks stayed off the board for over 30 minutes while the tick output looked like a no-op. The planner diagnosed "946 landed" from the silence; dispatch had to touch the brief by hand to clear the rejection.

**Five-step review (requirements first).**
1. Requirement questioned: should a brief that failed to ingest ever be forgotten? No: a brief is the unit of hand-off, so an unreadable brief is an open problem until it ingests or the planner withdraws it.
2. Delete: the mtime-only retry key. Nothing else to delete.
3. Simplify: the rejection record keeps `{ mtime, error, parentHead }`; the tick reports every still-rejected brief in `ingestErrors` on every tick (same shape, so the handoff and the status line show it), not only once.
4. Accelerate: a rejected brief is retried when its mtime changes OR the parent `HEAD` differs from the one recorded at rejection, so a parent fast-forward that brings the missing task file clears it on the next tick with no hand step.
5. Automate: `dispatch-loop.test.ts` cases for persisted error text, repeated reporting, retry on parent-head change, and no retry when neither changed.

Velocity impact: positive; a brief written ahead of the parent fast-forward queues itself as soon as the parent catches up.

## Acceptance Criteria

- [ ] AC-1: `state.rejected[file]` stores the mtime, the error message and the parent HEAD at rejection; the schema change is backward compatible with the existing number-only value.
- [ ] AC-2: Every tick lists each still-rejected brief in `ingestErrors` with its stored error, so `cli-hierarchy status` / handoff show it until it ingests.
- [ ] AC-3: A rejected brief is retried when its mtime changes or the parent HEAD differs from the recorded one; it is not retried otherwise.
- [ ] AC-4: Tests cover AC-1, AC-2 and AC-3; `docs/operations/cli-hierarchy.md` describes the rejection record and the two retry triggers.

## Notes

Origin: dispatch 2026-10-16 ~20:15Z, briefs tasks-aisdlc-946.md and tasks-aisdlc-949-plus-1.md silently rejected at 19:40Z.
