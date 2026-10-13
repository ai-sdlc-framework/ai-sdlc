---
id: AISDLC-861
title: >-
  lease-push hook resolves the task worktree from `git -C <worktree>` or the active task id so a dev subagent can push from the parent cwd
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - hooks
  - reliability
dependencies: []
references:
  - ai-sdlc-plugin/hooks/lib/trusted-policy.js
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The lease-push guard (`ai-sdlc-plugin/hooks/lib/trusted-policy.js`, condition `worktree-location`) takes the worktree from the Bash tool's working directory and requires it to be a direct child of `.worktrees/`. A developer subagent spawned by `/ai-sdlc execute` inherits the executor session's cwd, which is the parent checkout, so its lease push is refused every time, whatever path it changes to inside the same command. On 2026-10-13 five tasks (AISDLC-828, 837, 840, 844, 846) ended `failed` with the work rebased locally and unpushed, each costing a dispatch escalation, a planner ruling and a re-enqueue, until the executor session itself pushed in two separate Bash calls (change directory alone, then the lease push alone). The rule the hook enforces is right (push only from the task's own worktree, on its own branch); the way it identifies the worktree is too narrow.

**Five-step review (requirements first).** Requirement questioned: "the worktree is identified by the process cwd". The actual requirement is that the push targets the task's own worktree and branch, which the hook can verify from the command itself. Deletion: nothing deleted; the cwd path stays valid. Simplified: the hook resolves the worktree in this order: an explicit `git -C <path>` prefix on the push command (realpath, must be a direct child of `.worktrees/`), else `AI_SDLC_ACTIVE_TASK_ID` mapped to `.worktrees/<id>`, else the cwd as today; every later condition (`own-session`, `board-claim`, `active-task-sentinel`, `worktree-name`, `branch`) runs unchanged against the resolved worktree. Accelerated: a dev subagent pushes on its first try, no two-call ritual, no re-enqueue. Automated: tests for the three resolution sources and for a `-C` path outside `.worktrees/` (refused).

## Fix

1. `ai-sdlc-plugin/hooks/lib/trusted-policy.js`: add `resolveWorktreeTop(command, env, cwd)` with the order above; use it where the worktree top is computed; keep the refusal text and add which source was used to the `found` field.
2. The lease-push-guard predicate that parses the push command also accepts the `git -C <path>` prefix before the lease-push spelling (same single-command rule; `&&`, `;` and subshells stay refused).
3. Tests in the hook's `node --test` suite: cwd form (unchanged), `-C` form inside `.worktrees/` (accepted), `-C` form elsewhere (refused), `AI_SDLC_ACTIVE_TASK_ID` form (accepted when the sentinel and claim agree).
4. Update the developer agent prompt line that tells it how to push (rendered from `prompt-rules.js`) to the `-C` form.

## Acceptance Criteria

- [ ] #1 A lease push issued with a `git -C <main>/.worktrees/<task>` prefix from the parent cwd passes `worktree-location`, and the later conditions behave as for the cwd form (test).
- [ ] #2 The same command with a `-C` path outside `.worktrees/` is refused with `worktree-location` (test).
- [ ] #3 With `AI_SDLC_ACTIVE_TASK_ID` set and no `-C`, the hook resolves `.worktrees/<id>` (test).
- [ ] #4 Compound commands (`&&`, `;`, `$(...)`) remain refused (existing test still passes).
- [ ] #5 The developer prompt line names the `-C` form.

**Velocity impact.** Strongly positive: five failed tasks in one day traced to this; each cost about an hour of queue time.

Authority: class (a) under `docs/operations/decision-authority.md` (the guard's rule is unchanged, only its evidence source widens to data it already verifies; reversible).
<!-- SECTION:DESCRIPTION:END -->
