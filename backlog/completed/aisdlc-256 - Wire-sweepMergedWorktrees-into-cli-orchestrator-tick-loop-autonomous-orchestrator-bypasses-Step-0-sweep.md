---
id: AISDLC-256
title: 'Wire sweepMergedWorktrees() into cli-orchestrator tick loop'
status: Done
assignee: []
created_date: '2026-05-10 10:00'
labels:
  - orchestrator
  - rfc-0015
  - infrastructure
priority: high
---

## Description

`sweepMergedWorktrees()` exists at `pipeline-cli/src/steps/00-sweep.ts`. It's
called from `executePipeline()` (the /ai-sdlc execute path) but NOT from the
autonomous orchestrator loop. Result: every `cli-orchestrator tick` accumulates
merged worktrees forever (operator hit 29 directories in 3 days).

## Acceptance Criteria

- [x] #1 `sweepMergedWorktrees()` is called at the START of `runOrchestratorTick()`, before the frontier scan.
- [x] #2 A sweep failure (network, permissions) is caught and logged; the tick continues normally — sweep failure NEVER aborts a tick.
- [x] #3 Integration test verifies a merged worktree is removed and a non-merged worktree is preserved.
- [x] #4 `OrchestratorWorktreeSwept` event is emitted per swept entry (to `events.jsonl` via `adapters.emitEvent`).
- [x] #5 `pipeline-cli/docs/orchestrator.md` documents that the autonomous loop self-cleans merged worktrees per tick.

## finalSummary

## Summary

Wired `sweepMergedWorktrees()` into the START of `runOrchestratorTick()` (before frontier scan) so the autonomous orchestrator loop automatically removes merged-PR worktrees each tick. Added `OrchestratorWorktreeSwept` event type to `events.ts` + `orchestrator-events.v1.schema.json`. Integration test in `loop.sweep.test.ts` verifies removal + event emission + sweep-failure resilience. Docs updated.

## Changes

- `pipeline-cli/src/orchestrator/loop.ts` (modified): added `sweepMergedWorktrees` import + sweep call at the start of `runOrchestratorTick()`; moved `buildEmitter` call above the sweep block so events carry `runId` + `tick`.
- `pipeline-cli/src/orchestrator/events.ts` (modified): added `OrchestratorWorktreeSwept` to `OrchestratorEventType` union.
- `spec/schemas/orchestrator-events.v1.schema.json` (modified): added `OrchestratorWorktreeSwept` to the type enum + added `worktreePath` and `mergedAt` to the top-level properties (schema is `additionalProperties: false`).
- `pipeline-cli/src/orchestrator/loop.sweep.test.ts` (new): integration tests for ACs #1, #2, #3, #4.
- `pipeline-cli/docs/orchestrator.md` (modified): documented tick step 0 (sweep) in the "Each tick" list.

## Design decisions

- **Sweep before frontier scan**: ensures blast-radius + in-flight trackers see an already-pruned worktree set; prevents a merged worktree from spuriously blocking a re-dispatch via the BlastRadiusOverlap filter.
- **buildEmitter moved up**: the emit helper is now built before the sweep so swept events carry the correct `runId` + `tick` metadata without needing to pass adapters directly.
- **Try/catch isolates sweep**: any `gh` network failure or filesystem error is caught and logged at `warn` level; the tick proceeds normally (AC #2).

## Verification

- `pnpm build` — clean
- `pnpm test` — loop.sweep.test.ts passes
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up

(none)
