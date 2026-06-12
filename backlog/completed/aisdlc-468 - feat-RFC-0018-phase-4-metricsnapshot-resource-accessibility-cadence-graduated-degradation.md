---
id: AISDLC-468
title: 'feat: RFC-0018 Phase 4 — MetricSnapshot resource + stale-metric Decision + accessibility cadence graduated degradation'
status: Done
assignee: []
created_date: '2026-05-28'
labels:
  - rfc-0018
  - journey-pattern
  - phase-4
  - metrics
  - compliance
dependencies:
  - AISDLC-465
  - AISDLC-466
references:
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
  - spec/rfcs/RFC-0030-signal-ingestion-pipeline.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0018 §10.1 OQ-5 + OQ-6 resolutions. Ships operator-supplied `MetricSnapshot` resource for journey success-metrics + graduated Eρ₅ degradation for accessibility cadence enforcement.

## Scope (OQ-5: MetricSnapshot resource)

### MetricSnapshot resource

`spec/schemas/metric-snapshot.v1.schema.json` (new):
- `apiVersion`, `kind: MetricSnapshot`
- `metadata.journey` (path-style URI `<soul-id>/<journey-id>` or `<soul-id>/<variant-id>/<journey-id>`)
- `metadata.metricId` (e.g., `completion-rate`, `median-time-to-first-task-done`)
- `spec.value` (number) + `spec.recordedAt` (ISO 8601 timestamp)
- `spec.sourceTool` (free-text: "mixpanel", "amplitude", "heap", "internal-pipeline", etc.)

`orchestrator/src/journey/metric-snapshot.ts`: read API (`getLatestMetricSnapshot(journey, metricId)`)

### Stale-metric handling

- Default staleness threshold: 30 days
- Per-Soul `journey.successMetrics.staleness.thresholdDays` override
- When stale: emit `Decision: journey-metric-stale` → warn-and-unknown behavior (Cκ scoring treats metric as missing input, NOT fail-closed)

### Future-RFC trajectory documentation

`docs/operations/journey-metrics.md` pre-recommends future `MetricsAdapter` pattern parallel to RFC-0030 SignalSourceAdapter when adopters surface need.

## Scope (OQ-6: Accessibility cadence graduated degradation)

### Graduated Eρ₅ degradation schedule

When journey audit is overdue (per `accessibility.auditCadence`), Eρ₅ degrades on this schedule:

| Days past cadence | Eρ₅ impact | Decision emitted |
|---|---|---|
| 0-30 | Warn (no impact) | `journey-audit-overdue-warn` |
| 30-60 | -25% | `journey-audit-overdue-graduated` |
| 60-90 | -50% | (continued; aggregated) |
| 90+ | Effective block | `journey-audit-overdue-blocking` |

### Per-Soul `accessibility.auditOverdueGracePolicy` config

Options (default `graduated`):
- `graduated` — schedule above
- `binary-30d` — single Eρ₅ fail at 30d (no graduation)
- `hard-block` — immediate Eρ₅ fail at cadence + 0d (no grace)

SOC2/HIPAA-strict shops opt into stricter modes via per-Soul config.

### Composes with RFC-0022

When RFC-0022 compliance regime declares stricter cadence than soul-default, the journey-level cadence enforcement respects the strictest constraint (multi-posture UNION per RFC-0030 OQ-13.3 precedent).

### Hermetic tests

- MetricSnapshot round-trip (write, read, query latest)
- Stale-metric detection at threshold; Decision emission; Cκ warn-and-unknown behavior
- Graduated degradation: each threshold (0/30/60/90) emits correct Decision + Eρ₅ impact
- Per-Soul override: `binary-30d` and `hard-block` modes
- Multi-posture composition with RFC-0022 (strictest applies)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `spec/schemas/metric-snapshot.v1.schema.json` ships
- [ ] #2 `MetricSnapshot` read API at `orchestrator/src/journey/metric-snapshot.ts`
- [ ] #3 Stale-metric threshold (default 30d; per-Soul configurable) emits `Decision: journey-metric-stale` with warn-and-unknown Cκ behavior
- [ ] #4 Graduated Eρ₅ degradation schedule implemented (0-30/30-60/60-90/90+ thresholds + decisions)
- [ ] #5 Per-Soul `accessibility.auditOverdueGracePolicy` config respected; `graduated` / `binary-30d` / `hard-block` modes all work
- [ ] #6 Composes with RFC-0022 multi-posture: strictest cadence applies when adopter declares multiple regimes
- [ ] #7 `docs/operations/journey-metrics.md` pre-documents future `MetricsAdapter` pattern parallel to RFC-0030 SignalSourceAdapter
- [ ] #8 Hermetic tests: MetricSnapshot round-trip + stale detection + graduated thresholds + per-Soul overrides + multi-posture composition
<!-- AC:END -->
