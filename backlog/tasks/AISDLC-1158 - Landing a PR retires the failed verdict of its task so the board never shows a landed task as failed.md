---
id: AISDLC-1158
title: 'Landing a PR retires the failed verdict of its task: mark-landed moves failed/<task>.verdict.json and manifest to done/ with the landing sha, so the board never shows a landed task as failed'
status: To Do
assignee: []
created_date: '2026-11-02'
labels:
  - hierarchy
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/status.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

AISDLC-1153 landed on main at 2026-11-02 15:59Z (#2282, b48d5a2e; `landing/2282.json` mark-landed 16:02Z) but `.ai-sdlc/dispatch/failed/AISDLC-1153.verdict.json` (15:36Z, cause `push-non-fast-forward`) and its manifest are still in `failed/`, so `cli-hierarchy status`, `brief-status` and the handoff all count 1153 as failed. The planner repaired the push by hand and dispatch landed the PR through the landing lane; nothing on that path touches the verdict that the executor wrote before the repair. The same shape follows every repair that lands a PR whose last verdict was `failed` (AISDLC-1136 #2246 yesterday).

**Five-step review (requirements first).**
1. Requirement questioned: is the verdict the executor wrote the task's final state? No. Landing is the only trigger for done (CLAUDE.md "Done semantics"); the verdict is a step record. The board's failed set must be derived from tasks that are not landed.
2. Delete: nothing; the failed verdict stays as history.
3. Simplify: when mark-landed records a PR for a task, it moves that task's `failed/` verdict and manifest to `done/` with a `landedSha` and `supersededCause` field, in the same tick. One place, no new state file.
4. Accelerate: the brief-status and handoff counts become right without a manual sweep.
5. Automate: a reconcile test lands a PR whose task has a failed verdict and asserts the move; a status test asserts the task counts as done.

Velocity impact: removes a manual sweep after every repaired landing and stops the handoff from listing landed tasks as failed.

## Acceptance Criteria

- [ ] AC-1: In the mark-landed path (`reconcile.ts`), when the landed PR maps to a task with a verdict in `failed/`, the verdict and manifest move to `done/` with `landedSha`, `landedAt` and `supersededCause` added; the original failed verdict content is preserved inside the done record.
- [ ] AC-2: `cli-hierarchy status`, `brief-status` and `handoff write` count that task as done; a test covers each.
- [ ] AC-3: A one-off sweep subcommand or flag (`cli-dispatch retire-landed`) applies the same move to existing stale entries (AISDLC-1153 and AISDLC-1136 today); it is idempotent and reports what it moved.
- [ ] AC-4: Docs: `docs/operations/cli-hierarchy.md` board section states that landing retires a failed verdict.

## Notes

Origin: dispatch session report 2026-11-02 ~17:20Z, item "related stale state"; planner chose a separate task so AISDLC-1157 (webhook health) stays single-purpose. Related: AISDLC-1156 (failed-verdict terminal states) covers the open-PR case; this task covers the landed case.
