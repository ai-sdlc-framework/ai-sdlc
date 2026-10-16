---
id: AISDLC-946
title: 'Failed executor work is re-claimable by the normal loop: resume finds a completed task file and a push-only refusal falls through to a full resume'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - dispatch
  - bug
dependencies: []
references:
  - pipeline-cli/src/next-step/init.ts
  - pipeline-cli/src/steps/01-validate.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

Three times on 2026-10-16 an executor finished a rebase or a fix locally in its worktree, could not push it, and left the work orphaned: no agent path could pick it up and the operator had to run the lease push by hand. The chain each time:

1. The developer moves the task file to `backlog/completed/` on the branch (normal Done semantics).
2. The executor's next attempt stops with `no task file for <id>`. Validation already accepts a completed file on resume, yet the executor still reached this error with the file present in both the worktree's and the parent's `backlog/completed/`, so some resume entry point does not pass `resume: true` or does not fall through to the worktree lookup. The exact entry point is to be established from the executor transcript (worker gamma, PR 1662, 18:43Z).
3. `push-only-check` refuses with `content changed after rebase` and the executor stops instead of running a normal resume (review round, sign, lease push).
4. `reenter` refuses with the loop guard because the head cannot move without the push; it offers no way forward except an escalation.
5. The lease-push hook correctly refuses dispatch and planner sessions, so only an executor can push, and no executor can claim the task.

**Five-step review (requirements first).**
1. Requirement questioned: must an orphaned local rebase be pushed by an agent at all? Yes: the PR stays DIRTY otherwise and the only alternative is a hand push by the operator, which is the failure being removed.
2. Delete: the `push-only-check` early stop. A refusal means "run a normal resume", which is what its exit code already says; the executor must not treat it as terminal.
3. Simplify: one resume path. Every executor entry (`next-step` init, the MCP step tools, `reenter --note`) resolves the task file with `resume: true` when a worktree or a known branch exists, so a completed file is never a stop.
4. Accelerate: `reenter` on an unchanged PR head with local unpushed commits in the worktree routes to the executor with a "push pending" note instead of the loop-guard refusal; the guard keys on the local HEAD when it differs from the PR head.
5. Automate: tests for each entry point with the task file only in `backlog/completed/`, a test that a push-only refusal continues as a full resume, and a reenter test with the local HEAD ahead of the PR head.

Velocity impact: positive; removes the only remaining hand step in the drain seen today (PR 1662 twice, PR 1677 once).

## Acceptance Criteria

- [ ] AC-1: Every executor resume entry point (next-step init, MCP step 1 tool, reenter) accepts a task file found only in `backlog/completed/` of the worktree or the parent when prior work exists; the `no task file` reason is reserved for first runs.
- [ ] AC-2: A `push-only-check` refusal (exit 1) continues into a normal resume in the same executor run; it is never recorded as a failure on its own.
- [ ] AC-3: `reenter` with the worktree HEAD ahead of the PR head is not blocked by the loop guard; it routes to the executor with a note that the local commits must be reviewed, signed and lease-pushed.
- [ ] AC-4: Unit tests cover AC-1 for each entry point, AC-2 and AC-3.
- [ ] AC-5: `docs/operations/cli-hierarchy.md` documents that failed executor work is re-claimed by the normal loop and that no session other than an executor pushes.

## Notes

Origin: planner ruling 2026-10-16 18:55Z after the operator pushed PR 1662 by hand. The failed verdict notes for the worker are in the board's `landing/1662/history/` and `failed/` records.
