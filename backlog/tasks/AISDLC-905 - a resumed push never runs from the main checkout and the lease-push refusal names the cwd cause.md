---
id: AISDLC-905
title: 'fix: a resumed push never runs from the main checkout and the lease-push refusal names the cwd cause'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [hooks, hierarchy, velocity]
references: [ai-sdlc-plugin/hooks/enforce-blocked-actions.js, ai-sdlc-plugin/hooks/lib/trusted-policy.js, ai-sdlc-plugin/commands/executor.md, pipeline-cli/src/dispatch/resume.ts]
priority: medium
dispatchable: true
---

## Description

A resumed task (fix round on an open PR) ends with the developer subagent pushing its rebased commit by hand. On 2026-10-15 an executor rebased a fix round to a ready commit, ran the lease push, and the push was refused by the worktree-location hook (`ai-sdlc-plugin/hooks/enforce-blocked-actions.js` through `trusted-policy.js`). The verdict note read "cwd resets to main checkout": the Bash session's working directory had drifted back to the parent checkout, so the hook saw a lease push from outside the task worktree and refused, as designed. The executor reported it as "hook-blocked", dispatch escalated it as a policy problem, and the planner had to read the worktree, the PR head and the hook source to find that the commit was fine and only the cwd was wrong. The same shape has appeared in earlier drains (the lease-push "two-call form" is a memory note, not a rule the tooling states).

Two things are missing: the refusal message does not say WHICH check failed and what cwd it saw, and the executor prompt and the resume note carry no instruction about where and how to run the push.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the developer runs the lease push by hand at all on a resume. The pipeline's own push step already runs from the task worktree; a resume that ends in "push the rebased commit" should go through the same step (`next-step` push) and never a hand-typed command. 2. Deleted: the hand push from the resume path. Where a hand push remains possible, nothing is deleted from the hook; it keeps refusing, only louder. 3. Simplified: the hook refusal is one line that names the failed check, the cwd it saw and the worktree it expected (`lease push refused: cwd /path/parent is not the task worktree /path/.worktrees/<task>; run it as a lone command from that worktree`), so the executor fixes it in one turn instead of escalating. 4. Accelerated: `executor.md` gains one sentence: "after a rebase, push through `next-step` from the task worktree; never type a push from another directory"; the resume note that `cli-dispatch resume` writes (`resume.ts`) appends the same sentence automatically so a resumed developer sees it in its own instructions. 5. Automated: the pipeline resume path performs the push itself when the developer returns a ready commit and no PR update, so the instruction is rarely needed.

## Acceptance Criteria

- [ ] When the lease-push guard refuses because the tool's cwd is outside the task worktree, the refusal names the cwd it saw, the worktree it expected and the fix ("run it as a lone command from that worktree"); the hook test asserts the message for a cwd in the parent checkout.
- [ ] `ai-sdlc-plugin/commands/executor.md` states that a rebased commit on a resume is pushed through the pipeline's push step from the task worktree, never by a hand-typed push from another directory; the command's test asserts the sentence.
- [ ] `cli-dispatch resume` appends that push instruction to the resume note it writes, within `MAX_NOTE_CHARS`; test asserts the appended text and the limit.
- [ ] The pipeline resume path pushes a developer-returned ready commit itself (from the task worktree) when the developer reports "rebased, not pushed"; test covers the push being performed and the refusal path being reported with the hook's message.
- [ ] Task file moved to `backlog/completed/` in the PR.
