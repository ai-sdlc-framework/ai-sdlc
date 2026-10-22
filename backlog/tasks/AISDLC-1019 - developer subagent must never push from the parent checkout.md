---
id: AISDLC-1019
title: >-
  Developer subagent must never push from the parent checkout: a stray push of main HEAD over a task branch auto-closed PR #1852
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - pipeline
  - governance
  - root-cause
dependencies: []
references:
  - ai-sdlc-plugin/agents/developer.md
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - docs/operations/backlog-and-execution-reference.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (2026-10-21, three incidents in one evening).** During the AISDLC-969 sign-push resume the developer subagent ran its push from the Pattern C parent checkout instead of the task worktree and pushed main's HEAD over `refs/heads/ai-sdlc/aisdlc-969-...`. GitHub auto-closed PR #1852 (head equal to base); the subagent then ran `gh pr reopen`. The notes of AISDLC-1010 and AISDLC-1016 report the same stray push "briefly" overwriting their task branch before a correct push from the worktree, and 1016's notes add that the parent's upstream had to be restored to `origin/main`. The branches were recovered (969's head 8edc6a780 matches its worktree), but every incident is one lease-push away from losing an approved PR, and a closed-then-reopened PR is a KPI miss.

**Root cause.** The developer's push step has no guard on its working directory. The Bash cwd of a subagent persists across calls, and the parent is a valid git checkout on `main` with the same remote, so a push typed there succeeds and clobbers the branch.

**Five-step review (requirements first).**
1. Requirement questioned: "the developer pushes its branch". Kept, narrowed to: from the task worktree only, with the branch's own commits.
2. Delete: nothing to delete; the hook that blocks pushes to `main` does not cover a push of main's content to another branch.
3. Simplify: one prompt rule in `prompt-rules.js` (rendered into the developer agent) says every git write runs with the worktree as cwd, and the pipeline's push helper refuses when `git rev-parse --show-toplevel` is not the task worktree or when `HEAD` equals `origin/main` while the branch has commits (that is the clobber signature).
4. Accelerate: the PreToolUse Bash hook denies `git push` whose cwd is the Pattern C parent (`.active-task` absent, `.worktrees/` present) for any ref other than a filing branch, with a message naming the worktree to use.
5. Automate: a hook test for the parent-cwd push denial and a unit test for the clobber-signature refusal; `gh pr reopen` is added to the developer's never-do list (a closed PR is routed to dispatch, not reopened by the subagent).

**Velocity impact.** Neutral on the happy path; removes the branch-recovery and reopen round trips.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 The developer agent prompt carries one rendered rule (from `prompt-rules.js`) that git writes run from the task worktree cwd and that `gh pr reopen` is never run by the subagent
- [ ] #2 The PreToolUse Bash hook denies a `git push` issued with the Pattern C parent as cwd to any `refs/heads/ai-sdlc/aisdlc-*` branch, naming the worktree path in the refusal (hook test)
- [ ] #3 The pipeline's push helper refuses to push when `HEAD` equals `origin/main` and the target branch already has commits ahead of main (unit test)
- [ ] #4 `docs/operations/backlog-and-execution-reference.md` documents the guard and the recovery for a clobbered task branch (lease push from the worktree, then `gh pr ready`)
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `node --test ai-sdlc-plugin/hooks/*.test.js`
- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
