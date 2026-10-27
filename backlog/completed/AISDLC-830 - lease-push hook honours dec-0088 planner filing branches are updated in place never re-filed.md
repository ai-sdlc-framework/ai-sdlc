---
id: AISDLC-830
title: >-
  Lease-push hook honours DEC-0088: planner filing branches are updated in place, never re-filed
status: Done
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
- [x] #1 From a `.worktrees/file-<x>` worktree in a session with `AI_SDLC_HIERARCHY_ROLE=planner`, `git push --force-with-lease origin HEAD:refs/heads/ai-sdlc/file-<x>` is accepted; hermetic test in the hook suite and in `lease-preflight` tests
- [x] #2 The same command is still refused when the branch is not `ai-sdlc/file-*`, when it does not match the worktree's branch, when the destination is main/master, or when the role is executor (executor rules unchanged)
- [x] #3 `cli-hierarchy lease-preflight` (or the existing preflight surface) reports the planner shape as one of the accepted shapes in its output
- [x] #4 `docs/operations/decision-authority.md` or the lease-push section of CLAUDE.md states the planner filing-branch shape and cites DEC-0088
- [x] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `node --test ai-sdlc-plugin/hooks/ && pnpm --filter @ai-sdlc/pipeline-cli build && pnpm --filter @ai-sdlc/pipeline-cli test`
- `pnpm lint && pnpm format:check`

## Final Summary

## Summary
The lease-push predicate now accepts the planner filing-branch shape from DEC-0088. A session with role planner, in `.worktrees/file-&lt;x&gt;`, on branch exactly `ai-sdlc/file-&lt;x&gt;`, can lease-push it without a claim or `.active-task`. The preflight output names the accepted shape, and the docs cite DEC-0088.

## Changes
- ai-sdlc-plugin/hooks/enforce-blocked-actions.js
- ai-sdlc-plugin/hooks/lib/lease-push-guard.js
- ai-sdlc-plugin/hooks/lib/lease-push-guard.test.mjs
- ai-sdlc-plugin/hooks/lib/trusted-policy.js
- ai-sdlc-plugin/hooks/lib/trusted-policy.test.mjs
- pipeline-cli/src/hierarchy/lease-preflight.ts
- pipeline-cli/src/hierarchy/lease-preflight.test.ts
- docs/operations/decision-authority.md
- backlog/tasks/AISDLC-830 - lease-push hook honours dec-0088 planner filing branches are updated in place never re-filed.md

## Design decisions
Test command: `pnpm test`. In the full run the pipeline-cli summary was `Test Files 1 failed | 545 passed (546)` and `Tests 1 failed | 12143 passed | 13 skipped`. The one failure was the unrelated `review-staged/pipeline.test.ts` timeout listed in testWaiver. That failure stopped `pnpm test` before it ran any later packages in the workspace, so those did not run locally. The hook node tests I touched (`trusted-policy.test.mjs`, `lease-push-guard.test.mjs`) ran separately: 176 pass, 0 fail. Build, lint and format passed. The commit scope had to be `orchestrator` because commitlint rejected `hooks`. This repo runs in `lease` mode, so the new shape only changes behaviour for adopters on the `leaseOnOwnBranch` default. The task file's status change to In Progress is included in the commit.

## Verification
- `pnpm build` — passed
- `pnpm test` — waived
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

