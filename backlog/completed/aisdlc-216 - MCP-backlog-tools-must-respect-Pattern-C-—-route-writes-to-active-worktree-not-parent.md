---
id: AISDLC-216
title: >-
  MCP backlog tools must respect Pattern C — route writes to active worktree,
  not parent
status: Done
assignee: []
created_date: '2026-05-06 14:10'
labels:
  - bug
  - framework-bug
  - mcp-server
  - pattern-c
  - drift-prevention
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`mcp__backlog__task_create`, `mcp__backlog__task_edit`, and `mcp__backlog__task_complete` resolve project root via `cwd`-walk → almost always lands at the parent repo root. They then write task files (or modify in-place) at `<parent>/backlog/tasks/<id>.md`.

In Pattern C (project memory `project_orchestrator_repo_layout.md`), the parent's working tree is **READ-ONLY** by contract. All edits should happen inside `.worktrees/<task-id>/`. But the MCP tools bypass this, accumulating untracked files + modified-but-uncommitted state on parent that:

- Won't sync to origin until manually PR'd
- Block Step 0 self-heal (which refuses to reset a dirty parent)
- Get LOST on `git reset --hard origin/main` if not synced first
- Force operator manual cleanup every multi-task session

## Observed tonight (2026-05-06)

6 task files (AISDLC-210/211/212/213/214/215) accumulated as untracked in parent during one autopilot session. 5 status flips (To Do → In Progress) modified files in-place. Operator had to file PR #354 manually + `git reset --hard origin/main` to unstick.

## Fix

The MCP server's project-root resolver needs a Pattern-C-aware mode:

1. **Detect Pattern C**: project root has a `.worktrees/` directory containing at least one worktree
2. **Refuse to write at parent**: if no `.active-task` sentinel at parent root AND we're NOT inside a worktree, refuse the write with a clear error: "Pattern C detected — specify which worktree via `--worktree <task-id>` or set `AI_SDLC_ACTIVE_TASK_ID` env"
3. **Auto-route to active worktree**: if the caller's `cwd` is inside `.worktrees/<task-id>/`, write into THAT worktree's `backlog/tasks/<id>.md` (not parent's)
4. **Lookup via env**: if `AI_SDLC_ACTIVE_TASK_ID` is set, route to `<parent>/.worktrees/<task-id-lower>/backlog/tasks/`

## Composes with

- AISDLC-217 (auto-sync untracked parent files) — backstop for cases this fix misses
- `feedback_bash_cwd_persists.md` memory — same root cause class (cwd assumptions break Pattern C)

## Acceptance Criteria
- [ ] #1 MCP server's project-root resolver detects Pattern C (parent + .worktrees/ exists)
- [ ] #2 In Pattern C, writes refuse + return helpful error if cwd is parent root AND no active-task signal
- [ ] #3 If cwd is inside `.worktrees/<task-id>/`, MCP tools route to that worktree's backlog/, not parent's
- [ ] #4 If `AI_SDLC_ACTIVE_TASK_ID` is set, MCP tools route to that worktree
- [ ] #5 Hermetic test: simulate Pattern C cwd-from-parent + task_create → asserts refusal with helpful message
- [ ] #6 Hermetic test: simulate cwd-from-worktree + task_create → asserts file lands in worktree's backlog/, not parent's
- [ ] #7 Documentation in CLAUDE.md `## Plugin MCP server — project root resolution` section updated with Pattern C resolver behavior
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

Implementation shipped via PR for AISDLC-216; lifecycle close was lost when the now-retired `backlog-task-complete.yml` workflow's chore-close PR (#369/#371) failed to auto-merge. Moving to `backlog/completed/` retroactively as part of the post-AISDLC-220 sync sweep.
