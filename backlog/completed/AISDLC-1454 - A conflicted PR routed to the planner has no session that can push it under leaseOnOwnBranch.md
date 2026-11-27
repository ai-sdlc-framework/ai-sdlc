---
id: AISDLC-1454
title: "A conflicted PR routed to the planner has no session that can push it under leaseOnOwnBranch"
status: Done
priority: high
labels:
  - dispatch
  - reconciler
  - lease-push
  - adopter-facing
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/lease-preflight.ts
  - pipeline-cli/src/hierarchy/session-env.ts
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
---

## Description

**Five-step review (requirements first).**
1. Question: the requirement stands. Under `allowForcePush: leaseOnOwnBranch`, the adopter default (DEC-0264), only the executor in the task's own worktree may force-push, and that control stays. But when a conflicted PR is routed to the planner after its executor's claim is released, no session on the roster may push the rebased branch. The PR is then stuck, and only a human can unstick it.
   - Reported by ai-sdlc-enterprise on 0.46.0, PR #38 (ENT-19, head 13f85c41), 2026-11-27 (not checked here). The planner rebased and verified locally, with build, tests, lint and format check passing. The force-push hook (AISDLC-798) refused both `git -C <worktree> push` from the main checkout and a push run inside the worktree: "not-task-worktree … hierarchy-env: found AI_SDLC_HIERARCHY_ROLE=planner; expected … executor". The board showed 0 in flight, because the executor's claim had already been released.
   - Checked: the lease preflight accepts an executor task push, or a planner push only in the planner-filing shape (`.worktrees/file-<x>`, branch `ai-sdlc/file-<x>`, DEC-0088) (`lease-preflight.ts:134-140`). This repo runs `lease` mode, which is why the planner could push #3097 here.
2. Delete: no loosening of the lease control for the planner. That would be a weakening and would need its own operator decision.
3. Simplify: a conflicted PR goes back to an executor. When the reconciler routes a `behind-or-dirty` PR to the planner and no executor holds the claim, the task is re-enqueued for re-entry. An executor then claims it, rebases in its own worktree (or applies the planner's resolution, given as a note), and pushes under the existing control. The planner's role is to decide a semantic conflict, not to push.
4. Accelerate: the re-entry runs on the next claim, without a human push.
5. Automate: the route-to-planner record says how the PR will be pushed (re-entry queued, or "planner decision needed, then re-entry") and is never a dead end.

## Acceptance Criteria
- [x] #1 When a `behind-or-dirty` PR exhausts land-prep and no live executor holds its claim, the reconciler re-enqueues the task for re-entry (one manifest; the same priority as a resume) besides routing the PR to the planner. The landing record names the queued re-entry. Test: claim released, land-prep failed x2, one queued re-entry manifest, and the route record mentions it.
- [x] #2 A planner with a conflict resolution has a sanctioned way to hand it to that re-entry: a note or patch attached to the queued manifest that the executor applies in its worktree before pushing. It needs no push from the planner session. Test: a re-entry with a planner note applies the note and pushes from the executor worktree.
- [x] #3 The `leaseOnOwnBranch` hook behaviour is unchanged. A planner force-push to a task branch is still refused, and a test pins it.
- [x] #4 The planner session reference in `docs/operations/cli-hierarchy.md` says what to do with a routed conflicted PR under each `allowForcePush` mode.
- [x] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Notes
- Source: ai-sdlc-enterprise planner, 2026-11-27 (defect 2 of 2).
- AISDLC-1453 removes most of these routes, because land-prep works again. This task covers the routes that remain: real semantic conflicts and repeated rebase failures.

## Final Summary

## Summary

A conflicted behind-or-dirty PR whose land-prep failed twice and whose claim is released now goes back to an executor. The reconciler queues one re-entry for it, records it on the landing record, and names it in the planner route. The planner can hand a conflict resolution to that re-entry with the new `cli-dispatch reentry-note`, and never pushes the task branch. The leaseOnOwnBranch hook is unchanged and a new test pins that.

## Changes

- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/pipeline-cli/src/hierarchy/reconcile.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/pipeline-cli/src/hierarchy/reenter.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/pipeline-cli/src/hierarchy/reenter.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/pipeline-cli/src/dispatch/resume.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/pipeline-cli/src/dispatch/types.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/pipeline-cli/src/cli/dispatch.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/pipeline-cli/src/cli/dispatch.test.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/docs/operations/cli-hierarchy.md
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/spec/schemas/dispatch-manifest.v1.schema.json
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/reference/src/core/generated-schemas.ts
- /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-1454/backlog/tasks/AISDLC-1454 - A conflicted PR routed to the planner has no session that can push it under leaseOnOwnBranch.md

## Design decisions

Rebasing onto origin/main hit a conflict in pipeline-cli/src/cli/dispatch.ts. AISDLC-1453 (#3131) had moved the reenter handler into runReenter and an in-process reconciler runner. I resolved it by keeping main's refactor and adding the --executor-round flag inside runReenter. The in-process runner parses that flag generically, so the reconciler's queue-reentry action runs in process. Affected tests, build, lint and format passed after the rebase, and pre-push patch coverage was 152/152.

The full test suite passed before the rebase. After the rebase I re-ran only the affected tests, so the full suite has not run on the pushed commit.

AC3 hook test: the planner env sets AI_SDLC_ACTIVE_TASK_ID to empty, matching the reported planner session. The existing hook still allows a session explicitly bound to the task via that variable, whatever its role. That behaviour is unchanged and out of scope here.

The AC2 test checks that the planner note reaches the claimed executor's resume feedback along with the push-from-worktree instruction, and that the hook allows that executor's push. It is not an end-to-end run of the pipeline.

reentry-note allows the planner role in the caller check, but it still requires the repository's requeue grant. Under allowForcePush: never the docs say an operator push is still needed after the executor's rebase; that mode is unchanged.

## Verification

- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)

- 3 reviews approved (harness: code-reviewer=claude-code, test-reviewer=claude-code, security-reviewer=claude-code; harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up

- declined: no follow-up work surfaced beyond the acceptance criteria
