---
id: AISDLC-1228
title: reenter and the pane-exit requeue tolerate a plain queue manifest beside an iterate-needed verdict
status: Done
priority: high
labels: [bug, hierarchy, dispatch]
dependencies: []
dispatchable: true
---

## Problem

Observed 2026-11-07 on AISDLC-707 / PR #2508. The board holds both `done/AISDLC-707.verdict.json` (outcome `iterate-needed`, 08:12Z) and `queue/AISDLC-707.dispatch.json`, which is the original plain manifest (dispatchedAt 04:53Z, `workerId` still set, no `resume` block). An iterate-needed verdict leaves the executor's claim in `inflight/` on purpose: `resumeDone` (`pipeline-cli/src/dispatch/resume.ts`) takes that manifest over for the next round. The executor pane then exited and the AISDLC-1217 pane-exit requeue moved the claim back to `queue/` as a plain manifest, which no command anticipated.

Every sanctioned route now refuses, and they refuse in a cycle:

- `cli-dispatch reenter 2508 --note ...`: `AISDLC-707 is already in queue/` (resume.ts, the queue/inflight/blocked scan; only the inflight seat is exempt for an iterate-needed claim).
- `cli-dispatch dequeue --task-id AISDLC-707`: `has a verdict in done/; use reenter or remove-verdict instead` (board.ts `retireQueued`).
- `cli-dispatch remove-verdict --task-id AISDLC-707` would clear the only record that makes the task resumable, so the next `reenter` refuses with `is not in done/; only a finished task can be resumed`.

The reconciler's own `reenter` action hit the first refusal twice on the unchanged head and parked the PR under the AISDLC-1125 loop guard. The PR then waits for a human, and a plain manifest beside a finished verdict also counts as a new task under the open-PR cap, so the tick never claims it either.

## Fix

**Five-step review (requirements first).**
1. Question: the dequeue guard keeps a finished task from being un-finished silently; the resume scan keeps a task from holding two manifests. Both requirements stand. Neither anticipated the plain requeued claim beside an iterate-needed verdict, and the pane-exit requeue should not have produced it.
2. Delete: nothing.
3. Simplify: `resumeDone` treats a plain queue manifest (no `resume` block) for a task whose `done/` verdict is `iterate-needed` exactly as it treats the inflight claim: park it, write the resume manifest in its place, archive the plain one with the verdict under `landing/<pr>/history/`. The AISDLC-1217 pane-exit requeue skips a claim whose task has an iterate-needed verdict in `done/`; that claim is the parked seat for the next round, not lost work, and `reenter` is the only thing that should move it.
4. Accelerate: the `dequeue` refusal names the real route when the queue entry is plain and the verdict is iterate-needed (`use reenter; it replaces the stale entry`), so the dispatch session does not loop between the two commands again.
5. Automate last: nothing new; the tick already runs `reenter` as a reconciler action.

## Acceptance Criteria

- [x] #1 Test: `resumeDone` with an iterate-needed verdict in `done/` and a plain manifest in `queue/` succeeds, returns the new queue path, and the plain manifest and verdict are archived under the landing history directory.
- [x] #2 Test: `resumeDone` with a queue manifest that already carries a `resume` block still refuses with `already in queue/`.
- [x] #3 Test: the pane-exit requeue leaves an `inflight/` claim in place when `done/` holds an iterate-needed verdict for the task, and records why.
- [x] #4 Test: `cli-dispatch reenter <pr>` on the state in #1 returns a queue path; `cli-dispatch dequeue` on that state refuses with a message naming `reenter`.
- [x] #5 `docs/operations/cli-hierarchy.md` re-entry paragraph names the case in one sentence.

## Notes

The one-time clearance of the live AISDLC-707 state is recorded separately (DEC-0395, scope `task:AISDLC-707`); this task removes the need for such a clearance.

## Final Summary

## Summary
`resumeDone` now replaces a plain queue manifest that sits beside an iterate-needed verdict. It archives the old manifest and the verdict under the landing history directory. The pane-exit requeue leaves the `inflight/` claim in place and logs why. `dequeue` now checks `done/` before `inflight/`, so its refusal names `reenter`. The `cli-hierarchy.md` re-entry section names the case.

## Changes
- pipeline-cli/src/dispatch/resume.ts
- pipeline-cli/src/dispatch/resume.test.ts
- pipeline-cli/src/dispatch/board.ts
- pipeline-cli/src/hierarchy/pane-exit.ts
- pipeline-cli/src/hierarchy/pane-exit.test.ts
- docs/operations/cli-hierarchy.md
- backlog/tasks/AISDLC-1228 - reenter and the pane-exit requeue tolerate a plain queue manifest beside an iterate-needed verdict.md

## Design decisions
The first commit message was rejected for header length, so the commit subject is shorter than the task template. The task file's status moved to In Progress and was folded into the commit. The pre-push patch-coverage gate passed at 100% (36 of 36 patch lines).

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

