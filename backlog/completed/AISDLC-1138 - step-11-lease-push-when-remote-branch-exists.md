---
id: AISDLC-1138
title: 'Step 11 first push uses force-with-lease against the existing remote head when the developer already pushed the branch and the role allows lease mode'
status: Done
assignee: []
created_date: '2026-10-31'
labels:
  - pipeline-cli
  - pipeline
dependencies: []
references:
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/steps/11-push-and-pr.test.ts
  - .ai-sdlc/agent-role.yaml
priority: high
dispatchable: true
---

## Description

On 2026-10-31 four approved tasks (AISDLC-1072, 1134, 1135, 940) failed at the push step with "non-fast-forward". The developer subagent had already pushed the branch and opened a draft PR (for example #2211 at e744089a, #2214 at 021adc64); step 10.5 then rebased the branch locally, and step 11 ran a plain `git push -u origin <branch>` because this was its first push of the run (no `resumeRemoteSha`). Step 11 already pushes with `--force-with-lease=refs/heads/<branch>:<sha>` on a resume (lines around 370 and 546); only the first-push branch of the ternary is plain.

Repo policy (`.ai-sdlc/agent-role.yaml`, `governance.allowForcePush`, DEC-0264) is `lease` here and `leaseOnOwnBranch` for adopters: both permit a lease push to the task's own branch from the task's own worktree.

**Five-step review (requirements first).**
1. Requirement questioned: should the developer subagent be forbidden from pushing early instead? Early pushes give the operator a draft PR to watch and are harmless by themselves; the requirement that stands is "the pipeline's push never loses an approved commit to a fast-forward refusal it can safely resolve".
2. Delete: nothing; the plain push stays for a branch that does not exist on origin.
3. Simplify: before the first push, step 11 runs `git ls-remote --heads origin <branch>`; when a head exists and the role's force-push mode is `lease` or `leaseOnOwnBranch` (and the worktree is the task's own), it reuses the existing lease-push code path with that sha as the lease. Mode `never` keeps the plain push and surfaces the same refusal as today, with a message naming the policy.
4. Accelerate: one extra `ls-remote` call per run; negligible.
5. Automate: unit tests in `11-push-and-pr.test.ts` for the three modes and for the branch-absent case; the protected-branch refusal (`main`, `master`) remains and is asserted.

Velocity impact: removes the second most common push refusal on the 2026-10-31 board (4 of 7 failed verdicts; one overlaps AISDLC-1137).

## Acceptance Criteria

- [x] AC-1: When `origin/<branch>` exists and the role allows lease pushes, step 11's first push is `--force-with-lease=refs/heads/<branch>:<remoteSha>`; when it does not exist, the push is unchanged (`push -u origin <branch>`).
- [x] AC-2: With mode `never`, step 11 still runs a plain push and, on refusal, reports that the role forbids a lease push (no silent retry, no `--force`).
- [x] AC-3: `main`, `master` and the protected branches are refused as before; a test asserts it.
- [x] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Notes

Origin: planner PR-pressure survey 2026-10-31 (failed verdicts AISDLC-1072, 1134, 1135, 940). Sibling tasks: AISDLC-1137, AISDLC-1139, AISDLC-1140.

## Final Summary

## Summary
Step 11's first push now runs `git ls-remote --heads origin <branch>`. If origin already has the branch and the policy is `lease`, or `leaseOnOwnBranch` from the task's own worktree, it pushes with `--force-with-lease=refs/heads/<branch>:<remoteSha>`. If the branch is absent it still runs the plain `push -u origin <branch>`. With mode `never` it also stays a plain push, and a refusal now says the role forbids a lease push. `main`, `master` and protected or malformed branch names never get a lease.

## Changes
- pipeline-cli/src/steps/11-push-and-pr.ts
- pipeline-cli/src/steps/11-push-and-pr.test.ts
- backlog/tasks/AISDLC-1138 - step-11-lease-push-when-remote-branch-exists.md

## Design decisions
The first `pnpm test` run failed 15 tests in `pipeline-cli/src/hierarchy/executor-start*.test.ts`. They fail only because this session's env (AI_SDLC_EXECUTOR_TASK=AISDLC-1138, AI_SDLC_HIERARCHY_ROLE, AI_SDLC_HIERARCHY_SESSION) pins the task claim. Full command run: `cd pipeline-cli && env -u AI_SDLC_EXECUTOR_TASK -u AI_SDLC_HIERARCHY_ROLE -u AI_SDLC_HIERARCHY_SESSION npx vitest run`. Result: Test Files 568 passed (568), Tests 12487 passed | 13 skipped (12500). `pnpm lint` and `pnpm format:check` were then run and passed. The pre-push hook's coverage run hit the same env problem, so I pushed with those three vars unset. Patch coverage was 42/42 lines (100%). The commit includes the backlog task file's status change to In Progress. The branch was already up to date with origin/main when I rebased.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

