---
id: AISDLC-476
title: >-
  DoR pre-push gate must not scan backlog/completed/ — Definition-of-Ready
  should gate admission, not completed work
status: Done
assignee: []
created_date: '2026-05-29 17:42'
updated_date: '2026-05-29 18:40'
labels:
  - ci-friction
  - dor
  - bugfix
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem (audit 2026-05-29)

`scripts/check-dor-gate.sh` (~line 60) selects task files to evaluate with:

```bash
RANGE_FILES=$(git diff --name-only --diff-filter=AMR "${RANGE_BASE}..${LOCAL_SHA}" -- 'backlog/tasks/**.md' 'backlog/completed/**.md' 2>/dev/null || true)
```

It scans BOTH `backlog/tasks/**` AND `backlog/completed/**`. Definition-of-Ready is an ADMISSION gate — it enforces that acceptance criteria, references, and dependencies are filled in BEFORE the orchestrator dispatches a task. Once a task is in `backlog/completed/`, it has already shipped (its PR closed it). Applying DoR to completed tasks is philosophically backwards and operationally annoying: any edit to a completed task's finalSummary / notes triggers a failed push.

This bit a real push this session (2026-05-29): the AISDLC-473 completed task file was rejected twice by the local pre-push DoR gate even though the work was done.

## Confirming asymmetry

The CI-side equivalent `.github/workflows/dor-ingress.yml` correctly scopes its `paths:` trigger to `backlog/tasks/*.md` ONLY — NOT `backlog/completed/`. So the pre-push gate is asymmetrically broader than the CI gate. This fix brings them into alignment.

## Fix

Remove `'backlog/completed/**.md'` from the glob on ~line 60 of `scripts/check-dor-gate.sh`:

```bash
RANGE_FILES=$(git diff --name-only --diff-filter=AMR "${RANGE_BASE}..${LOCAL_SHA}" -- 'backlog/tasks/**.md' 2>/dev/null || true)
```

Preserve the AISDLC-378 conditional-fresh-worktree behavior (the dist-missing + task-files-touched fail-loud) — it still fires correctly for `backlog/tasks/` changes.

## Source files
- `scripts/check-dor-gate.sh` (~line 60 file-selection glob)
- `scripts/check-dor-gate.test.mjs` (update the comment/test that documents scanning both dirs)

Blast radius: very low — purely narrows the scan to match the already-correct CI behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `scripts/check-dor-gate.sh` file-selection glob no longer includes `backlog/completed/**.md` (scans only `backlog/tasks/**.md`)
- [ ] #2 Editing a file in `backlog/completed/` no longer triggers a DoR-gate failure on push
- [ ] #3 The AISDLC-378 dist-missing + task-files-touched fail-loud behavior still fires for `backlog/tasks/` changes
- [ ] #4 `scripts/check-dor-gate.test.mjs` updated to reflect tasks-only scope; all gate tests pass
- [ ] #5 Pre-push DoR scope now matches the CI `dor-ingress.yml` `paths:` scope (both tasks-only)
<!-- AC:END -->
