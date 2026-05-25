---
id: AISDLC-291
title: 'feat: RFC-0035 Phase 7 — Capacity model + fatigue signal + decisions-config.yaml'
status: Done
assignee:
  - claude-opus-4-7
created_date: '2026-05-15'
updated_date: '2026-05-24'
labels:
  - rfc-0035
  - decision-catalog
  - phase-7
  - critical-path
dependencies:
  - AISDLC-285
  - AISDLC-306
  - AISDLC-283
references:
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
priority: high
blocked:
  reason: 'RFC-0035 14/14 OQs resolved per 2026-05-15 walkthrough; lifecycle is Ready for Review awaiting per-owner sign-off. Phase 7 implementation proceeds under operator-acknowledged upstream-OQ override — same pattern as sibling Phase 5 (AISDLC-289) and Phase 6 (AISDLC-290).'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 7 of RFC-0035 Implementation Plan (§14). Capacity composes with RFC-0016 calibrated t-shirt sizes (per OQ-6 resolution). Fatigue signal is non-blocking: defaults auto-apply, operator catches up retroactively (per fatigue-aware non-blocking convention).

## Scope

- Capacity model uses RFC-0016 calibrated t-shirt size as per-decision cost estimate
- Fatigue signal exposed via `cli-decisions fatigue {set, clear, status}`
- Decisions auto-deferred while fatigue set; defaults applied per OQ resolution
- `decisions-config.yaml` schema: per-org configurable timeboxes + thresholds
- Operator catches up retroactively via 24h override window from Phase 5
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Capacity model uses RFC-0016 calibrated t-shirt size as per-decision cost estimate
- [x] #2 Fatigue signal exposed via `cli-decisions fatigue {set, clear, status}`
- [x] #3 Decisions auto-deferred while fatigue set; defaults applied per OQ resolution
- [x] #4 `decisions-config.yaml` schema: timeboxes + thresholds + override window all per-org configurable
- [x] #5 Operator catches up retroactively (override window from Phase 5)
- [x] #6 Schema documented in adopter-facing README
<!-- AC:END -->

## Final Summary

### Summary

Phase 7 of RFC-0035 ships the operator capacity + fatigue model. Capacity composes
with RFC-0016 t-shirt sizes (per OQ-6 resolution: no parallel sizing taxonomy);
fatigue follows OQ-8's explicit-by-default contract with opt-in inferred fatigue.
The `decisions-config.yaml` schema gains four new blocks (capacity, fatigue,
load-bearing formula selector, plus an existing override-window) — every threshold
is per-org configurable. `cli-decisions fatigue {set, clear, status}` is wired and
the legacy `rfc0035FatigueSignal: false` seam in `tui/analytics/operator-time-cost.ts`
is flipped on now that the underlying state file exists.

### Changes

- `pipeline-cli/src/decisions/fatigue.ts` (new): operator-state.yaml load/save,
  setFatigue / clearFatigue / getFatigueStatus, tier-aware
  `dispatchUnderFatigue()` per §7.2.
- `pipeline-cli/src/decisions/decisions-config.ts` (modified): adds
  DecisionsCapacityConfig + FatigueConfig types + resolve helpers +
  DEFAULT_CAPACITY_TIERS / DEFAULT_FATIGUE_CONFIG constants.
- `pipeline-cli/src/decisions/index.ts` (modified): re-exports fatigue module.
- `pipeline-cli/src/cli/decisions.ts` (modified): adds
  `cli-decisions fatigue {set, clear, status}` subcommands; the verbs are
  independent of the catalog feature flag.
- `pipeline-cli/src/tui/analytics/operator-time-cost.ts` (modified): the
  Phase-5 gated seam `rfc0035FatigueSignal: false` is widened to `boolean` and
  reads explicit operator state when `workDir` is supplied.
- `pipeline-cli/docs/decisions-config.md` (new): adopter-facing schema reference
  (AC#6).
- `pipeline-cli/README.md` (modified): links the new adopter doc.
- Tests: `fatigue.test.ts` (new, 24 tests); extended
  `decisions-config.test.ts`, `operator-time-cost.test.ts`, `cli/decisions.test.ts`.

### Design decisions

- **OQ-6 compose-with-RFC-0016**: introduced `DecisionsCapacityConfig` rather
  than re-naming `CapacityConfig` (already exported by stage-a.ts for runtime
  arithmetic). Both names coexist behind the `decisions/index.ts` barrel
  without conflict.
- **Atomic save**: `saveOperatorState()` uses tmp-file + rename to avoid
  corrupting state mid-write under crash.
- **Inferred fatigue is opt-in (OQ-8)**: `fatigue.inferFromBehavior: false`
  by default. `getFatigueStatus()` accepts an `inferredSignal` parameter from
  the caller rather than computing it inline — keeps the read path pure
  and lets analytics modules plug in their own signals.
- **`dispatchUnderFatigue()` blocking-critical precedence**: a blocking-critical
  small reversible LLM-eligible decision surfaces to the operator rather
  than auto-deciding, per §7.2's "surface only blocking-critical small
  decisions" wording.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean (tsc -p tsconfig.build.json)
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 274 files, 5239 passed, 1 skipped
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up

The orchestrator tick + TUI decisions-pending pane wiring (Phase 8) will
consume `dispatchUnderFatigue()` to honour `defer` / `surface-blocking` /
`auto-decide` dispositions. That integration is owned by Phase 8 / AISDLC-294.
