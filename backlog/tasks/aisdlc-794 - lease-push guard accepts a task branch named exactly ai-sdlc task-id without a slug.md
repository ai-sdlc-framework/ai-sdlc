---
id: AISDLC-794
title: >-
  Lease-push guard accepts a task branch named exactly ai-sdlc/<task-id> (no slug suffix) as the task's own branch
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - governance
  - hooks
  - dec-0083
  - unblocker
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/lease-push-guard.js
  - ai-sdlc-plugin/hooks/lib/lease-push-guard.test.mjs
  - pipeline-cli/src/dispatch/resume.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two open PRs cannot be rebased and re-pushed by an executor: PR #1269 (AISDLC-704.5) on `ai-sdlc/aisdlc-704.5` and PR #1259 (AISDLC-752) on `ai-sdlc/aisdlc-752`. Both head branches carry the task id with no slug suffix. `ai-sdlc-plugin/hooks/lib/lease-push-guard.js` binds the "own branch" of a lease push to the prefix `ai-sdlc/<task-id>-` only (the comment at the check reads "pattern `ai-sdlc/{issueIdLower}-{slug}`"), so the executor's lease push of its rebased branch to `refs/heads/ai-sdlc/aisdlc-704.5` from the task worktree is refused with "branch 'ai-sdlc/aisdlc-704.5' is not this task's branch (ai-sdlc/aisdlc-704.5-*)". Dispatch (2026-10-10) parked both tasks in `failed/` as blocked rather than working around the hook.

DEC-0083 (planner, class a) rules that the exact name `ai-sdlc/<task-id>` is the task's own branch: no other task id can produce it, and `governance.allowForcePush: leaseOnOwnBranch` (AISDLC-710) already permits a lease push on the task's own branch, so this applies an existing decision and loosens nothing.

Change the ownership check so `own === 'ai-sdlc/<task-id>'` passes alongside `own.startsWith('ai-sdlc/<task-id>-')`. The comparison must stay exact on the id boundary: `ai-sdlc/aisdlc-704.5x`, `ai-sdlc/aisdlc-704.51` and `ai-sdlc/aisdlc-704` must still be refused for task `aisdlc-704.5`, as must any other task's branch. Every other refusal (sentinel, worktree-name match, short-name aliasing, protected branches, plain force, `+` refspecs) is unchanged. Update the refusal text to name both accepted forms. Check that the branch guess in `pipeline-cli/src/dispatch/resume.ts` (`branchGuessed`) still produces the exact-name form, so a resumed task whose verdict carried no `pushedBranch` lands on the branch the hook now accepts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] From a worktree named after the task with a valid `.active-task`, a lease push to `refs/heads/ai-sdlc/<task-id>` (exact) is allowed; to `refs/heads/ai-sdlc/<task-id>-<slug>` it is still allowed.
- [ ] `ai-sdlc/<task-id>x`, `ai-sdlc/<task-id>1`, a shorter id that is a prefix of the task id, and another task's branch are all still refused, with hermetic cases in `lease-push-guard.test.mjs` for each.
- [ ] The refusal message names both accepted forms (`ai-sdlc/<task-id>` or `ai-sdlc/<task-id>-*`).
- [ ] No other allowed or refused shape in `lease-push-guard.test.mjs`, `lease-push-guard-widened.test.mjs` or `governance-lease.test.mjs` changes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Unblocker for AISDLC-704.5 (#1269) and AISDLC-752 (#1259); dispatch requeues both once this lands. Decision: DEC-0083. The executor implementing this task works on a slugged branch, so it is not itself affected.
