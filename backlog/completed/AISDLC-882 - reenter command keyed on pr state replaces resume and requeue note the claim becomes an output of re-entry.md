---
id: AISDLC-882
title: 'feat(dispatch): reenter <pr|task> keyed on PR state replaces resume and requeue --note; the claim becomes an output of re-entry, not a precondition'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [rfc-0054, phase-2, dispatch]
dependencies: [AISDLC-829]
references:
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - pipeline-cli/src/dispatch/requeue.ts
  - pipeline-cli/src/cli/dispatch.ts
  - pipeline-cli/src/hierarchy/stall.ts
  - docs/operations/parallel-dispatch.md
priority: high
dispatchable: true
---

## Context

RFC-0054 OQ-4 (resolved 2026-10-14): task PRs re-enter by one command keyed on PR state. Today re-entry is a flag on a claim: a manifest goes to the queue, an executor claims it, Step 3 must honour `resume`. The 2026-10-11 handoff records a dozen decision records (DEC-0111 to DEC-0122) of one class, "resume cannot reach the existing branch", and the planner's note "no sanctioned route to an idle executor's worktree". AISDLC-762.1 and 807 wired resume through that path; the class recurred. AISDLC-863 (push-only resume binds to the verdict patch-id) and 868 (`remove-verdict` leaves the manifest in `failed/`) are edges of the same coupling and are closed by this task.

## Fix

**Five-step review (requirements first).** Requirement questioned: "re-entry needs a claim first". No: the claim is what an executor needs to work; it is the output of deciding that an executor is needed. Deleted: `cli-dispatch resume`, `requeue --note`, and the `resume` flag's special handling in the claim path; the `remove-verdict` + `write-manifest` re-enqueue procedure (DEC-0187). Simplified: one verb, one key. Accelerated: a red PR becomes a queued manifest in one command with no planner decision. Automated last: the state machine calls `reenter` as its `full-fix-resume-with-failing-line` and semantic-conflict actions.

1. `cli-dispatch reenter <pr-number|task-id> [--note <text>]`: resolves the PR, reads the `landing/` record and classifies (AISDLC-829's classifier); if the action is a machine action, runs it and exits; if it needs an executor (real red on the current head, semantic conflict), writes one queue manifest carrying `branch`, `prNumber`, `prHeadRef`, `headSha`, the failing check line and the note, and moves any `failed/` verdict and manifest for the task aside into `landing/<pr>/history/`. The claim is created by the normal executor claim; Step 3 reuses the branch named in the manifest (never guesses).
2. Delete `cli-dispatch resume` and `requeue --note`; `cli-dispatch requeue` stays for PR-less failures only. Update `operator-dispatch.md`, `executor.md` and `docs/operations/parallel-dispatch.md`.
3. `stall.ts` calls `reenter` with the step note instead of its own requeue.
4. AISDLC-863 and 868 are closed by this change; their task files move to `backlog/completed/` in this PR with a note pointing here.

## Acceptance Criteria

- [ ] `reenter <pr>` on a PR whose head has a real test failure writes exactly one queue manifest naming the branch, head SHA and failing line; an executor that claims it works on that branch (Step 3 reuses, test asserts no new branch created).
- [ ] `reenter <pr>` on a BEHIND PR with a mechanical conflict runs the machine action and writes no manifest.
- [ ] `reenter` on a task with a `failed/` verdict moves it to `landing/<pr>/history/`; `failed/` holds no manifest for that task afterwards.
- [ ] `cli-dispatch resume` and `requeue --note` no longer exist; the command docs and the two command bodies are updated.
- [ ] A loop test: re-entering the same `(pr, headSha)` twice without a new head is refused with the loop-guard message (AISDLC-883).

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check`; `npx backlog-drift check`.

## Out of scope

The loop guard itself (AISDLC-883); the land-prep runner (AISDLC-881).

## Final Summary

Shipped: `cli-dispatch reenter <pr|task-id> [--note]` in `pipeline-cli/src/hierarchy/reenter.ts`; `resume` and `requeue --note` removed; stall.ts calls it with the step note when a PR exists; same-head loop guard in `landing/<pr>/reentered.json`.
