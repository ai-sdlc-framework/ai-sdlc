---
id: AISDLC-830
title: >-
  Lease-push hook honours DEC-0088: planner filing branches are updated in place, never re-filed
status: In Progress
assignee: []
created_date: '2026-10-13'
labels:
  - hierarchy
  - velocity
  - root-cause
dependencies: []
references:
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - pipeline-cli/src/hierarchy/lease-preflight.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (operator, 2026-10-13 02:40Z).** Two PRs for AISDLC-823 were closed unmerged today (#1434, #1437) and a third opened (#1451), because the planner could not update its own filing branch: `git push --force-with-lease origin HEAD:refs/heads/ai-sdlc/file-823b` from `.worktrees/file-823b` is refused `not-task-worktree` with `hierarchy-env: found AI_SDLC_HIERARCHY_ROLE=planner; expected executor`. DEC-0088 (2026-10-10, on main) decided that the planner may lease-push its own `ai-sdlc/file-*` filing branches; the hook was never taught that, so the recorded workaround became "re-file on a new branch and ask the operator to close the old PR". Operator: "every closed PR means wasted work."

**Five-step review (requirements first).** Delete: the re-file workaround and the memory rule that recorded it (step 2).
1. Requirement questioned: "a lease push is allowed only from a dispatched task worktree bound to one executor claim" (AISDLC-798 hook predicate, set by the planner for executors). Correct for executors; it never considered the planner's own filing branches, which DEC-0088 had already allowed.
2. Delete: the re-file workaround; the planner never opens a replacement PR for a branch it can update.
3. Simplify: one additional accepted shape in the lease-push predicate: session role `planner` (from the hierarchy launch env), cwd is a worktree under `<repo>/.worktrees/file-*`, the branch being pushed is `ai-sdlc/file-*` and equals the worktree's checked-out branch, destination is the explicit `HEAD:refs/heads/<that branch>`; never main/master, never a task branch. Same refusal text otherwise.
4. Accelerate: a filing PR that goes red or conflicting is fixed with one push instead of a close plus a new PR plus a new CI run.
5. Automate: none.

**Velocity impact.** Positive: removes one wasted PR per filing-PR rebase and the operator's close chore.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 From a `.worktrees/file-<x>` worktree in a session with `AI_SDLC_HIERARCHY_ROLE=planner`, `git push --force-with-lease origin HEAD:refs/heads/ai-sdlc/file-<x>` is accepted; hermetic test in the hook suite and in `lease-preflight` tests
- [ ] #2 The same command is still refused when the branch is not `ai-sdlc/file-*`, when it does not match the worktree's branch, when the destination is main/master, or when the role is executor (executor rules unchanged)
- [ ] #3 `cli-hierarchy lease-preflight` (or the existing preflight surface) reports the planner shape as one of the accepted shapes in its output
- [ ] #4 `docs/operations/decision-authority.md` or the lease-push section of CLAUDE.md states the planner filing-branch shape and cites DEC-0088
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `node --test ai-sdlc-plugin/hooks/ && pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`
