---
id: AISDLC-1199
title: 'Automatic resume note no longer contradicts the review-delta path'
status: Done
assignee: []
created_date: '2026-11-06'
labels:
  - hierarchy defect triage
dependencies: []
references:
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/hierarchy/executor-start.ts
priority: medium
dispatchable: true
dispatchableReason: 'Unparked 2026-11-07 by operator ruling (planner critical-path review).'
---

## Description

**Source.** Planner session 2026-11-05/06; filed on operator go (decision rubric, 2026-11-06). Triaged; Unparked 2026-11-07 by operator ruling (planner critical-path review).

A re-entered task carries an automatic resume note built by `stallResumeNote` in `pipeline-cli/src/hierarchy/stall.ts` (around line 168: "Pull request #N already exists; continue from it and do not re-run the developer."), not in `reenter.ts`; `executor-start.ts` surfaces it. The note tells the executor "do not re-run the developer", while the review-delta resume path can require a developer round. The executor gets contradictory instructions.

## Acceptance Criteria
- [x] #1 The resume note is derived from the resume path it accompanies; a path that may run the developer never carries "do not re-run the developer".
- [x] #2 A test covers the note for each resume path.

## Final Summary

## Summary
stallResumeNote now derives its wording from the stalled step. Post-implementation steps (numbered 10 or later, or review, ship, sign or merge) keep 'do not re-run the developer'. Earlier or unknown steps say to run the developer only if the work is incomplete or a review round requires it. A new test in stall.test.ts covers each path.

## Changes
- pipeline-cli/src/hierarchy/stall.ts
- pipeline-cli/src/hierarchy/stall.test.ts
- backlog/tasks/AISDLC-1199 - automatic resume note no longer contradicts the review-delta path.md

## Design decisions
I ran only the stall tests, eslint on stall.ts, tsc --noEmit and prettier, not the full pnpm suite, so build is marked skipped. The pre-push hook passed. I only changed stallResumeNote; reenter.ts and executor-start.ts are untouched. The step-to-path mapping is a heuristic on the heartbeat step string (leading number 10 or higher, or a review/ship/sign/merge name). The task file under backlog/tasks/ was already modified when I started, and I included it in the commit.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

