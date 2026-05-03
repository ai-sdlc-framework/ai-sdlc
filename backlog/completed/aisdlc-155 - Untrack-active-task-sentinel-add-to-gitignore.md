---
id: AISDLC-155
title: Untrack .active-task sentinel + add to .gitignore
status: Done
assignee: []
created_date: '2026-05-03 02:51'
updated_date: '2026-05-03 02:51'
labels:
  - chore
  - tooling
  - cleanup
dependencies: []
references:
  - .gitignore
  - backlog/completed/aisdlc-81 - Per-worktree-active-task-sentinel-—-enable-parallel-ai-sdlc-execute-runs-with-cross-repo-writes.md
priority: medium
---

## Description

The per-worktree `.active-task` sentinel (AISDLC-81) was being committed to main accidentally by every developer agent that ran `/ai-sdlc execute`. Each parallel worktree's developer would `git add` everything in `git status`, which included `.active-task`, and the file would get committed with whatever task ID the worktree was running. Since each parallel run has a different task ID, every cross-branch rebase hit a merge conflict on `.active-task` (`AISDLC-153` vs `AISDLC-154` vs ...).

## Fix

1. `git rm --cached .active-task` — untrack the file (keep on local disk per `.gitignore` rules)
2. Add `.active-task` to `.gitignore` so future `git add -A` calls skip it

## Acceptance criteria

- [x] `.active-task` removed from git index (still on local disk)
- [x] `.active-task` listed in `.gitignore`
- [x] No merge conflicts on `.active-task` going forward across parallel worktrees

## Final Summary

Two-line fix that closes a recurring merge-conflict source surfaced during the AISDLC-149→154 cycle (every rebase of #197/#198/#199 hit a conflict on `.active-task` because each worktree had a different task ID written into it and prior dev runs committed it).
