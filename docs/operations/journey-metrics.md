# Journey Metrics Operations Runbook

**RFC:** RFC-0018 §10.1 OQ-5 (MetricSnapshot resource + staleness handling)
**Implemented:** AISDLC-468 (Phase 4)

This runbook covers operator tasks for the journey success-metrics surface: supplying MetricSnapshot resources, configuring staleness thresholds, and understanding the Cκ scoring behavior when metrics are stale or missing.

---

## Overview

The AI-SDLC framework does **not** compute journey success metrics internally. Operators supply metric values from their own analytics pipeline via the `MetricSnapshot` resource (`spec/schemas/metric-snapshot.v1.schema.json`). The framework reads these values for Cκ scoring at journey scope.

**OQ-5 design contract (operator-supplied):**
- Operators push MetricSnapshot records (via Mixpanel, Amplitude, Heap, an internal pipeline, or a data-warehouse query).
- The framework reads the latest snapshot for each journey + metricId pair.
- When the latest snapshot is older than the staleness threshold (`thresholdDays`, default 30 days), the framework emits `Decision: journey-metric-stale` and treats the metric as an **unknown input** for Cκ scoring (warn-and-unknown, NOT fail-closed).

---

## Supplying MetricSnapshot records

A MetricSnapshot is a plain JSON document matching `spec/schemas/metric-snapshot.v1.schema.json`:

```json
{
  "apiVersion": "ai-sdlc.io/v1alpha1",
  "kind": "MetricSnapshot",
  "metadata": {
    "journey": "spry-engage/onboarding",
    "metricId": "completion-rate"
  },
  "spec": {
    "value": 0.63,
    "recordedAt": "2026-06-01T00:00:00.000Z",
    "sourceTool": "mixpanel"
  }
}
```

Key fields:

| Field | Description |
|---|---|
| `metadata.journey` | Path-style journey URI: `<soul-id>/<journey-id>` or `<soul-id>/<variant-id>/<journey-id>` |
| `metadata.metricId` | Kebab-case metric ID. MUST match a `successMetrics[].id` on the journey declaration |
| `spec.value` | Metric value. Unit convention is shared between the operator and the framework (declared on the journey) |
| `spec.recordedAt` | ISO 8601 timestamp when the analytics source recorded this value |
| `spec.sourceTool` | Free-text analytics tool identifier: `'mixpanel'`, `'amplitude'`, `'heap'`, `'internal-pipeline'`, etc. |

### Ingestion frequency

Push a new MetricSnapshot at least once per `staleness.thresholdDays` (default: 30 days) to keep metrics fresh. Recommended: daily or weekly via an automated pipeline.

---

## Staleness configuration

The default staleness threshold is **30 days**. Per-Soul overrides are supported via the soul's `spec.journeyConfig.successMetrics.staleness.thresholdDays` block, or the org-wide `.ai-sdlc/journey-config.yaml`:

```yaml
# .ai-sdlc/journey-config.yaml (org-wide default)
journey:
  successMetrics:
    staleness:
      thresholdDays: 30        # default; override to 7 for high-frequency reporting
```

Per-Soul override example:

```yaml
# In the soul's spec.journeyConfig block
journeyConfig:
  successMetrics:
    staleness:
      thresholdDays: 7         # this soul's analytics pipeline runs weekly
```

### What happens when a metric is stale

When the latest snapshot for a journey + metricId pair is older than `thresholdDays`:

1. `Decision: journey-metric-stale` is emitted — routes through RFC-0035 G0 (non-blocking batch review).
2. Cκ scoring treats the metric as an **unknown input** (same as `freshness: 'missing'`).
3. The pipeline does NOT fail-closed — work continues; the Decision surfaces for operator batch review.

**Why warn-and-unknown (not fail-closed):**
Stale metrics are expected during transition periods (new product areas, updated analytics instrumentation, quarterly snapshots). Blocking the pipeline on stale data would be operator-hostile for shops where quarterly analytics reporting is deliberate practice (e.g., an annual-reporting journey). The fail-closed behavior would also incorrectly penalize journeys that have recently been declared and have not yet had time to accumulate a metric history.

---

## Future: MetricsAdapter pattern

When adopters surface the need for **framework-side polling** of analytics backends (rather than operator-push), the resolution path is a `MetricsAdapter` pattern parallel to RFC-0030's `SignalSourceAdapter`:

```
(future) MetricsAdapter interface
  .fetchLatestSnapshot(journey, metricId): Promise<MetricSnapshot>

Adapters:
  MixpanelMetricsAdapter
  AmplitudeMetricsAdapter
  HeapMetricsAdapter
  InternalWarehouseMetricsAdapter
```

This mirrors the SignalSourceAdapter (RFC-0030) that drives qualitative signal ingestion. The separation is intentional: qualitative signals (text) and quantitative journey-success metrics (numbers) are semantically different enough to warrant separate adapter contracts rather than a shared type hierarchy.

**Activation:** File a `Decision: journey-metrics-adapter-activation-request` in the Decision Catalog when 2+ distinct adopters request framework-side analytics polling. The current operator-push model is the v1 contract.

---

## Cκ scoring composition

Metric freshness state determines how Cκ uses the value:

| Freshness | Cκ behavior |
|---|---|
| `fresh` | Uses `snapshot.spec.value` directly. Cκ boost applies if value is below `alertBelow`. |
| `stale` | Treated as unknown input. Cκ does not apply the `alertBelow` boost or penalize. `Decision: journey-metric-stale` emitted. |
| `missing` | Treated as unknown input. No Cκ impact. |

Stale and missing both result in the same Cκ scoring behavior (unknown input), ensuring that journeys with temporarily absent metrics do not systematically under-score compared to fully-instrumented journeys.

---

## References

- `spec/schemas/metric-snapshot.v1.schema.json` — MetricSnapshot JSON Schema
- `orchestrator/src/journey/metric-snapshot.ts` — read API + staleness detection implementation
- `spec/rfcs/RFC-0018-in-soul-journey-pattern.md` §10.1 OQ-5 — OQ resolution and design rationale
- `spec/rfcs/RFC-0030-signal-ingestion-pipeline.md` — SignalSourceAdapter pattern (parallel for qualitative signals)
- `spec/rfcs/RFC-0035-decision-catalog-operator-routing.md` — G0 non-blocking routing for `journey-metric-stale` Decision
