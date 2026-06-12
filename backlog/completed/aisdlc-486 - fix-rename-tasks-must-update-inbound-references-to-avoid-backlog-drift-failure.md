---
id: AISDLC-486
title: >-
  fix: dev subagent must update inbound references when renaming/moving a
  referenced file (avoid Backlog Drift gate failure)
status: To Do
assignee: []
created_date: '2026-05-31 00:00'
labels:
  - bug
  - dispatch
  - developer-subagent
  - backlog-drift
  - ci
dependencies: []
references: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## Context

On 2026-05-31, PR #789 (AISDLC-474) renamed `ai-sdlc-plugin/commands/review.md` to `ai-sdlc-plugin/commands/review-pr.md`. The rename was correct, but the completed backlog task AISDLC-71 ("Replace orchestrator-driven dogfood pipeline with /ai-sdlc execute plugin command") had a frontmatter/body reference to the old path `ai-sdlc-plugin/commands/review.md`. After the rename that referenced file no longer existed, so `backlog-drift check` flagged it as an error-severity issue (`✗ Referenced file no longer exists: ai-sdlc-plugin/commands/review.md`). Backlog Drift is a REQUIRED merge check (promoted from advisory in AISDLC-125), so this blocked PR #789 from merging until the stale reference was manually corrected to `review-pr.md`. The developer subagent that performed the rename did not search for or update inbound references to the file it moved.

## Impact

Any dispatch task that renames or moves a file referenced by another backlog task (or any drift-tracked artifact) will fail the required Backlog Drift gate and stall the PR, requiring manual operator intervention mid-flight. This directly undermines unattended/parallel dispatch — it cost a manual fix in the first real execute-parallel run. The class is general: renames, deletions, and moves of any drift-referenced path.

## Proposed Fix

When a developer subagent renames/moves/deletes a file, it should (a) `grep` the repo (especially `backlog/`) for references to the old path and update them in the same commit, OR (b) run `npx backlog-drift check` (or `backlog-drift fix --task <id>`) as part of its Definition-of-Done verification before opening the PR and repair any error-severity drift it introduced. Wire this into the developer subagent's contract / the Step 0-13 verification so the drift gate is satisfied locally before push, not discovered in CI.

## Acceptance Criteria

- [ ] #1 The developer subagent's workflow detects when its changes rename/move/delete a file and updates inbound references (at minimum in `backlog/`) in the same PR.
- [ ] #2 A developer-subagent verification step runs `backlog-drift check` (error-severity) before opening the PR and fails locally (with a clear message) if the change introduced new error-severity drift, so it is fixed pre-push.
- [ ] #3 A regression test/fixture proves a rename that orphans a backlog reference is caught and repaired (or blocked) before PR open.
- [ ] #4 The developer-subagent contract / runbook documents the rename-updates-references requirement.

## Notes

Surfaced by the 2026-05-31 live `/ai-sdlc execute-parallel` test (PR #789, AISDLC-474). Related to the autonomy-gap family AISDLC-480/481/485.

<!-- SECTION:DESCRIPTION:END -->
