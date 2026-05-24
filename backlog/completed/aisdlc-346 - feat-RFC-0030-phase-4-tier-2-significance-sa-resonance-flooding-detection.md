---
id: AISDLC-346
title: 'feat: RFC-0030 Phase 4 — Tier 2 significance threshold + SA resonance filter + flooding detection (catalog-routed)'
status: Done
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0030
  - signal-ingestion
  - phase-4
dependencies:
  - AISDLC-345
references:
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
blocked:
  reason: |
    RFC-0030 + RFC-0035 + RFC-0022 + RFC-0029 OQs all resolved (operator walkthroughs 2026-05-16);
    referenced RFCs at lifecycle 'Ready for Review' / 'Draft' pending operator promotion to 'Signed Off'.
    Predecessor tasks AISDLC-343 + AISDLC-344 + AISDLC-345 (Phase 1 + Phase 2 + Phase 3) landed
    under the same condition. Phase 4 is mechanical implementation of §8 + §9 + OQ-13.3 + OQ-13.5
    against the resolved OQs — no new design decisions.
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0030 §8 + §9 + OQ-13.5. Tier 2 significance threshold, SA resonance filter, adversarial flooding detection.

## Scope (RFC-0030 §8 + §9 + OQ-13.5)

- **Tier 2 significance threshold** per §8: cluster must meet `minSignalCount` + `minUniqueSources` + `minTier1SignalCount` + `minClusterAgeDays` before passing to D1.
- **SA resonance filter** per §9 + RFC-0029 Principle 4: high-SA = full weight; mid-SA = discounted; low-SA = excluded but logged for Product review (composes with catalog).
- **OQ-13.5 flooding detection:** suspicious volume spike + low source diversity → `Decision: signal-flooding-detected` → Stage A classifies severity (volume threshold + source-diversity threshold + per-source baseline drift) → auto-throttle low-confidence sources at per-org configurable threshold OR surface to operator batch review for high-severity cases. Pipeline never halts.
- **OQ-13.3 residency violation detection** (composes with RFC-0022): adapter detects signal subject to declared regime constraint not met → `Decision: signal-residency-violation` → refuse signal + log + emit `compliance.yaml regimeOverrides` clarification task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 Tier 2 significance threshold gate per §8 (minSignalCount + minUniqueSources + minTier1SignalCount + minClusterAgeDays)
- [x] #2 SA resonance filter per §9: full / discounted / excluded tiers
- [x] #3 Low-SA-but-high-volume signals logged via Decision for Product batch review (not silently dropped)
- [x] #4 OQ-13.5 flooding detection: volume + source-diversity + baseline-drift Stage A classification
- [x] #5 Flooding response: auto-throttle low-confidence OR operator-batch-surface high-severity
- [x] #6 OQ-13.3 residency violation: adapter-level detection → Decision + refuse + emit clarification task
- [x] #7 Pipeline never halts on flooding / residency / SA-zero events (all catalog-absorbed)
<!-- AC:END -->

## Final Summary

### Summary

Implemented RFC-0030 Phase 4: Tier 2 significance threshold, SA resonance filter, OQ-13.5 flooding detection, and OQ-13.3 residency-violation gate. The new `orchestrator/src/signal-ingestion/significance.ts` module consumes Phase 3 `DemandCluster[]` output and produces `SignificanceAssessedCluster[]` records carrying `tier2Significance` (`qualified` | `monitored`), `saResonanceBucket` (`full` | `discounted` | `low-sa-review` | `out-of-scope` | `pending`), the combined `eligibleForD1` flag, and the `d1WeightMultiplier` (per RFC-0030 §9). Flooding detection ships as `detectFlooding()` with three independent Stage A indicators (volume spike, low source diversity, per-source baseline drift); severity is the count of tripped indicators with responses `auto-throttle` / `auto-throttle-and-review` / `operator-review`. Residency gating ships as `checkSignalResidency()` + `filterSignalsByResidency()` for adapter-level enforcement composing with RFC-0022's regime declaration. All operator-impacting events emit `Decision` records (`signal-low-sa-for-review`, `signal-out-of-scope`, `signal-flooding-detected`, `signal-residency-violation`) for RFC-0035 G0 catalog routing — pipeline never halts.

### Changes

- `orchestrator/src/signal-ingestion/significance.ts` (new): Phase 4 surface — `assessTier2Significance`, `classifySaResonance`, `assessClusterSignificance`, `detectFlooding`, `checkSignalResidency`, `filterSignalsByResidency`, plus all Decision / config types and `DEFAULT_FLOODING_DETECTION_CONFIG`.
- `orchestrator/src/signal-ingestion/significance.test.ts` (new): 52 hermetic tests covering ACs #1-#7 — significance gate per-condition, SA bucket classification, low-SA + out-of-scope decisions, combined eligibility + multiplier math, flooding detection at low/medium/high severity with each Stage A indicator isolated, residency gating across single-regime / multi-regime / no-regime / no-region edge cases, and AC #7's "pipeline never halts" envelope (empty inputs, malformed metadata, extreme floods).
- `orchestrator/src/signal-ingestion/types.ts` (modified): added optional `RawSignal.region` field consumed by the residency gate; added `SignalResidencyViolationDecision` Decision type; extended `SignalFetchResult.decisions` to include residency violations.
- `orchestrator/src/signal-ingestion/index.ts` (modified): exported the Phase 4 surface plus `SignalResidencyViolationDecision`.

### Design decisions

- **Five-state SA bucket including `pending`** (not four). `pending` is the fail-closed bucket when `cluster.saResonance` is `undefined` — Phase 3 deliberately leaves SA computation to Phase 4/5's Soul-DID-adapter wiring. Folding `pending` into `out-of-scope` would conflate "we didn't measure SA yet" with "demand is outside our product identity"; keeping them separate lets operators see which clusters need SA computation infrastructure vs. which need separate triage. Both buckets get `d1WeightMultiplier = 0.0`, so the D1 math is unaffected.
- **Significance × SA factor multiplication** rather than max/min/branching. Multiplying gives a smooth gradient: `qualified + low-sa-review = 0.3` weight, `monitored = 0.0`, etc. Caller can branch on `eligibleForD1` (boolean) when they need a hard gate; consumers preferring smooth scoring use `d1WeightMultiplier`. Matches RFC-0030 §10's "D1 = product of factors" formula shape.
- **Flooding severity = sum of tripped indicators** (1/2/3 → low/medium/high). The RFC's OQ-13.5 resolution describes Stage A as classifying by volume + source-diversity + baseline-drift; mapping severity to "number of independent signals tripped" is the simplest monotonic combiner. Avoids tunable severity weights operators would need to calibrate in v1; v2 can introduce per-indicator severity scoring once corpus data justifies it.
- **`detectFlooding` returns `null` when no indicators trip** (not a Decision with `severity: 'none'`). The catalog should only see events worth routing; a null return means "nothing to log this tick." Mirrors the AC #7 "pipeline never halts" envelope — callers do `if (decision) catalog.route(decision)`.
- **Residency check: missing `signal.region` → permit, not refuse**. Per OQ-13.3 the gate composes with RFC-0022; adapters that don't yet surface region metadata shouldn't false-positively fail compliance checks. The missing-region case is a visible-gap metric for the operator's regime config rollout — surfaceable later via a Phase 6 metric ("X% of signals from adapter Y missing region metadata"). If we made missing-region a hard fail, operators would have to either gate every adapter behind region-plumbing work before turning on regime declarations, or block their own signal ingestion entirely.
- **Conservative flooding defaults**: 3× volume spike, 0.2 minimum source diversity ratio, `minSignalCountForDiversityCheck: 10` floor, 5× per-source baseline drift. Defaults chosen to avoid tripping on 10%-over-baseline traffic blips or on tiny populations (1 signal from 1 source has diversity 1.0 — would never trip; 5 signals from 1 source has diversity 0.2 — would prematurely trip without the count floor). Operators can override via the Phase 6 config surface.
- **No inline RFC OQ resolution required**: RFC-0030 v0.2 explicitly resolved all 5 OQs in the 2026-05-16 operator walkthrough. Phase 4 implements the resolution; nothing in the OQ section was modified.

### Verification

- `pnpm --filter @ai-sdlc/orchestrator build` — clean (tsc emits dist artifacts including `significance.js` + `significance.d.ts`)
- `pnpm --filter @ai-sdlc/orchestrator test` — 3669 pass / 1 skipped
- `pnpm --filter @ai-sdlc/orchestrator test -- --run signal-ingestion` — 163 pass (52 new significance tests + 111 pre-existing classifier/clustering/config/integration tests)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- `pnpm test` (full workspace) — clean

### Follow-up

- **Phase 5 (AISDLC-347)** consumes `SignificanceAssessedCluster.d1WeightMultiplier` in the reformulated D1 formula and wires the Soul DID adapter that populates `cluster.saResonance` (currently `undefined` from Phase 3).
- **Phase 6 (AISDLC-348)** surfaces `floodingDetection` config in `.ai-sdlc/signal-ingestion.yaml` (Phase 4 ships defaults via `DEFAULT_FLOODING_DETECTION_CONFIG`) and wires the operator-batch-review UI for `signal-flooding-detected` / `signal-residency-violation` / `signal-low-sa-for-review` / `signal-out-of-scope` Decisions per the RFC-0035 G0 catalog contract.
- **v2 source-reputation registry** (per OQ-13.5 resolution): `FloodingDetectionConfig.lowConfidenceThreshold` is wired in v1 but the source-confidence value isn't yet consumed (v1 has no Source Reputation registry); v2 plugs the registry in to make the `auto-throttle` action effective.
