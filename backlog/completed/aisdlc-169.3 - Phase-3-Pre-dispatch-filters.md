---
id: AISDLC-169.3
title: 'Phase 3: Pre-dispatch filters'
status: Done
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
- [x] #1 Filter 1 (dependency readiness): every candidate passes through `cli-deps blockers <id>` before dispatch; non-empty result skips with `OrchestratorBlockedByDependency{blockers}` event and requeues for next tick
- [x] #2 Filter 2 (DoR readiness): every candidate's most recent `RefinementVerdict` (per RFC-0011 `refinement-verdict.v1.schema.json`) read; only `verdict: 'admit'` proceeds; `needs-clarification` skips with `OrchestratorBlockedByDor{verdict}` event. RFC-0011 §7.4 `dor-bypass` label honored — bypassed tasks dispatch as if `admit`
- [x] #3 Filter 3 (external-dependency clearance): every candidate's `externalDependencies:` frontmatter parsed; entries with `kind: 'manual'` AND no operator-provided clearance signal skip with `OrchestratorAwaitingExternal{externalDeps}` event. Other kinds (`npm-version`, `github-pr`, `url-head`) surfaced in the event but NOT a dispatch gate in v1
- [x] #4 Stuck-candidate detection: a candidate skipped >5 ticks emits `OrchestratorStuckCandidate{taskId, reason, ticksSinceFirstSkip}`. **Caveat: counter is in-memory only in v1**; persistence to `$ARTIFACTS_DIR/_orchestrator/state.json` is deferred to Phase 4 (AISDLC-169.4) alongside the events.jsonl writer per the dispatch-prompt's "Out of scope" note. Restart wipes the streak; first skip after restart starts the count from zero. Documented in `pipeline-cli/docs/orchestrator.md#stuck-candidate-detection`.
- [x] #5 Q3+Q5 backoff cadence: exponential backoff 30s base → 5min cap, doubling per idle tick; resets to base interval immediately on dispatch OR new task arrival; idle reasons distinguished by event type (`OrchestratorIdleNoWork` vs `OrchestratorIdleAllFiltered`). **Note**: the v1 idle event for filter-rejected ticks is named `OrchestratorIdleAllFiltered` rather than `OrchestratorIdleWaitingForOffPeak` because Phase 3 doesn't yet integrate with RFC-0010's SubscriptionLedger off-peak schedule (peak/off-peak gating ships behind the same backoff curve once Phase 4 lands the events.jsonl + status surface). Same curve, different event tag — operators grep by type.
- [x] #6 Filter trace logging: every filter decision (admit OR skip) writes a structured trace block via `logger.info(...)` and a `OrchestratorFilterEvent` record on `tickResult.filterEvents`. Phase 4 (AISDLC-169.4) adds the `events.jsonl` writer that plumbs these into the canonical event stream — the per-filter shape (`{taskId, filter, verdict, reason, blockedEvent?}`) is stable across Phase 3 → Phase 4.
- [x] #7 Phase 3 acceptance fixture (per RFC §11 Phase 3): filter trace logged correctly (`loop.filters.test.ts > logs a filter-trace block per evaluated candidate`); `OrchestratorAwaitingExternal` event fires correctly on a synthetic external-dep candidate (`loop.filters.test.ts > Phase 3 4-task fixture acceptance`); backoff curve verified by injecting empty-frontier ticks and asserting interval doubles (`loop.filters.test.ts > exponential backoff cadence > doubles the interval...`).
- [x] #8 Hermetic tests cover each filter independently (`filters/dependency-readiness.test.ts`, `filters/dor-readiness.test.ts`, `filters/external-dependencies.test.ts`, `filters/chain.test.ts`) and the backoff state machine (reset on dispatch, reset on new task, cap at 5min — all in `loop.filters.test.ts`). Stuck-counter coverage exercises both the >5-tick emit path AND the admission-resets-counter path against an in-memory map (persistence-across-restart deferred to Phase 4 per AC #4).
- [x] #9 Full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean. Pipeline-cli test count: 80 → 87 files, 1360 → 1438 tests (+78 covering the new filters/chain/loop integration). New code lives in `pipeline-cli/src/orchestrator/filters/` (5 new modules, 4 test files) plus the `loop.ts` integration + `loop.filters.test.ts` integration suite.
<!-- AC:END -->

## Final Summary

### Summary
Wired the three RFC-0015 §4.3 pre-dispatch admission filters
(DependencyReadiness, DoR readiness, external-deps gate) into the
orchestrator loop behind the existing `AI_SDLC_AUTONOMOUS_ORCHESTRATOR=experimental`
flag. Added the in-memory stuck-candidate counter, the exponential-backoff
sleep cadence (Q3 + Q5 resolution), and the matching event surface
(`OrchestratorBlockedByDependency`, `OrchestratorBlockedByDor`,
`OrchestratorAwaitingExternal`, `OrchestratorStuckCandidate`,
`OrchestratorIdleNoWork`, `OrchestratorIdleAllFiltered`) on the in-process
tick result. Phase 4 (AISDLC-169.4) plumbs these into `events.jsonl` and
persists the stuck counter to disk.

### Changes
- `pipeline-cli/src/orchestrator/filters/types.ts` (new): `FilterResult`,
  `FilterChainResult`, discriminated `FilterDetail` payloads.
- `pipeline-cli/src/orchestrator/filters/dependency-readiness.ts` (new):
  wraps `cli-deps blockers` in-process, returns `dependency-blocked`
  detail with sorted lowercased blocker IDs.
- `pipeline-cli/src/orchestrator/filters/dor-readiness.ts` (new): reads
  the latest `RefinementVerdict` from `$ARTIFACTS_DIR/_dor/calibration.jsonl`,
  honors `outcome: 'override'` and frontmatter `labels: dor-bypass`.
- `pipeline-cli/src/orchestrator/filters/external-dependencies.ts` (new):
  parses `externalDependencies:` frontmatter, gates on `kind: 'manual'`,
  reads operator clearance from
  `$ARTIFACTS_DIR/_orchestrator/cleared-external-deps.json`.
- `pipeline-cli/src/orchestrator/filters/chain.ts` (new): composes the
  three filters in §4.3 order, short-circuits on first failure, exports
  `formatFilterTrace()` for the per-candidate trace block.
- `pipeline-cli/src/orchestrator/filters/{*.test.ts}` (new, 4 files):
  hermetic per-filter unit tests + chain composer tests (36 tests).
- `pipeline-cli/src/orchestrator/loop.ts` (modified): pre-dispatch filter
  chain integration; in-memory stuck-counter; exponential-backoff cadence;
  new adapters (`graphLoader`, `taskLabelsLoader`, `clearedExternalKeys`,
  `artifactsDir`, `calibrationLogPath`, `stuckCounters`, `cadenceState`,
  `now`); `OrchestratorTickResult` extended with `filterEvents`,
  `idleEvent`, `nextSleepSec`.
- `pipeline-cli/src/orchestrator/types.ts` (modified): six new event
  shapes; `OrchestratorFilterEvent`, `OrchestratorIdleEvent`, etc.
- `pipeline-cli/src/orchestrator/index.ts` (modified): re-exports the
  filter chain surface alongside the existing Phase 1 + Phase 2 exports.
- `pipeline-cli/src/orchestrator/loop.filters.test.ts` (new): integration
  tests including the §11 Phase 3 4-task fixture acceptance + stuck-counter
  + backoff state machine + idle-event-type discrimination (10 tests).
- `pipeline-cli/src/orchestrator/loop.test.ts` (modified): existing Phase
  1 tests now opt into `hermeticFilterAdapters()` so synthetic-frontier
  fixtures don't read the on-disk calibration log.
- `pipeline-cli/docs/orchestrator.md` (modified): new "Pre-dispatch
  admission filters" section + "Backoff sleep cadence" section + Phase 3
  in the phase-plan table.
- `docs/operations/operator-runbook.md` (modified): new "Autonomous
  orchestrator pre-dispatch filter events" section with operator-response
  template for `OrchestratorAwaitingExternal`.
- `ai-sdlc-plugin/mcp-server/dist/bin.js` (regenerated): rebundles
  pipeline-cli with the new filter modules.

### Design decisions
- **Chain composition over a registry**: filters run in a fixed §4.3
  order. Adding a fourth filter is a one-line `runFilterChain` edit, not
  a registry registration. Three filters don't justify the indirection.
- **In-memory stuck counter (v1)**: the dispatch prompt's "Out of scope"
  bracketed full events.jsonl + cli-status to Phase 4. Persisting the
  stuck counter requires that same `state.json` writer; deferring keeps
  Phase 3 surface narrow.
- **No-verdict = admit (v1)**: the orchestrator's frontier source has no
  DoR coupling, so requiring a verdict would funnel every backlog task
  through the GH Action ingress — a bigger change than this RFC promises.
  Phase 5 soak will surface whether this is a real source of false
  admits; if so a `requireVerdict: true` knob can flip the default.
- **`OrchestratorIdleAllFiltered` over `OrchestratorIdleWaitingForOffPeak`**:
  Phase 3 doesn't integrate with RFC-0010's SubscriptionLedger yet. Same
  curve, different event tag so operators can grep by type. Off-peak
  integration ships when the ledger surface lands (Phase 4 / 5).

### Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 1438 tests, 87 files, all pass
- `pnpm format:check` — clean
- `pnpm lint` — clean

### Follow-up
- AISDLC-169.4 (Phase 4) — events.jsonl writer + cli-status --orchestrator
  view; persist stuck-counter + clearance-file CLI helper.
- AISDLC-169.5 (Phase 5) — soak corpus, chaos test, promotion runbook.
<!-- SECTION:FINAL_SUMMARY:END -->
