---
name: 855-hold-for-946
description: planner 2026-10-16: #1652 (AISDLC-855) held for AISDLC-946; no reenter, no push, leave .worktrees/aisdlc-855 untouched
metadata:
  type: project
  modified: 2026-10-16T19:05:43.774Z
---

#1652 (AISDLC-855) held for AISDLC-946 (#1685), same as 881. `.worktrees/aisdlc-855` is rebased onto main (runbook deletion taken), ahead 11 / behind 6, unpushed. The push hook refuses dispatch and the planner.

**Why:** 946 makes failed executor work re-claimable by the normal loop and lets reenter pass when local HEAD is ahead; a DEC-0187 re-enqueue would hit the same "push-only refused" stop 929 hit.

**How to apply:** no reenter, no cleanup sweep on the worktree, no routing the push elsewhere. Report only if #1652's remote head changes (operator hand push, then ONE reenter on the new head with the rebase note) or 946 lands (normal-loop claim pushes it, then one review round). `cli-dispatch rule` is missing from the plugin-cache CLI 0.29.0 (repo build stale), so the ruling is recorded here instead of on the board.
