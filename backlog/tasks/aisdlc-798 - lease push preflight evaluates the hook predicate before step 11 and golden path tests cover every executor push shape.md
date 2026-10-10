---
id: AISDLC-798
title: >-
  Lease-push preflight: the pipeline evaluates the hook's own predicate before Step 11 and names the failing condition; golden-path tests cover every executor push shape
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - governance
  - hooks
  - stability
  - velocity
  - root-cause
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/trusted-policy.js
  - ai-sdlc-plugin/hooks/lib/lease-push-guard.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/hierarchy/executor-start.ts
  - orchestrator/src/cli/commands/doctor-checks.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Incident (2026-10-10).** Executor lease pushes were refused `not-task-worktree` at least six times for four different reasons: a branch named `ai-sdlc/<id>` with no slug (AISDLC-794), a resumed worktree whose `.active-task` Step 13 had removed (AISDLC-794, second defect), executors launched without `AI_SDLC_HIERARCHY_SESSION`/`ROLE` (AISDLC-791), and claims with no `inflight/<task>.state.json` heartbeat because the heartbeat shorthand dispatch gave executors lacked `--task-id` and failed silently. Every refusal surfaced only at push time, after the rebase, reviews and signing were done, and each cost an executor context plus a planner ruling (DEC-0063, 0070, 0079, 0080, 0084).

**Root cause.** The hook's predicate (`resolveLeaseWorktree` + `lease-push-guard`) has five independent preconditions (env binding, worktree location, sentinel/dirname/branch agreement, board claim, heartbeat) that nothing checks before the push, and no test exercises the predicate end to end for the shapes executors actually use (fresh task, resumed task with completed task file, main-rooted session with claim and heartbeat).

**Five-step review (requirements first).** The dumb requirement is the fifth precondition: a main-rooted executor must prove a board claim through a heartbeat file before the hook lets it lease-push its own branch. Worktree directory name + sentinel + branch name already bind the push to exactly one task; the claim-and-heartbeat clause was added for sessions rooted at the main checkout and produced four of today's six refusals by itself. Delete first: drop the claim/heartbeat clause and the env-binding clause from the lease decision and bind ONLY on worktree-under-`.worktrees/` + directory name == task id + branch is that task's own (`ai-sdlc/<id>` or `ai-sdlc/<id>-*`), sentinel optional-but-must-agree. That is a governance loosening and needs an operator decision (class b, DEC-pending); if refused, keep the clause and implement the preflight below. Either way the single pure predicate and the golden-path tests stay, because they are what makes the remaining requirement testable.

**Fix.**
1. Extract the predicate into one pure function `evaluateLeasePush({ projectDir, cwd, env, branch, boardDir })` in `ai-sdlc-plugin/hooks/lib/trusted-policy.js` that returns `{ allowed, failing: [{ condition, found, expected, fix }] }`. The hook keeps its behaviour and calls it; every refusal message is rendered from `failing` so it names the exact condition and the sanctioned fix.
2. `ai-sdlc-pipeline next-step` (its ship module, when the state-machine body is on main) and Step 11 (`11-push-and-pr.ts`) call the same function BEFORE Step 10.5 (the pre-sign rebase): when it would refuse, the run stops with the rendered conditions before any review or signing is spent. `cli-hierarchy executor-start` runs it right after the claim and heartbeat and prints the result, so a misconfigured executor is caught at claim time.
3. `ai-sdlc doctor` check `lease-push-preflight --task <id>` prints the same table for an operator.
4. Golden-path hermetic tests in `ai-sdlc-plugin/hooks/lib/trusted-policy.test.mjs`: a fresh slugged task worktree with sentinel; a resumed worktree with NO sentinel whose task file is in `backlog/completed/`; a main-rooted hierarchy executor with env, one claim and a heartbeat; the exact-name branch `ai-sdlc/<id>`. Each must be ALLOWED. Negative twins (two claims, missing heartbeat, missing env, mismatched sentinel, other task's branch) must be REFUSED with the matching `condition`.

**Velocity impact.** Positive. Refusals move from the end of the pipeline to its start and name their fix; the hook loosens nothing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] One pure `evaluateLeasePush` function is the single source of the hook's lease decision; the hook's refusal text is rendered from its `failing` list.
- [ ] `next-step`, Step 11 and `executor-start` run the preflight and stop with the rendered conditions before any review or signing when it would refuse.
- [ ] `ai-sdlc doctor lease-push-preflight --task <id>` prints the condition table.
- [ ] Golden-path and negative hermetic tests cover the four allowed shapes and five refused shapes listed above.
- [ ] No currently allowed or refused shape in the existing lease-push tests changes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Family 2 of the 2026-10-10 root-cause set. Builds on AISDLC-794 (merged) and AISDLC-791 (#1330). Decisions it retires: DEC-0063, 0070, 0079, 0080.
