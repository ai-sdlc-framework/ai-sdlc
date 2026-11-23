---
id: AISDLC-1363
title: 'A fix task can lease push to the head branch of the pull request it fixes'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - governance
  - hooks
  - adopter
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/lease-push-guard.js
  - ai-sdlc-plugin/hooks/lib/lease-push-guard.test.mjs
  - ai-sdlc-plugin/hooks/lib/trusted-policy.js
  - ai-sdlc-plugin/hooks/lib/trusted-policy.test.mjs
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs
  - pipeline-cli/src/dispatch/enqueue.ts
  - pipeline-cli/src/dispatch/board.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/cli/commands/commands.test.ts
  - docs/operations/backlog-and-execution-reference.md
  - docs/api-reference/governance.md
priority: medium
---

## Description

**Gap.** A fix task made with `cli-file task --fixes-pr <n>` works on the head branch of PR `<n>`, not on a branch of its own. Under `allowForcePush: leaseOnOwnBranch` the lease push hook refuses a `git push --force-with-lease` to that branch, because the branch does not carry the fix task's id. The work is done and reviewed, but the executor cannot push it.

What an adopter reported on plugin 0.42.0 (2026-11-19, `allowForcePush: leaseOnOwnBranch`). This was not reproduced here.

- PR #262 (task ACS-13) went red after main moved. The planner filed fix task ACS-18 with `cli-file task --fixes-pr 262`. The brief entry carried `fixesPr` and the PR head branch.
- The ACS-18 executor made the fix in `.worktrees/acs-18`, rebased ACS-13's commits onto the new main, and both reviewers approved.
- Its `git push --force-with-lease` to `ai-sdlc/acs-13-...` was refused by the lease guard hook. The executor wrote a failed verdict although the work was done.
- The operator pushed by hand and set `allowForcePush: lease` as a workaround. That is wider than needed.
- The adopter also says the `init` comment in `.ai-sdlc/agent-role.yaml` lists only `never | leaseOnOwnBranch`.
- The adopter notes that a fix task that rebases the PR branch makes the push a history rewrite, so a fast-forward-only allowance is not enough.

**Cause (read from the source on main at b9be05f97).**

- The hook decides "own branch" from the task, never from the PR. `taskBindingProblem` (`ai-sdlc-plugin/hooks/lib/lease-push-guard.js:235-263`) needs a task id, a worktree directory named after it, and a checked-out branch equal to `ai-sdlc/<task-id>` or starting with `ai-sdlc/<task-id>-`. The branch refusal text is "branch '<own>' is not this task's branch (ai-sdlc/<id> or ai-sdlc/<id>-*)" (`lease-push-guard.js:259`). `parseAllowedShape` returns it at `lease-push-guard.js:285-286`.
- For a fix task the worktree is `.worktrees/acs-18` and the branch is `ai-sdlc/acs-13-...`. The worktree name matches and the branch does not, so only the branch condition fails.
- The final refusal text is built in `evaluateLeasePush` (`lease-push-guard.js:455-468`). It starts "force-push under spec.governance.allowForcePush=leaseOnOwnBranch ... is limited to a 'git push --force-with-lease' on this task's own branch". It does not name the task's own branch or any PR branch.
- The hook runs this guard from `enforce-blocked-actions.js:545-559`. The earlier gate that refuses with `not-task-worktree` (`enforce-blocked-actions.js:204-207`) is a different check (worktree location, session and registration). A correct fix task worktree passes it, so it is not the refusal in this report.
- The pipeline already gives a fix task the PR head branch. `cli-file task --fixes-pr` reads the head branch with `gh pr view` and refuses a fork or a protected head (`pipeline-cli/src/cli/file.ts:541-574`). `enqueueTasks` writes `fixesPr` and `prHeadRef` into the board manifest (`pipeline-cli/src/dispatch/enqueue.ts:130-131`). The manifest is `<main>/.ai-sdlc/dispatch/inflight/<task-id>.dispatch.json` once the task is claimed (`pipeline-cli/src/dispatch/board.ts:890-896`). The task frontmatter does not carry `fixesPr`.
- Step 2 returns `prHeadRef` as the branch (`pipeline-cli/src/steps/02-compute-branch.ts:349-358`) and refuses a fork or a protected head (`:309-345`). Step 11 pushes to that branch with `--force-with-lease=refs/heads/<branch>:<sha>` (`pipeline-cli/src/steps/11-push-and-pr.ts:660-670`). That push is made from a child process through `runTrustedPush`, not through the hook. Its own-worktree check looks at the worktree structure only, not at the branch name (`pipeline-cli/src/hierarchy/lease-policy.ts:157-164`, called at `11-push-and-pr.ts:246`). So the pipeline's own push to a fix PR branch is not blocked by the hook; only a push the executor types in its shell is.
- Decision DEC-0264 (`.ai-sdlc/_decisions/events/2026-10-21T15-47-20.146Z__DEC-0264__decision-opened__cc79ad5dea26.json`) added mode `lease` and kept `leaseOnOwnBranch` as the adopter default. Its option text: "Add allowForcePush mode lease (lease push to any non-protected branch from any cwd and role); set this repo to it; leaseOnOwnBranch stays the adopter default". It does not say that a fix task's PR branch counts as its own branch. DEC-0083 (exact branch name `ai-sdlc/<task-id>`), DEC-0087 and DEC-0067 only shape how the task binding is checked; none mentions `fixesPr`.
- The `init` comment lists two modes (`orchestrator/src/cli/commands/init.ts:116-122`, line 121 reads `# never | leaseOnOwnBranch`). Mode `lease` (AISDLC-1005) is missing, so the gap is confirmed on main. `docs/api-reference/governance.md:85` has the same two-mode comment.
- Not verified: why the executor pushed by hand instead of leaving the push to Step 11. AISDLC-1227 says a resumed developer round commits only and Step 11 is the sole pusher (`ai-sdlc-plugin/hooks/lib/resumed-round-fence.js:6`). The developer must find the reported path (a hand push after its own rebase, or a Step 11 push that fell back to the hook) before choosing how much of the guard has to change.

**Shape.** In mode `leaseOnOwnBranch`, a lease push from a task's own worktree to the head branch of the PR named by that task's recorded `fixesPr` is allowed. The `fixesPr` and its head branch come from the inflight board manifest in the main checkout, which the filing CLI wrote. That an executor cannot write this file was not verified; the developer confirms which hook protects it and stops with that finding if none does. The branch condition of the guard accepts either the task's own branch or that recorded PR head branch.

**Control.** This widens what `leaseOnOwnBranch` permits, from the task's own branch to the task's own branch plus the head branch of the PR it was filed to fix. The operator chose this on 2026-11-19 (DEC-0421, option `widen-fixes-pr`). Main, master and protected branches, plain force, `+refspec`, deletes, and modes `never` and `lease` do not change.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: must the executor type the push at all? Step 11 already lease pushes the PR branch from a child process, so the hook change is needed only if the hand push is the supported path; the developer confirms this first. 2. Deleted: the failed verdict for finished work, and the need for a wider `lease` mode in adopters. 3. Simplified or optimised: reuse the manifest record the filing CLI already wrote and the existing branch condition, with no new field and no new CLI. 4. Accelerated: a fix task pushes without an operator in the loop. 5. Automated: tests cover the allow case and every refusal.

- **Source of the fix PR branch.** Read `fixesPr` and `prHeadRef` from `<main>/.ai-sdlc/dispatch/inflight/<task-id>.dispatch.json` for the task id bound to the worktree. Never read it from the command line, an environment variable or a message. If the manifest is missing, malformed, or has `fixesPr` without `prHeadRef`, the allowance does not apply.
- **Guard.** In `taskBindingProblem` and the `leaseOnOwnBranch` path of `parseAllowedShape`, accept the branch when it equals the recorded `prHeadRef`. The head must be a plain branch name, in the same repository (the manifest comes from `cli-file`, which already refuses a fork), and not `main`, `master` or protected (check the policy list as well as the built-in list). Keep every other rule of the guard, including the lease flag and the fully qualified `HEAD:refs/heads/<branch>` refspec, with the branch being pushed equal to the checked-out branch.
- **Refusal message.** For any other branch, the refusal names the task's own branch (`ai-sdlc/<id>[-slug]`) and, when a `fixesPr` branch is recorded, that branch as well.
- **Init comment.** List all three modes in `AGENT_ROLE_GOVERNANCE_COMMENT`: `never | leaseOnOwnBranch | lease`, with one short line for each. Update the matching comment in `docs/api-reference/governance.md:85`.
- **Docs.** Add one line to the `fixesPr` section of `docs/operations/backlog-and-execution-reference.md` that says a fix task may lease push the PR head branch under `leaseOnOwnBranch`.

Expected files (10, within the 15 file limit):

- `ai-sdlc-plugin/hooks/lib/lease-push-guard.js`
- `ai-sdlc-plugin/hooks/lib/lease-push-guard.test.mjs`
- `ai-sdlc-plugin/hooks/lib/trusted-policy.js`
- `ai-sdlc-plugin/hooks/lib/trusted-policy.test.mjs`
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`
- `ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs`
- `orchestrator/src/cli/commands/init.ts`
- `orchestrator/src/cli/commands/commands.test.ts`
- `docs/api-reference/governance.md`
- `docs/operations/backlog-and-execution-reference.md`

Out of scope: changing mode `never` or `lease`, changing Step 2, Step 3 or Step 11, loosening the rule for plain force, and any push to a fork.

## Operator decision

DEC-0421, answered by the operator on 2026-11-19 with option `widen-fixes-pr`: in mode `leaseOnOwnBranch`, a lease push from the task's own worktree to the head branch recorded for that task's `fixesPr` is allowed. Main, protected branches, forks and plain force stay refused. The option not chosen was to leave the mode as it is and report "needs operator push".

**First step, before any hook change.** The developer establishes why the push step did not make this push (AISDLC-1227 makes Step 11 the sole pusher of a resumed round). If the hook does not need to change for a fix task to land, the developer changes nothing in the guard, writes the finding in the pull request, and delivers only the init comment and docs items. The developer also confirms which hook stops an executor from writing the inflight manifest; if none does, the developer stops and reports that instead of relying on the record.

## Acceptance Criteria

- [ ] #1 In mode `leaseOnOwnBranch`, a test shows a lease push from the task's own worktree to `HEAD:refs/heads/<prHeadRef>` is allowed when the inflight manifest for that task records `fixesPr` and `prHeadRef`.
- [ ] #2 A test shows the allowance reads the record the filing CLI wrote (the inflight board manifest in the main checkout) and that a `fixesPr` or branch given on the command line, in an environment variable, or in a message does not allow the push.
- [ ] #3 A test shows the push is refused when the manifest is missing or malformed, has no `prHeadRef`, or names a different branch than the one being pushed.
- [ ] #4 A test shows a recorded head of `main`, `master` or a protected branch (built-in and policy list) is refused, and that a head recorded as another repository's branch is never accepted.
- [ ] #5 A test shows plain `--force`, `-f`, `+refspec`, a delete and a no-colon refspec are still refused for the fix PR branch.
- [ ] #6 A test shows modes `never` and `lease` give the same decisions as before this change.
- [ ] #7 The refusal for any other branch names the task's own branch and, when a `fixesPr` branch is recorded, that branch; a test checks both texts.
- [ ] #8 The `init` governance comment lists `never`, `leaseOnOwnBranch` and `lease`, and `commands.test.ts` checks all three names.
- [ ] #9 The pull request body states why the push step did not make the reported push, and which hook protects the inflight manifest from an executor write.
- [ ] #10 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
