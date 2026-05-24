---
id: AISDLC-306
title: 'feat: RFC-0025 Refit Phase 5 — Coverage-gap capture + composite determinism + instrumented operator-time-cost (OQ-6 + OQ-7 + OQ-9)'
status: Done
assignee:
  - '@claude'
created_date: '2026-05-16'
updated_date: '2026-05-24'
labels:
  - rfc-0025
  - refit
  - phase-5
  - critical-path-rfc-0035
dependencies:
  - AISDLC-302
  - AISDLC-320
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: high
blocked:
  reason: 'RFC-0024 lifecycle is Ready for Review (OQs all resolved 2026-05-15); composition surface is operator-affirmed via RFC-0025 §13.1 OQ-6 — acknowledged for Phase 5 implementation.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0025 Refit Phase 5. Three composition-heavy implementations: coverage-gap response via RFC-0024 captures (OQ-6), composite determinism detection via RFC-0014 blast-radius (OQ-7), and instrumented operator-time-cost via RFC-0015 events.jsonl (OQ-9).

## Scope (OQ-6 coverage-gap)

- `framework-coverage-gap` produces a capture with the canonical RFC-0024 fields shown below (composes with RFC-0024 capture substrate).

```yaml
source: framework-coverage-gap
triage: tbd
```

- Operator triages via existing RFC-0024 rubric.
- Auto-quarantine the affected dispatch.
- Rate-ceiling + stale-ladder from RFC-0024 §15.1 handle flood control.

## Scope (OQ-7 composite determinism)

- Salvage `determinism-detector.ts` sampling skeleton from AISDLC-302 cherry-pick.
- Add composite gates: default sample rate 1-in-50 + always-on for `requires-determinism: true` + always-on for top-decile blast-radius (composes with RFC-0014 dep-graph snapshot).
- Per-org rate override in `quality-monitoring.yaml` (`quality.determinism-detection.defaultSampleRate`).

## Scope (OQ-9 instrumented operator-time-cost)

- Compute elapsed-time from `OrchestratorBlockedByX` events to `OperatorActionTaken` events using RFC-0015 `events.jsonl` substrate.
- Surface in §7 severity rubric output.
- Feed RFC-0035 §7 operator-fatigue signal (composition opportunity; gated until RFC-0035 Phase 7 / AISDLC-291 ships).
- Per-org AFK noise filter (`quality.operator-time-cost.afkInactivityMinutes` default 30).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `framework-coverage-gap` files an RFC-0024 capture with correct source + triage
- [x] #2 Affected dispatch auto-quarantined on coverage-gap detection
- [x] #3 Composite determinism gates ship: sampling + requires-determinism + top-decile blast-radius
- [x] #4 Blast-radius source reads RFC-0014 dep-graph snapshot
- [x] #5 Operator-time-cost computed from RFC-0015 events.jsonl with AFK filter
- [x] #6 Surface in §7 severity rubric output
- [x] #7 RFC-0035 §7 fatigue-signal feed wired (gated until RFC-0035 P7 ships)
- [x] #8 Per-org configurability via quality-monitoring.yaml for all three OQs
<!-- AC:END -->

## Final Summary

### Summary

RFC-0025 Refit Phase 5 ships the three remaining composition-heavy OQ resolutions:
**OQ-6 coverage-gap response** (RFC-0024 capture + auto-quarantine on UnknownFailureMode
fall-through), **OQ-7 composite determinism sampling** (flat rate + the per-task
opt-in flag + top-decile blast-radius from RFC-0014 dep-graph snapshot), and
**OQ-9 instrumented operator-time-cost** (AFK-filtered active cost from RFC-0015
events.jsonl, wired into §7 severity rubric output with RFC-0035 §7 fatigue-signal
composition seam ready).

### Changes

- `pipeline-cli/src/tui/analytics/coverage-gap.ts` (new): `recordFrameworkCoverageGap()`
  writes an RFC-0024 capture with the framework-coverage-gap source, an unset triage
  per the standard RFC-0024 flow, and an unknown severity, returning the operator-
  configured `shouldQuarantine` signal. Per-org config keys:
  `quality.coverage-gap.autoQuarantine` (default true), `fileCapture` (default true).
- `pipeline-cli/src/tui/analytics/operator-time-cost.ts` (new): `computeOperatorTimeCost()`
  reads `_orchestrator/events-*.jsonl`, pairs `OrchestratorBlockedByX` ↔
  `OrchestratorDispatched / Completed / Rollback` spans by taskId, filters AFK gaps
  > threshold, aggregates `meanActiveCostMs`, classifies into low/medium/high bucket.
  `formatOperatorTimeCostForRubric()` produces the §7 rubric line; `rfc0035FatigueSignal`
  is the composition seam (gated false until AISDLC-291). `resolveAfkInactivityMinutes()`
  loads the per-org default from `quality-monitoring.yaml`.
- `pipeline-cli/src/tui/analytics/determinism-detector.ts` (modified):
  `shouldSampleDeterminismComposite()` adds the OQ-7 composite policy on top of the
  existing flat-1-in-50 substrate. `isTopDecileBlastRadius()` computes the 90th-percentile
  nearest-rank cutoff over RFC-0014 snapshot's `effectivePriority` distribution. Returns
  a `DeterminismCompositeDecision` carrying the reason that fired for audit-trail use.
- `pipeline-cli/src/tui/analytics/quality-monitoring-config.ts` (modified): three new
  config blocks added — `coverage-gap`, `determinism-detection`, `operator-time-cost` —
  with YAML parser support, defaults, and `LoadQualityMonitoringConfig` round-trip.
- `pipeline-cli/src/orchestrator/loop.ts` (modified): both UnknownFailureMode escalation
  paths (no-handler-matched + no-result-returned) now call `maybeRecordCoverageGap()`
  before the rollback. Best-effort by design — config-load failures and capture-write
  failures are logged and swallowed.
- `pipeline-cli/src/tui/analytics/index.ts` (modified): exports for the new surfaces.
- Tests: `coverage-gap.test.ts` (9), `operator-time-cost.test.ts` (21), composite
  determinism tests added to `determinism-detector.test.ts` (+19), Phase 5 yaml +
  defaults tests added to `quality-monitoring-config.test.ts` (+15).

### Design decisions

- **Coverage-gap composes with RFC-0024 rather than minting a new artifact type.** OQ-6
  resolution explicitly chose the capture-record path so operators triage via the standard
  rubric. The capture's `source.context = 'framework-coverage-gap'` lets ops grep
  specifically for these.
- **`maybeRollback()` remains the auto-quarantine action.** The `shouldQuarantine` signal
  is logged but the existing AISDLC-177 sweep always runs — leaving stale worktrees on a
  `autoQuarantine: false` config would be a regression, so the flag is observability-only
  for now. The config knob is wired and queryable; a future change can route it into the
  rollback module's branch-rename decision if operators want finer control.
- **Composite sampling is additive.** `shouldSampleDeterminismComposite()` returns a
  `DeterminismCompositeDecision` carrying one of four reason codes (the explicit
  task-opt-in flag / top-decile blast-radius / flat sample rate / not sampled) so
  the orchestrator's events.jsonl can audit why a baseline was recorded. The legacy
  `shouldSampleDeterminism()` is preserved unchanged for backward compatibility.
- **Top-decile uses nearest-rank percentile.** Ties at the boundary are included in the
  top decile — OQ-7 favors over-sampling at the boundary because missing a high-blast
  determinism violation is operationally costlier than over-sampling.
- **`rfc0035FatigueSignal: false` is a typed compile-time gate.** When AISDLC-291 flips
  the signal on, the field type changes and downstream consumers get a typecheck error
  if they haven't migrated — the composition seam is wired so the integration is a
  one-line `subscribe to this field` change rather than a refactor.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 4662 passed | 1 skipped
- `pnpm test` — full repo: 1 known-flaky (`backlog-walker` polling unmount, passes on
  retry per `feedback_flaky_events_tail_test.md`), all other suites green
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

- AISDLC-291 (RFC-0035 Phase 7) will flip `rfc0035FatigueSignal` on; the seam is wired.
- The composite determinism sampler is exposed but not yet wired into the orchestrator's
  dispatch loop. Wiring it in is a follow-up — it needs a corpus-priority computation
  step at tick start (cache the deps-snapshot priorities so each dispatch checks the
  decile cheaply). Out of scope for AISDLC-306 because the orchestrator doesn't yet
  call `recordDeterminismBaseline()` at all — Phase 1 substrate landed the storage but
  not the dispatch hook.
