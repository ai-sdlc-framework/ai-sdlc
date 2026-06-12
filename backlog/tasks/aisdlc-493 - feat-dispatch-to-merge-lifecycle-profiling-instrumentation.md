---
id: AISDLC-493
title: >-
  feat: dispatch→merge lifecycle profiling — phase-event instrumentation +
  full dispatch-to-merge timing + estimate calibration
status: To Do
assignee: []
created_date: '2026-05-31'
labels:
  - profiling
  - orchestrator
  - rfc-0015
  - estimation
dependencies:
  - AISDLC-479
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Instrument the FULL task-dispatch→PR-merge lifecycle so we can (a) build planning estimates that improve as data accumulates, and (b) measure whether PR-resolution work (rebase / re-sign / reconcile) is reducing or increasing dispatch→merge velocity. Motivating worst case: the 2026-05-31 attestation re-sign saga where dev-agent work finished in ~15 min but dispatch→merge took 6+ hours across ~10 re-sign cycles — and NONE of that tail is currently captured.

## Audit finding (what AISDLC-479 / PR #774 shipped vs. the gap)

AISDLC-479 added `OrchestratorCompleted`/`OrchestratorFailed` events, `writeTimedVerdict`/`emitTaskCompletion` (pipeline-cli/src/orchestrator/profiling.ts), a `cli-orchestrator-corpus profile` aggregator, and bucket-based estimate calibration (pipeline-cli/src/estimation/calibration-writer.ts). TWO problems:

1. DEAD WIRING: `writeTimedVerdict` is exported but NEVER called in the orchestrator hot path. `loop.ts` emits raw `OrchestratorCompleted` WITHOUT `durationMs` — so even the dev-agent phase #479 claimed to capture is not actually recorded in production.
2. POST-DEV is dark: reviewer phase, attestation sign, PR-opened, reconcile/rebase/re-sign cycles, CI-wait, and dispatch→merge total are all uncaptured.

Phase coverage today: dispatchedAt ✓(manifest) → dev-done ✗(broken wiring) → reviewed ✗ → signed ✗ → PR-opened ✗ → reconcile×N ✗(THE target) → CI-green ✗ → mergedAt ~(sweep, never joined to dispatchedAt).

## Design (decided)

RECORDING ARCHITECTURE: phase events to the existing append-only events stream (artifacts/_orchestrator/events-*.jsonl), joined at read time by the aggregator — NOT a single mutable per-task record. Rationale: dispatch→merge spans multiple processes/sessions and hours; the merge happens in GitHub (a late, retroactive join), exactly the DORA "lead time for changes" pattern. A mutated-across-processes record reintroduces the stale-data / hand-fabrication failure mode (the 2026-05-31 ad-hoc parallel-run-*.jsonl that was hand-appended with speculative/invented merge timestamps and had to be deleted). Append-only emission at hooks makes hand-fabrication structurally impossible.

- Pre-PR phases → extend the verdict file (dispatch-verdict.v1.schema.json already has dispatchedAt/completedAt/durationMs).
- Post-PR phases → new events.
- Merge captured retroactively: Step-0 sweep emits `DispatchToMergeCompleted` when it discovers a merged worktree, joining manifest.dispatchedAt with `gh pr view --json mergedAt` → totalLifecycleMs.

## Scope

### 1. Fix the AISDLC-479 dead wiring (prerequisite)
Wire `writeTimedVerdict` into `loop.ts` (~line 1351, the `OrchestratorCompleted` emit) so `durationMs` is actually written. `manifest.dispatchedAt` is already in scope.

### 2. Pre-PR phase fields (extend dispatch-verdict.v1.schema.json — additive)
Add (and populate at the relevant Step 0-13 points): `reviewerStartedAt`, `reviewerCompletedAt`, `signedAt`, `prOpenedAt`.

### 3. Post-PR phase events (new OrchestratorEventType + orchestrator-events.v1.schema.json)
- `PrOpened { taskId, runId?, prUrl, prOpenedAt }` — emitted at Step 11 (gh pr create/ready).
- `ReconcileCompleted { taskId, prUrl, rebased:bool, reSignCount:int, reconcileDurationMs }` — emitted per reconcile pass in orchestrator/reconcile.ts. N cycles = N events (directly counts resolution overhead).
- `DispatchToMergeCompleted { taskId, dispatchedAt, mergedAt, totalLifecycleMs, ciWaitMs? }` — emitted by Step-0 sweep (steps/00-sweep.ts, which already fetches mergedAt) joining dispatchedAt anchor.

### 4. CI-wait (retroactive, no webhook)
Augment the Step-0 sweep's `gh pr view --json mergedAt` with `gh run list --branch <b> --json conclusion,startedAt,completedAt` to derive CI-green time at merge-discovery. Coarse but free; no blocking poll.

### 5. Aggregator + estimation
- Extend `cli-orchestrator-corpus profile` to compute per-PHASE percentiles (dev, reviewer, sign, reconcile-overhead, CI-wait, total) and reconcile-cycle counts.
- Extend `calibration-writer.ts` bucket logic to calibrate TOTAL dispatch→merge lifecycle (not just dev-duration), so planning estimates reflect real merge time and improve as samples accumulate.

### 6. No hand-written records
Instrumentation emits at hooks; humans/agents NEVER append to profiling files. Remove/forbid any hand-write path to artifacts/_profiling/*. (The 2026-05-31 ad-hoc parallel-run jsonl is deleted; this task ensures it's not resurrected.)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `writeTimedVerdict` wired into loop.ts so `durationMs` is actually emitted on OrchestratorCompleted (the AISDLC-479 dead-wiring fix); hermetic test asserts durationMs is present
- [ ] #2 Verdict schema extended (additive) with reviewerStartedAt/reviewerCompletedAt/signedAt/prOpenedAt; populated at the corresponding Step 0-13 points
- [ ] #3 `PrOpened`, `ReconcileCompleted`, `DispatchToMergeCompleted` event types added to OrchestratorEventType + orchestrator-events.v1.schema.json; emitted at the specified hooks
- [ ] #4 `DispatchToMergeCompleted` correctly joins manifest.dispatchedAt with gh mergedAt → totalLifecycleMs (hermetic test with a fixture merged worktree)
- [ ] #5 `ReconcileCompleted` emitted per reconcile pass with reSignCount + reconcileDurationMs; N reconcile cycles produce N events
- [ ] #6 CI-wait derived retroactively in the sweep (no blocking poll, no webhook); ciWaitMs on DispatchToMergeCompleted (best-effort, null-tolerant)
- [ ] #7 `cli-orchestrator-corpus profile` reports per-phase percentiles + reconcile-cycle counts + dispatch→merge total
- [ ] #8 Estimate calibration buckets TOTAL dispatch→merge lifecycle; estimates improve with accumulated samples
- [ ] #9 No hand-write path to artifacts/_profiling/* remains; all records emitted by instrumentation hooks
- [ ] #10 Hermetic tests for every new event + the aggregator phase math; existing profiling/calibration tests still green
<!-- AC:END -->

## References
- AISDLC-479 (PR #774 — base profiling instrumentation this extends/fixes)
- pipeline-cli/src/orchestrator/profiling.ts (writeTimedVerdict — dead wiring to fix)
- pipeline-cli/src/orchestrator/loop.ts (~line 1351 OrchestratorCompleted emit)
- orchestrator/src/orchestrator/reconcile.ts (ReconcileCompleted hook)
- pipeline-cli/src/steps/00-sweep.ts (DispatchToMergeCompleted + CI-wait join)
- pipeline-cli/src/steps/11-push-and-pr.ts (PrOpened)
- pipeline-cli/src/estimation/calibration-writer.ts (lifecycle bucket calibration)
- spec/schemas/dispatch-verdict.v1.schema.json, spec/schemas/orchestrator-events.v1.schema.json
- spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
