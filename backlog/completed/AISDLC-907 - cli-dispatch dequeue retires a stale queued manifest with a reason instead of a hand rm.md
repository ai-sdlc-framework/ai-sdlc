---
id: AISDLC-907
title: 'fix: cli-dispatch dequeue retires a stale queued manifest with a reason, so dispatch never removes a queue file by hand'
status: In Progress
assignee: []
created_date: '2026-10-14'
labels: [bug, pipeline-cli, dispatch]
dependencies: []
references: [pipeline-cli/src/cli/dispatch.ts, pipeline-cli/src/dispatch/board.ts, pipeline-cli/src/cli/dispatch.test.ts]
priority: high
dispatchable: true
---

## Description

A queued, unclaimed manifest has no sanctioned correction path. Reported by the ai-sdlc-io dispatch session (plugin 0.28.0): `queue/<id>.dispatch.json` named a branch that no longer existed (the PR head had been renamed to the long `ai-sdlc/<id>-<slug>` form). `cli-dispatch release --task-id <id> --force` returned `{"released":false}` because the task was in `queue/`, not `inflight/`. `cli-dispatch write-manifest --json new.json` threw `dispatch.writeManifest: queue/<id>.dispatch.json already exists; release inflight before re-emitting` (`pipeline-cli/src/dispatch/board.ts`). `requeue` only moves `failed/` to `queue/`. The only way out was `rm` on the queue file outside the CLI, which bypasses the board guard and leaves no record of why the manifest was dropped. The same shape appears in this repository whenever a manifest branch field is short-form and the worktree branch is long-form (the fix-manifest decisions of 2026-10-15 rewrote two manifests by hand).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that `write-manifest` refuses to overwrite an existing queue entry. The refusal protects a claimed or inflight task from a second emission; it is set by the board guard (AISDLC-800 invariants). It is right for inflight entries and wrong for an unclaimed queue entry the dispatcher itself wants to correct. 2. Deleted: the hand `rm` step in the dispatch runbook; nothing is deleted from the CLI. 3. Simplified: one new subcommand `cli-dispatch dequeue --task-id <id> --reason <text>` that moves `queue/<id>.dispatch.json` to `retired/<id>.<ts>.dispatch.json` with the reason appended to the manifest's `releaseHistory`, and refuses when the task is inflight, has a claim, or has a verdict in `done/`. No `--replace` flag on `write-manifest`: a move with a reason keeps the audit trail that an overwrite loses. 4. Accelerated: a stale queue entry is corrected in two CLI calls (`dequeue` then `write-manifest`) instead of a hand edit plus a decision record. 5. Automated: a board-invariant check lists `retired/` entries whose task also has a `queue/` or `inflight/` entry (should be none); `cli-dispatch peek` counts `retired`.

## Acceptance Criteria

- [ ] `cli-dispatch dequeue --task-id <id> --reason <text>` moves the queue manifest to `retired/` with the reason recorded; `--reason` is required.
- [ ] `dequeue` refuses with a named cause when the task is inflight, has a claim, or has a `done/` verdict; the queue file is untouched.
- [ ] `write-manifest --json` succeeds for a task whose previous manifest was dequeued.
- [ ] The dispatch CLI header comment in `pipeline-cli/src/cli/dispatch.ts` and `docs/operations/cli-hierarchy.md` document the subcommand and the two-call correction procedure.
- [ ] Tests in `pipeline-cli/src/cli/dispatch.test.ts` cover the move, the three refusals and the `peek` count.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

The stale-branch cause itself (short-form manifest branch vs long-form worktree branch) is out of scope here; this task only gives dispatch a recorded way to correct the manifest. `requeue --note` already exists on main and needs no change.
