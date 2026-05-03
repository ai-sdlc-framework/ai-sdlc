---
id: AISDLC-169.3
title: 'Phase 3: Pre-dispatch filters'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0015
  - phase-3
  - pre-dispatch
  - admission
milestone: m-3
dependencies:
  - AISDLC-169.2
parent_task_id: AISDLC-169
references:
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
  - pipeline-cli/src/dor/
  - pipeline-cli/src/deps/
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0015. Wire the three pre-dispatch admission filters from §4.3 — **dependency readiness** (`cli-deps blockers`), **DoR readiness** (RFC-0011 verdict), **external-dependency clearance** (RFC-0014 Q3 informational gate) — plus the exponential-backoff polling cadence for empty-frontier and peak-blocked states (Q3/Q5). Estimated 0.5 weeks.

Per RFC §4.3: a candidate that fails any filter is requeued for the next tick — no human notification unless the same task is skipped >5 ticks (then emit `OrchestratorStuckCandidate` so the operator can investigate).

## Open-question resolutions implemented in this phase

- **Q3 (peak-blocked sleep cadence):** Exponential backoff capped at 5min. Start at configured `tickIntervalSec` (default 30s), double after each idle tick (`OrchestratorIdleWaitingForOffPeak` event), cap at 5min. Reset to base interval immediately when SubscriptionLedger transitions to allowing dispatch OR a new task lands in `backlog/tasks/` (next non-idle tick).
- **Q5 (no-work backoff cadence):** Same curve as Q3 (30s base, double per idle tick, 5min cap). Distinguished only by event type: `OrchestratorIdleNoWork` vs `OrchestratorIdleWaitingForOffPeak`. Operator can grep events.jsonl by type for forensic distinction.
- **Q3 (external-dependency `OrchestratorAwaitingExternal`):** RFC-0014 Q3 added `externalDependencies:` as informational; Phase 3 gates on entries with `kind: 'manual'` AND no operator-provided clearance signal. Skip with `OrchestratorAwaitingExternal` event. Other kinds (`npm-version`, `github-pr`, `url-head`) are surfaced but NOT a dispatch gate in v1.

## Filter chain (per RFC §4.3)

For each candidate (in `effectivePriority DESC → criticalPathLength DESC → recency DESC` order from RFC-0014 Q1):

1. **Dependency readiness** — invoke `cli-deps blockers <id>`; require empty result (all upstream tasks Done OR Cancelled). Skip with `OrchestratorBlockedByDependency{blockers}` if not.
2. **DoR readiness** — read task's most recent `RefinementVerdict` (per `refinement-verdict.v1.schema.json`); require `verdict: 'admit'`. Skip with `OrchestratorBlockedByDor{verdict}` if `needs-clarification`. RFC-0011 §7.4 `dor-bypass` label honored — bypassed tasks dispatch as if `admit` (with the FYI-shaped blast-radius comment per RFC-0014 Q5).
3. **External-dependency presence** — parse task's `externalDependencies:` frontmatter; if any entry has `kind: 'manual'` AND no operator-provided clearance, skip with `OrchestratorAwaitingExternal{externalDeps}`. Other kinds are surfaced in the event but not a dispatch gate.

A candidate skipped >5 ticks emits `OrchestratorStuckCandidate{taskId, reason, ticksSinceFirstSkip}` so the operator can investigate. Counter is per-task, persisted in `$ARTIFACTS_DIR/_orchestrator/state.json` (the orchestrator-wide state file from RFC §8).

## Backoff state machine

Global polling-cadence state lives on the orchestrator (NOT per-worker — it's a global concern):

```
state: { currentInterval: tickIntervalSec, lastDispatchTick: <ts>, idleStreak: 0 }

on tick start:
  if dispatched_count > 0: reset state.currentInterval = tickIntervalSec, idleStreak = 0
  else if idle_reason == NoWork: emit OrchestratorIdleNoWork; idleStreak++; currentInterval = min(currentInterval*2, 5min)
  else if idle_reason == OffPeak: emit OrchestratorIdleWaitingForOffPeak; idleStreak++; currentInterval = min(currentInterval*2, 5min)
  sleep(currentInterval)
```

## Filter trace logging

Every filter decision (admit OR skip with reason) writes a structured trace entry to events.jsonl:

```json
{ "ts": "...", "event": "FilterTrace", "taskId": "AISDLC-N", "filter": "DependencyReadiness|DorReadiness|ExternalDependencies", "verdict": "admit|skip", "reason": "..." }
```

This makes Phase 3's behavior fully auditable from the event stream alone.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Filter 1 (dependency readiness): every candidate passes through `cli-deps blockers <id>` before dispatch; non-empty result skips with `OrchestratorBlockedByDependency{blockers}` event and requeues for next tick
- [ ] #2 Filter 2 (DoR readiness): every candidate's most recent `RefinementVerdict` (per RFC-0011 `refinement-verdict.v1.schema.json`) read; only `verdict: 'admit'` proceeds; `needs-clarification` skips with `OrchestratorBlockedByDor{verdict}` event. RFC-0011 §7.4 `dor-bypass` label honored — bypassed tasks dispatch as if `admit`
- [ ] #3 Filter 3 (external-dependency clearance): every candidate's `externalDependencies:` frontmatter parsed; entries with `kind: 'manual'` AND no operator-provided clearance signal skip with `OrchestratorAwaitingExternal{externalDeps}` event. Other kinds (`npm-version`, `github-pr`, `url-head`) surfaced in the event but NOT a dispatch gate in v1
- [ ] #4 Stuck-candidate detection: a candidate skipped >5 ticks emits `OrchestratorStuckCandidate{taskId, reason, ticksSinceFirstSkip}`; counter persisted in `$ARTIFACTS_DIR/_orchestrator/state.json` so the orchestrator survives restart without losing the streak
- [ ] #5 Q3+Q5 backoff cadence: exponential backoff 30s base → 5min cap, doubling per idle tick; resets to base interval immediately on dispatch OR new task arrival; idle reasons distinguished by event type (`OrchestratorIdleNoWork` vs `OrchestratorIdleWaitingForOffPeak`)
- [ ] #6 Filter trace logging: every filter decision (admit OR skip) writes a `FilterTrace` event to events.jsonl with `{taskId, filter, verdict, reason}` — Phase 3 behavior fully auditable from the event stream
- [ ] #7 Phase 3 acceptance fixture (per RFC §11 Phase 3): filter trace logged correctly; `OrchestratorAwaitingExternal` event fires correctly on a synthetic external-dep candidate; backoff curve verified by injecting empty-frontier ticks and asserting interval doubles
- [ ] #8 Hermetic tests cover each filter independently (dependency-blocker fixture, DoR `needs-clarification` fixture, external-dep `manual` fixture), the stuck-candidate counter persistence across simulated restart, and the backoff state machine (reset on dispatch, reset on new task, cap at 5min)
- [ ] #9 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->
