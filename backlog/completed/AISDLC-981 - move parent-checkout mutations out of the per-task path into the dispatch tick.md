---
id: AISDLC-981
title: 'Move parent-checkout mutations out of the per-task path into the dispatch tick'
status: Done
assignee: []
created_date: '2026-10-20'
labels:
  - hierarchy
dependencies: []
references:
  - pipeline-cli/src/steps/00-5-sync-parent.ts
  - scripts/check-orchestrator-state.sh
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/next-step/init.ts
priority: medium
dispatchable: true
---

## Description

`pipeline-cli/src/next-step/init.ts:63-88` runs, for every task an executor starts: Step 0 (`check-orchestrator-state.sh`, which on a clean parent does `git checkout main` and `git reset --hard origin/main` at `scripts/check-orchestrator-state.sh:100-104`), the merged-worktree sweep (`sweepMergedWorktrees`, which calls gh to find merged PRs), Step 0.5 (`syncParentUntrackedFiles` in `pipeline-cli/src/steps/00-5-sync-parent.ts:319` onward, which deletes untracked files identical to main at `:328-329` and may open a sync PR) and Step 0.5b (`pruneStaleParentDebris`). Three executors share one parent checkout and one gh quota, so these mutations run concurrently against the same working tree: one executor resets the parent while another lists its untracked files, and each tick multiplies the gh calls by the executor count.

Fix: the dispatch tick owns the parent. The sweep, the orchestrator-state recovery and the untracked-file sync run once per tick from the dispatch session (the reconciler in `pipeline-cli/src/hierarchy/reconcile.ts` already owns the gh reads for open PRs and can feed the sweep its merged set), and the execute path's Step 0 only asserts the parent state (clean, on main, at or behind origin/main) and refuses with the reason when it is not, pointing at the dispatch tick as the repair. A single-session run without dispatch (an operator running `/ai-sdlc execute` by hand) keeps a flag to run the mutations inline.

**Five-step review (requirements first).**
1. Requirement questioned: does every task need to heal the parent? No; the parent changes once per landed PR, so once per tick is enough.
2. Delete: the per-task sweep and sync calls from `initTask`.
3. Simplify: one owner of parent mutations (dispatch), one assertion in the execute path.
4. Accelerate: gh calls for the sweep drop from one per task start to one per tick; no concurrent reset races.
5. Automate: the dispatch tick already runs on a timer; the sweep and sync join it.

## Acceptance Criteria

- [ ] `initTask` no longer mutates the parent checkout; it asserts clean-on-main and returns a refusal naming the dispatch tick when the assertion fails.
- [ ] The dispatch tick runs orchestrator-state recovery, the merged-worktree sweep and the untracked-file sync once per tick, reusing the reconciler's PR snapshot for the merged set.
- [ ] A flag (or the absence of a hierarchy session env) lets a standalone `/ai-sdlc execute` run the mutations inline, documented in `docs/operations/cli-hierarchy.md`.
- [ ] Tests cover the assertion path, the standalone path and the once-per-tick path.
