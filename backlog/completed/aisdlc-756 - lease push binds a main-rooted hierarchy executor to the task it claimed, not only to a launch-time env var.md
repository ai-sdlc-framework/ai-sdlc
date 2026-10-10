---
id: AISDLC-756
title: >-
  Lease push binds a main-rooted hierarchy executor to the task it claimed, not only to a launch-time env var
status: Done
assignee: []
created_date: '2026-10-07'
labels:
  - plugin
  - governance
  - enforce-blocked-actions
  - rfc-0051
  - dispatch
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/trusted-policy.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs
  - pipeline-cli/src/hierarchy/up.ts
  - pipeline-cli/src/hierarchy/inflight.ts
  - pipeline-cli/src/hierarchy/types.ts
  - ai-sdlc-plugin/commands/executor.md
  - docs/operations/cli-hierarchy.md
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-710 (DEC-0047) made `leaseOnOwnBranch` the default so that a lease push of a dispatched task's own branch needs no operator prompt, and defined "own" as: a worktree under `<repo>/.worktrees/` whose `.active-task` id, directory name and `ai-sdlc/<task-id>-*` branch agree. The hook implements one extra binding on top of that definition, in `resolveLeaseWorktree()` in `ai-sdlc-plugin/hooks/lib/trusted-policy.js`: when the session's project dir is the main checkout (`realProj === realMain`), the cwd worktree's `.active-task` must equal `AI_SDLC_ACTIVE_TASK_ID` from the hook's own environment, otherwise the push is refused as `not-task-worktree`.

Hierarchy executor sessions (`cli-hierarchy up`) are rooted at the main checkout and claim a task only after launch, so that environment variable can never name their task. Result on 2026-10-07: AISDLC-746 was done, reviewed, leaves emitted, and the lone lease push in the exact explicit form the guard documents (remote `origin`, refspec `HEAD:refs/heads/<own-branch>`), run with cwd `.worktrees/aisdlc-746`, was refused as `not-task-worktree`; the same thing stalled AISDLC-546 on 2026-10-06. Every hierarchy executor is affected; the planner had to push 546 from a differently rooted session. Recorded as DEC-0067 (option `fix-hook-binding`), class (a): it applies the "own branch" definition DEC-0047 already put on main and the operator's 2026-10-03 ruling that lease pushes on own branches are always authorized; it does not widen what may be pushed (still only `ai-sdlc/<task-id>-*` on a dispatched worktree, never main or a protected branch).

Change the main-rooted binding so a hierarchy executor is bound to the task it holds:

- `cli-hierarchy up` sets `AI_SDLC_HIERARCHY_SESSION=<roster name>` (and `AI_SDLC_HIERARCHY_ROLE=<role>`) in the environment of every session it starts, so the hook sees them at launch and the agent's own Bash commands cannot change them (same trust property as `AI_SDLC_ACTIVE_TASK_ID`). `cli-hierarchy status` surfaces the two values per session.
- In `resolveLeaseWorktree()`, when the project dir is the main checkout: accept the cwd worktree if `AI_SDLC_ACTIVE_TASK_ID` matches (unchanged), OR if `AI_SDLC_HIERARCHY_SESSION` is set, `AI_SDLC_HIERARCHY_ROLE` is `executor`, and the dispatch board has exactly one inflight manifest under `<main>/.ai-sdlc/dispatch/inflight/` whose heartbeat `workerId` (the unqualified role name `inflight.ts` reads, e.g. `executor-alpha`; compare against the session name with and without the `<project>-` prefix) equals that session and whose task id equals the worktree's `.active-task` (compare lower-case). The existing worktree checks (realpath under `.worktrees/`, direct child, gitdir back-link, `.active-task` present, branch prefix agreement enforced by the caller) all stay. Dispatch and planner roles get no new path: their project dir is also the main checkout, and they hold no inflight manifest.
- The `not-task-worktree` refusal text from a main-rooted session names the two accepted bindings and the next step (claim the task through the executor loop, or run the push from a session rooted in the worktree), per the decision-authority rule that every refusal names a step the agent can take itself.
- Hermetic tests in `enforce-blocked-actions.test.mjs` (or a sibling test file for `trusted-policy.js`): main-rooted session with matching inflight claim is allowed; with no claim, a claim by another executor name, two claims by the same name, a claim for a different task, a `dispatch`/`planner` role, or a tampered manifest path outside `inflight/`, all refused; `AI_SDLC_ACTIVE_TASK_ID` path unchanged. Use a temporary main checkout plus `git worktree add` like the existing lease tests.
- Document the binding in `docs/operations/cli-hierarchy.md` (executor section) and `docs/operations/decision-authority.md` (the lease-push refusal entry), and update `ai-sdlc-plugin/commands/executor.md` so the executor loop no longer tells itself to escalate a `not-task-worktree` refusal on its own claimed task.

Interim route until this ships, for the dispatch playbook: run the push from a session whose project dir is the worktree, for example `env -u CLAUDECODE claude -p --permission-mode bypassPermissions` with cwd `.worktrees/<task>`, giving it only the exact lease push, the one re-run the pre-push signer may ask for, and the draft PR creation.

Sequencing: hooks run from the installed plugin, so executors see this only after the next plugin release and a `cli-hierarchy down` / `up` restart.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] From a hierarchy executor started by `cli-hierarchy up` (project dir = main checkout, no `AI_SDLC_ACTIVE_TASK_ID`), with the task claimed on the board, a lone lease push in the accepted explicit form with cwd in that task's worktree is allowed; the same push from the dispatch session or from an executor that does not hold the claim is refused as `not-task-worktree`.
- [x] `cli-hierarchy up` exports `AI_SDLC_HIERARCHY_SESSION` and `AI_SDLC_HIERARCHY_ROLE` into each started session; `hierarchy.test.ts` asserts both on the generated command line for all three roles.
- [x] Hermetic hook tests cover the allowed case and each refused case listed in the description, plus the unchanged `AI_SDLC_ACTIVE_TASK_ID` path.
- [x] Plain force pushes, any push to main/master or a protected branch, and any no-colon or omitted-refspec form stay refused (existing tests unchanged and green).
- [x] The `not-task-worktree` refusal text names both bindings and a next step; `docs/operations/cli-hierarchy.md`, `docs/operations/decision-authority.md` and `ai-sdlc-plugin/commands/executor.md` are updated.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` and `pnpm dark-code:check` pass apart from the pre-existing pipeline-cli failures (verify-runtime, bin-invocation, TUI timeouts), disclosed in the PR body.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
A hierarchy executor rooted at the main checkout can now lease-push its own claimed task branch: the hook binds it to the single inflight claim it holds on the dispatch board, in addition to the unchanged `AI_SDLC_ACTIVE_TASK_ID` binding.

## Changes
- `pipeline-cli/src/hierarchy/up.ts` (modified): every started session gets `AI_SDLC_HIERARCHY_SESSION` and `AI_SDLC_HIERARCHY_ROLE` in its launch command, shell-quoted.
- `pipeline-cli/src/hierarchy/status.ts` (modified): status table shows both values per session.
- `ai-sdlc-plugin/hooks/lib/trusted-policy.js` (modified): `resolveLeaseWorktree()` accepts an executor session holding exactly one inflight claim for the worktree's task; fails closed on any error or symlinked manifest/state/inflight path.
- `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` (modified): `not-task-worktree` refusal names both bindings and a next step.
- `ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs`, `pipeline-cli/src/hierarchy/hierarchy.test.ts` (modified): hermetic coverage.
- `docs/operations/cli-hierarchy.md`, `docs/operations/decision-authority.md`, `ai-sdlc-plugin/commands/executor.md` (modified): documented the binding.

## Design decisions
- **Refusal text avoids literal env var names**: an existing AISDLC-710 test forbids `AI_SDLC_` in refusals (never suggest an exit); the text describes the bindings in words.
- **Missing heartbeat file is skipped, a symlinked one fails closed**: a claim without a heartbeat names no worker.

## Verification
- `node --test ai-sdlc-plugin/hooks/*.test.mjs ai-sdlc-plugin/hooks/lib/*.test.mjs` - 964 pass
- `vitest run src/hierarchy` - 420 pass

## Follow-up
(none)
<!-- SECTION:FINAL_SUMMARY:END -->
