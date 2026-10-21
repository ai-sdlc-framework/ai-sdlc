---
id: AISDLC-762.2
title: >-
  next-step resume checks out the PR or manifest head branch instead of recomputing the slug branch
status: Done
assignee: []
created_date: '2026-10-11'
labels:
  - pipeline
  - hierarchy
  - fix
dependencies: []
references:
  - pipeline-cli/src/next-step/init.ts
  - pipeline-cli/src/steps/02-compute-branch.ts
  - pipeline-cli/src/steps/03-setup-worktree.ts
  - pipeline-cli/src/dispatch/resume.ts
  - pipeline-cli/src/dispatch/types.ts
priority: critical
dispatchable: true
---

## Description

Filed under the operator's 2026-10-11 PR-drain exception (a new PR is allowed only to fix an existing PR's error). AISDLC-651.2 (#1345) and every other bucket-A resume in brief `tasks-aisdlc-814-plus-27.md` fail at Step 3 with DEC-0128: next-step recomputes the slug branch (`ai-sdlc/aisdlc-651.2-rfc-0050-...`) while the PR, the worktree and the dispatch resume manifest all carry the branch actually pushed (`ai-sdlc/aisdlc-651.2`, the short form the lease-push guard accepts since AISDLC-794). AISDLC-762.1 taught Step 3 to resume an existing branch, but only the recomputed one, so a PR pushed under any other name is not found and the executor opens a DEC for a decided class (DEC-0113/0118/0121/0123/0128).

**Five-step review (requirements first).**
1. Requirement questioned: "the branch is whatever `computeBranchName` says" (Step 2, RFC-0012). True for a fresh task; for a resume the branch is a fact recorded in the PR and the manifest, and recomputing it is a second source of truth.
2. Delete: branch recomputation on the resume path.
3. Simplify: one rule — on a resume (`--pr <n>` given, or a dispatch manifest with a branch, or an existing worktree), the branch is read from, in order: the manifest's branch, the PR's `head.ref` (REST), the existing worktree's current branch. `computeBranchName` runs only for a fresh task.
4. Accelerate: no executor round and no DEC per resume.
5. Automate: nothing new; the resume path already exists.

Velocity impact: positive; removes a blocked round per bucket-A PR (about ten in the current drain).

## Acceptance Criteria

- [ ] AC-1: `initTask` on a resume uses the manifest branch, else the PR head ref, else the worktree's current branch; `computeBranchName` is not called on that path. Unit tests cover all three sources and the fresh path unchanged.
- [ ] AC-2: A worktree at `.worktrees/<task-id-lower>` whose checked-out branch differs from the recomputed slug is adopted as-is (no rename, no second worktree).
- [ ] AC-3: The resume log line names the branch and its source (`manifest` / `pr` / `worktree`).
- [ ] AC-4: `cli-dispatch resume --task-id <id> --pr <n>` records the PR head ref in the manifest so Step 3 needs no network call when the manifest is present.
- [ ] AC-5: Hermetic test reproducing DEC-0128: short-form branch `ai-sdlc/aisdlc-651.2` with a slug-named recomputation; resume succeeds.

## Notes

Parent: AISDLC-762 / 762.1. Related: AISDLC-794 (short-form branch accepted by the lease-push guard), AISDLC-807 (resume accepts iterate-needed/failed verdicts).
