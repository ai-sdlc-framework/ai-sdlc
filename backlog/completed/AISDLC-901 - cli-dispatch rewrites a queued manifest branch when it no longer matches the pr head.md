---
id: AISDLC-901
title: 'fix: cli-dispatch rewrites a queued manifest''s branch when it no longer matches the PR head'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [dispatch, bug]
references: [pipeline-cli/src/dispatch/board.ts, pipeline-cli/src/cli/dispatch.ts, pipeline-cli/src/hierarchy/pr-state.ts, pipeline-cli/src/dispatch/resume.ts]
priority: high
dispatchable: true
---

## Description

Two queued tasks on the dispatch board (seen 2026-10-15) carry a short-form branch in their queue manifest (`ai-sdlc/aisdlc-<n>`) while the open PR's head is the long slug (`ai-sdlc/aisdlc-<n>-<title-slug>`). `cli-dispatch write-manifest` refuses to re-emit because `queue/` already holds the file ("release inflight before re-emitting", `writeManifest` in `pipeline-cli/src/dispatch/board.ts`), and there is no sanctioned command to correct a queued manifest, so dispatch cannot fix it and a resume would check out the wrong branch. Hand-editing board files is prohibited.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that a queued manifest is immutable once emitted. The invariant protects an *inflight* manifest from being overwritten under an executor; a *queued* one has no reader until claim, so immutability there buys nothing. 2. Deleted: the blanket "queue/ already has the file" refusal for the queued state (the inflight refusal stays). 3. Simplified: `write-manifest` on a queued task replaces the manifest in place when the task is queued and refuses only when it is inflight; the branch comes from the open PR head (`gh pr view --json headRefName`) or the explicit `--branch` flag, so the manifest cannot drift from the PR again. 4. Accelerated: dispatch repairs a mismatch in one command during the tick instead of parking the task for the planner. 5. Automated: the tick's PR classification (`manifest-branch-mismatch` in `pipeline-cli/src/hierarchy/pr-state.ts`, currently mapped to the action `write-manifest-with-pr-head-ref-and-requeue`) calls the rewrite itself for queued tasks and logs it, so the class disappears from the digest.

## Acceptance Criteria

- [ ] `cli-dispatch write-manifest <task> --branch <head>` succeeds when `queue/<task>.json` exists and the task is not inflight, replacing the manifest's `branch` and leaving other fields intact; it still refuses with the existing message when the task is inflight.
- [ ] `cli-dispatch write-manifest <task> --from-pr <n>` (or equivalent) sets `branch` from the PR head.
- [ ] The tick classifies `manifest-branch-mismatch` on a queued task, rewrites the manifest from the PR head, and reports it in the digest; an inflight mismatch is reported only.
- [ ] Tests cover queued-replace, inflight-refuse and tick auto-repair.
- [ ] Task file moved to `backlog/completed/` in the PR.
