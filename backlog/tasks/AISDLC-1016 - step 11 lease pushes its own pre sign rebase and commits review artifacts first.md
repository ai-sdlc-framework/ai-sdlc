---
id: AISDLC-1016
title: >-
  Step 11 lease-pushes its own pre-sign rebase and commits review artifacts first, ending the push-non-fast-forward resume loop
status: In Progress
assignee: []
created_date: '2026-10-21'
labels:
  - pipeline
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/hierarchy/playbook.ts
  - pipeline-cli/src/execute-pipeline.ts
  - docs/operations/backlog-and-execution-reference.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (third recurrence on 2026-10-21).** Three tasks today (AISDLC-1007 twice, AISDLC-1009, AISDLC-967) reached Step 11 with every reviewer approving and then failed with `push-non-fast-forward`: the pre-sign rebase rewrote the branch, the remote still held the pre-rebase copy of the same patch, and Step 11 pushes without a lease. The dispatch playbook then tried its `rebase-push` rescue and refused with "the worktree has uncommitted changes", because the reviewer transcript leaves and review records written after the last commit were still unstaged. Each recurrence costs a failed verdict, a `cli-dispatch reenter` push-only resume, a second executor claim, and in two cases a hand lease push by the executor. Since DEC-0264 (AISDLC-1005, landed 2026-10-21) the repository policy is `allowForcePush: lease`, so the push Step 11 needs is sanctioned; the step predates the policy.

**Root cause.** Step 11 treats a non-fast-forward as foreign divergence and aborts, even when the remote head is the pre-rebase copy of the branch it just rebased itself. Separately, the review artifacts are written to the worktree after the sign commit, so every later rescue path sees a dirty tree.

**Five-step review (requirements first).**
1. Requirement questioned: "a non-fast-forward push always aborts". Narrowed to: it aborts only when the remote holds work the worktree does not (a foreign commit). The pre-rebase copy of the same patch is not foreign.
2. Delete: the executor and dispatch manual lease push and the push-only resume round trip for this cause.
3. Simplify: in Step 11, when the plain push is rejected non-fast-forward, compare the remote head to the local branch (same `patch-id` set, or remote head is an ancestor of the pre-rebase ref the step recorded); if so and the role policy is `allowForcePush: lease`, push once with `--force-with-lease=<branch>:<remote-head>` and continue. Otherwise keep the existing abort. Use the same policy reader the hook uses; no second policy source.
4. Accelerate: commit (or exclude from the dirty check) the review artifacts before any rebase in the pipeline so `rebase-push` and `drop-chores` in the playbook stop refusing on a tree that only holds attestation chores. Prefer committing them in the attestation chore commit that already exists.
5. Automate: unit tests for the Step 11 branch (same patch, foreign commit, policy `never`) and a playbook test that a worktree dirty only with attestation artifacts is not "uncommitted changes".

**Velocity impact.** Positive: removes one failed verdict and one extra executor claim per affected task (three today); no control loosened beyond DEC-0264, which already permits lease pushes from any session on non-protected branches.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Step 11, on a non-fast-forward rejection where the remote head is the pre-rebase copy of the same patch set and the role policy is `allowForcePush: lease`, pushes with `--force-with-lease` against the observed remote head and reports `pushed: true`
- [x] #2 Step 11 still aborts with `pushed: false` when the remote holds a commit not in the local patch set, or when the policy is `leaseOnOwnBranch` outside the task worktree or `never`
- [x] #3 Review transcript leaves and review records are committed (or part of the attestation chore commit) before the pre-sign rebase, so `git status --porcelain` is clean when Step 11 runs
- [x] #4 Playbook `rebase-push` and `drop-chores` no longer refuse a worktree whose only changes are attestation artifacts (test)
- [x] #5 `docs/operations/backlog-and-execution-reference.md` documents the lease push in Step 11 and the policy modes it honours
- [x] #6 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli test -- 11-push-and-pr playbook`
- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
