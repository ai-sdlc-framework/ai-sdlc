---
id: AISDLC-858
title: >-
  Step 0.5 reuses an existing sync branch and PR for the same untracked file set so resumes are idempotent
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - pipeline
  - reliability
dependencies: []
references:
  - pipeline-cli/src/execute-pipeline.ts
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Step 0.5 of the execute pipeline syncs untracked `backlog/tasks/` files from the parent into a branch `chore/sync-tasks-<hash of the file set>` and opens a PR. When that PR has not landed yet, every later execute or resume in the same parent computes the same hash, finds the branch already exists (local or origin) and aborts with "branch chore/sync-tasks-<hash> already exists". On 2026-10-13 this stalled AISDLC-844, 676 and 764 behind one sync PR (#1488) and produced DEC-0186 and DEC-0188, both answered "wait for the sync PR". The retry is not idempotent for a step whose whole purpose is to be re-run.

**Five-step review (requirements first).** Requirement questioned: "a fresh sync branch per run". Not needed: the hash already identifies the file set, so the same set means the same branch and the same PR. Deletion: the abort path for an existing branch is deleted. Simplified: when `chore/sync-tasks-<hash>` exists on origin with an open PR, Step 0.5 logs the PR number and continues (the files are already on their way to main); when it exists locally only, Step 0.5 pushes it and opens the PR; only a branch whose PR is closed-unmerged is reported, never silently recreated. Accelerated: no executor parks on a pending sync again. Automated: tests for the three branch states (origin+open PR, local only, closed PR).

## Fix

1. `pipeline-cli/src/execute-pipeline.ts` (Step 0.5 sync): before creating the branch, look it up; existing + open PR → log and continue; local only → push and open PR; closed-unmerged → return a blocked verdict naming the PR instead of aborting on the branch name.
2. Tests for the three states in the Step 0.5 test file.
3. `docs/operations/decision-authority.md`: note DEC-0186/DEC-0188 superseded.

## Acceptance Criteria

- [ ] #1 A resume whose sync branch exists on origin with an open PR continues past Step 0.5 and logs that PR number (test).
- [ ] #2 A resume whose sync branch exists locally only pushes it and opens the PR, then continues (test).
- [ ] #3 A resume whose sync branch has a closed-unmerged PR returns a blocked verdict naming the PR, without creating a new branch (test).
- [ ] #4 No new flag or env var; `docs/operations/decision-authority.md` records DEC-0186/DEC-0188 as superseded.

**Velocity impact.** Positive: removes a park-and-escalate loop that hit three tasks in one day.

Authority: class (a) under `docs/operations/decision-authority.md` (reversible, non-weakening). Interim: wait for the sync PR to land, then re-run.
<!-- SECTION:DESCRIPTION:END -->
