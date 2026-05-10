---
id: AISDLC-222
title: >-
  Step 0.5 should reconcile path-mismatched task files (tasks/X.md vs origin's
  completed/X.md)
status: Done
assignee: []
created_date: '2026-05-06 19:09'
labels:
  - enhancement
  - orchestrator
  - framework-bug
dependencies: []
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Step 0.5 (`pipeline-cli/src/steps/00-5-sync-parent.ts`) detects untracked task files in the parent and opens a sync PR for "genuinely new" files — `isFileOnOriginMain` checks the EXACT path on origin/main. But a stale local copy at `backlog/tasks/aisdlc-N - X.md` whose canonical version is at `backlog/completed/aisdlc-N - X.md` on origin/main returns `false` from `isFileOnOriginMain`, so Step 0.5 opens a sync PR for it — duplicating the file.

Observed 2026-05-06 after AISDLC-220 + #373 merged: the parent had stale `aisdlc-{212,219,220}` copies in `tasks/` whose canonical versions had just landed in `completed/`. Manual `rm` was needed; Step 0.5 would have re-synced them as duplicates.

## Proposed fix

In `isFileOnOriginMain` (or a new sibling check), also probe the SAME basename in `backlog/completed/` AND `backlog/tasks/`. If found in either, treat as "already on origin/main" and:

- Log `[step-0.5] aisdlc-N: stale local copy at <local-path>; canonical version on origin at <other-path> — operator should rm the local file`
- Skip syncing it
- Optionally (with explicit env opt-in like `AI_SDLC_STEP_0_5_AUTO_RECONCILE=1`): delete the stale local copy automatically

Conservative default: skip + log. Auto-delete is destructive; gate behind opt-in.

## Acceptance Criteria

- [ ] #1 `isFileOnOriginMain` (or sibling) probes both `backlog/tasks/` AND `backlog/completed/` for the same basename
- [ ] #2 When path-mismatch detected, log a clear `[step-0.5] aisdlc-N: stale local copy at <X>; canonical at <Y>` line
- [ ] #3 Skip syncing path-mismatched files (don't add to sync PR — they'd duplicate)
- [ ] #4 Unit test in `00-5-sync-parent.test.ts`: fixture has `tasks/aisdlc-N` locally + `completed/aisdlc-N` on origin → step skips with log
- [ ] #5 Symmetric test: local has `completed/aisdlc-N` + origin has `tasks/aisdlc-N` (rare; operator promoted file but main hasn't caught up) → also skip with log
- [ ] #6 Opt-in `AI_SDLC_STEP_0_5_AUTO_RECONCILE=1`: when set, deletes the stale local copy via `git rm` (or `rm` for untracked) — separate test
- [ ] #7 docs/operations/operator-runbook.md: document the new log line + the auto-reconcile env var

## References

- `pipeline-cli/src/steps/00-5-sync-parent.ts` (`isFileOnOriginMain` and `syncParentUntrackedFiles`)
- `pipeline-cli/src/steps/00-5-sync-parent.test.ts`
- AISDLC-217 (Step 0.5 origination)
<!-- SECTION:DESCRIPTION:END -->
