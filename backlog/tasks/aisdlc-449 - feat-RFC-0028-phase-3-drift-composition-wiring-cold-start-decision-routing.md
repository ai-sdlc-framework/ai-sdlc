---
id: AISDLC-449
title: 'feat: RFC-0028 Phase 3 — structural + statistical drift composition wiring + cold-start handling + Decision routing'
status: To Do
assignee: []
created_date: '2026-05-27'
labels:
  - rfc-0028
  - substrate-enforcement
  - phase-3
  - drift-detection
dependencies:
  - AISDLC-447
  - AISDLC-448
references:
  - spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0028 §7.2 v0.2 resolution. Wires the canonical pairing of structural (CI authoring-time) + statistical (runtime) drift detection with explicit composition rules.

## Scope (RFC-0028 §7.2 v0.2 resolution)

### Composition rules implemented

1. **Structural drift (CI-time) REJECTS deployment** (from AISDLC-448): `Decision: substrate-structural-drift-detected` blocks PR merge.
2. **Statistical drift (runtime) SURFACES to operator (RFC-0035 G0 non-blocking)**: PPA's `SoulDriftDetected` event (rolling 30d mean < 0.4 or stddev > 0.15 for 3 sprints) routes to `Decision: soul-statistical-drift-detected` → operator batch review with reconciliation paths. Pipeline never halts.
3. **Both Decisions composable in catalog**: operator TUI surface (RFC-0023) presents structural-drift attempts (rejected at CI) alongside statistical-drift signals (caught at runtime) — closes the loop on "drift caught early vs drift that escaped."

### Cold-start handling

Statistical drift detection requires rolling 30d baseline. Pre-baseline period:
- < 30d signal available → detector emits "calibrating" status
- No statistical Decisions emitted during calibration window
- Structural detection (AISDLC-448) is sole defense during calibration
- Same proven shape as RFC-0030 OQ-13.5 z-score flooding detection — reuse the cold-start pattern

### Catalog substrate wiring

- `orchestrator/src/substrate/drift-composition.ts` (new module) — orchestrates the two detection layers; routes events to Decision Catalog (RFC-0035 default-ON since AISDLC-392)
- Reconciliation paths for `soul-statistical-drift-detected`: (a) confirm drift as legitimate evolution → emit DID amendment; (b) confirm drift as substrate violation → file fix task; (c) defer for next operator review window
- TUI surface (composes with RFC-0023): batch-review panel showing structural + statistical drift events side-by-side

### Hermetic tests

- Composition: structural fail blocks PR while statistical fail emits non-blocking Decision
- Cold-start: pre-baseline statistical detection emits "calibrating" status, no Decisions
- Catalog correlation: operator can query "show me all drift events for Soul X" and get both classes
- Reconciliation: each reconciliation path closes the Decision correctly
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `orchestrator/src/substrate/drift-composition.ts` module ships orchestrating both detection layers
- [ ] #2 Structural drift fails PR via `Decision: substrate-structural-drift-detected` (hard gate)
- [ ] #3 Statistical drift emits `Decision: soul-statistical-drift-detected` via RFC-0035 G0 (non-blocking)
- [ ] #4 Cold-start: pre-30d-baseline emits "calibrating" status, no statistical Decisions
- [ ] #5 TUI surface (composes with RFC-0023) presents structural + statistical drift events side-by-side
- [ ] #6 Three reconciliation paths for statistical drift: confirm-as-evolution, confirm-as-violation, defer
- [ ] #7 Hermetic tests cover composition (structural blocks while statistical doesn't), cold-start, catalog correlation, reconciliation paths
- [ ] #8 No new event-emission code beyond per-failure case (reuses RFC-0035 catalog substrate)
<!-- AC:END -->
