---
id: AISDLC-203
title: >-
  Codex workflow must complete backlog tasks atomically instead of copy-only
  completed files
status: To Do
assignee: []
created_date: '2026-05-05 19:56'
labels:
  - bug
  - codex
  - backlog
  - pipeline-cli
  - workflow
dependencies: []
references:
  - >-
    backlog/completed/aisdlc-201 -
    ai-sdlc-pipeline-execute-default-mock-spawner-can-mutate-task-state-without-explicit-run-intent.md
  - spec/rfcs/RFC-0012-two-tier-pipeline-architecture.md
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

During the Codex-driven AISDLC-201 workflow, the PR branch added `backlog/completed/aisdlc-201 - ...md`, but the parent checkout still retained `backlog/tasks/aisdlc-201 - ...md`. That means the Codex workflow effectively produced a copy-only completion in one checkout instead of an authoritative move from `backlog/tasks/` to `backlog/completed/`.

If repeated for AISDLC-199, AISDLC-200, AISDLC-202, or future Codex-dispatched work, the backlog can drift into duplicate task records across `tasks/` and `completed/`.

## Impact

A task may appear both open and completed depending on checkout/worktree state. This breaks backlog status queries, makes PR diffs misleading, and can cause future agents to redispatch already completed work.

## Implementation notes

The Codex workflow should invoke the Backlog MCP `task_complete` tool or a shared deterministic completion step that performs an atomic move in the authoritative checkout. Manual file copy/move from a task worktree is not sufficient unless the source deletion is guaranteed to be represented in the same git diff and parent checkout state is reconciled.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Codex task completion uses Backlog MCP `task_complete` or a shared deterministic completion helper rather than manually adding only a completed task file.
- [ ] #2 Completion verification checks that the task ID exists in exactly one backlog location after completion, preferring `backlog/completed/` and rejecting duplicates across `backlog/tasks/` and `backlog/completed/`.
- [ ] #3 The Codex workflow documents how to reconcile parent checkout and per-task worktree backlog state before opening a PR.
- [ ] #4 A regression test or scripted check covers the duplicate task scenario where a completed copy exists while the original task file remains in `backlog/tasks/`.
- [ ] #5 AISDLC-201 local backlog state is reconciled using the Backlog MCP completion path and the resulting behavior is captured as a regression note.
<!-- AC:END -->
