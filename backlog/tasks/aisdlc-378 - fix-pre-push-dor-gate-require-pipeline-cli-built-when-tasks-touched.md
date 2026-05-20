---
id: AISDLC-378
title: 'fix(hooks): pre-push DoR gate must REQUIRE pipeline-cli/dist when push touches backlog tasks (not silently no-op)'
status: To Do
assignee: []
created_date: '2026-05-20'
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

- [ ] #1 scripts/check-dor-gate.sh exits 1 when push touches backlog tasks AND pipeline-cli dist is missing; clear error message points at the build command
- [ ] #2 scripts/check-dor-gate.sh still exits 0 (silent) when push has no backlog task changes regardless of dist state
- [ ] #3 Hermetic test scripts/check-dor-gate.test.mjs covers both branches; passes
- [ ] #4 CLAUDE.md pre-push hook docs updated to describe the new fail-loud branch
- [ ] #5 Verified by removing pipeline-cli/dist locally + pushing a task-touching change → push refused with the helpful message

## Out of scope

- Making CI side of DoR ingress blocking (separate task AISDLC-379)
- Auto-rebuilding pipeline-cli on hook invocation (operator-environment concern; explicit failure better than slow magical rebuilds)

## Source

Operator 2026-05-20 frustration during RFC-0041 task breakdown: "didn't you setup pre-push hook? how many times do I have to tell you to set it up?" — gate exists but bypassed by the fresh-worktree no-op design choice from AISDLC-370. This task tightens the carve-out.
