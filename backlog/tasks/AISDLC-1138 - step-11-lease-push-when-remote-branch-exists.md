---
id: AISDLC-1138
title: 'Step 11 first push uses force-with-lease against the existing remote head when the developer already pushed the branch and the role allows lease mode'
status: To Do
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

- [ ] AC-1: When `origin/<branch>` exists and the role allows lease pushes, step 11's first push is `--force-with-lease=refs/heads/<branch>:<remoteSha>`; when it does not exist, the push is unchanged (`push -u origin <branch>`).
- [ ] AC-2: With mode `never`, step 11 still runs a plain push and, on refusal, reports that the role forbids a lease push (no silent retry, no `--force`).
- [ ] AC-3: `main`, `master` and the protected branches are refused as before; a test asserts it.
- [ ] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Notes

Origin: planner PR-pressure survey 2026-10-31 (failed verdicts AISDLC-1072, 1134, 1135, 940). Sibling tasks: AISDLC-1137, AISDLC-1139, AISDLC-1140.
