---
id: AISDLC-378
title: 'fix(hooks): pre-push DoR gate must REQUIRE pipeline-cli/dist when push touches backlog tasks (not silently no-op)'
status: Done
assignee: []
created_date: '2026-05-20'
completed_date: '2026-05-22'
labels:
  - hooks
  - dor
  - bug
  - critical
dependencies: []
priority: critical
references:
  - scripts/check-dor-gate.sh
  - pipeline-cli/bin/cli-dor-check.mjs
---

## Problem

AISDLC-370 shipped the pre-push DoR gate (`scripts/check-dor-gate.sh`). The hook deliberately no-ops when `pipeline-cli/dist/cli/dor-check.js` is missing (rationale at the time: fresh worktrees pre-build shouldn't be unable to push). That carve-out has a real blind spot:

**2026-05-20 incident** — Operator pushed AISDLC-377.X task files from a worktree where pipeline-cli wasn't built. Pre-push hook silently no-op'd. PR landed in CI with Gate 3 (unresolved-reference) + Gate 7 (dependency-phrase) violations across 5 task files. The whole point of AISDLC-370 was to catch these locally.

## Fix (single PR)

### A. Make the no-op conditional on whether the push touches backlog tasks

In `scripts/check-dor-gate.sh`, after computing TASK_FILES (the changed `backlog/{tasks,completed}/*.md` files in the push range):

```bash
if [ -n "$TASK_FILES" ] && [ ! -f "$DIST" ]; then
  echo "[dor-gate] ERROR: push touches backlog task files but pipeline-cli is not built."
  echo "[dor-gate] Run: pnpm --filter @ai-sdlc/pipeline-cli build"
  echo "[dor-gate] Or skip with: AI_SDLC_SKIP_DOR_GATE=1 git push (NOT RECOMMENDED)"
  exit 1
fi
```

When the push has NO task changes, keep the silent no-op (avoids breaking first-build pushes of unrelated code).

### B. Update the hermetic test (scripts/check-dor-gate.test.mjs)

Add a case: push range touches backlog tasks AND dist missing → exit 1 with the "build pipeline-cli" message. Keep the existing "no task changes + dist missing → exit 0" case.

### C. CLAUDE.md update

Update the pre-push hook docs at item 3 to note the new fail-loud behavior when backlog tasks are in the push range without a build.

## Acceptance criteria

- [x] #1 scripts/check-dor-gate.sh exits 1 when push touches backlog tasks AND pipeline-cli dist is missing; clear error message points at the build command
- [x] #2 scripts/check-dor-gate.sh still exits 0 (silent) when push has no backlog task changes regardless of dist state
- [x] #3 Hermetic test scripts/check-dor-gate.test.mjs covers both branches; passes
- [x] #4 CLAUDE.md pre-push hook docs updated to describe the new fail-loud branch
- [x] #5 Verified by hermetic test (`node --test scripts/check-dor-gate.test.mjs` → 10/10 pass including the two new branches that mutate `pipeline-cli/dist/` between test cases)

## Out of scope

- Making CI side of DoR ingress blocking (separate task AISDLC-379)
- Auto-rebuilding pipeline-cli on hook invocation (operator-environment concern; explicit failure better than slow magical rebuilds)

## Source

Operator 2026-05-20 frustration during RFC-0041 task breakdown: "didn't you setup pre-push hook? how many times do I have to tell you to set it up?" — gate exists but bypassed by the fresh-worktree no-op design choice from AISDLC-370. This task tightens the carve-out.

## Final summary

Moved the `pipeline-cli/dist` presence check from the top of `scripts/check-dor-gate.sh` to AFTER the push-range walk that computes `TASK_FILES`. When `TASK_FILES` is empty (push doesn't touch backlog/{tasks,completed}/*.md), missing dist still silently exits 0 so fresh-worktree pushes of unrelated code aren't blocked. When `TASK_FILES` is non-empty, missing dist now exits 1 with a clear "pnpm --filter @ai-sdlc/pipeline-cli build" instruction sent to stderr — closing the 2026-05-20 incident's blind spot where 5 violating task files reached CI past a silently no-op'd local gate.

Hermetic test `scripts/check-dor-gate.test.mjs` now covers both branches:
- `exit 1 when bin/dist missing AND push touches backlog tasks (AISDLC-378)` — removes dist, commits a task file, asserts exit 1 + stderr matches the build message.
- `exit 0 when bin/dist missing AND push has NO task changes (fresh worktree)` — removes dist, commits a non-task file, asserts silent exit 0.

CLAUDE.md hook item 3 updated to describe the new conditional fail-loud behavior, referencing AISDLC-378 + the 2026-05-20 incident.

All 10 tests pass.
