# Priority Scoring (PPA)

The Product Priority Algorithm (PPA) provides autonomous work item prioritization. It computes a composite priority score from seven dimensions that capture product alignment, market signals, execution feasibility, and human input.

## Quick Start

```typescript
import { computePriority, rankWorkItems } from '@ai-sdlc/orchestrator';

const score = computePriority({
  itemId: 'ISS-42',
  title: 'Add dark mode',
  description: 'Users want dark mode for night-time readability',
  soulAlignment: 0.8,
  customerRequestCount: 12,
  complexity: 3,
});

console.log(score.composite);  // e.g., 0.4821
console.log(score.confidence); // e.g., 0.1875
```

## Configuration

Priority scoring is configured via the `priorityPolicy` field on a Pipeline resource:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: prioritized-delivery
spec:
  priorityPolicy:
    enabled: true
    minimumScore: 0.1
    minimumConfidence: 0.3
    soulPurpose: "Empower developers to ship reliable software faster"
    dimensions:
      humanCurveWeights:
        explicit: 0.5
        consensus: 0.3
        decision: 0.2
    calibration:
      enabled: true
      lookbackPeriod: P30D
    adapters:
      supportChannel: zendesk-support
      crm: hubspot-crm
      analytics: posthog-analytics
  # ... triggers, providers, stages
```

## Composite Formula

```
P(w) = Sa(w) x Dp(w) x Mf(w) x Er(w) x (1 - Et(w)) x (1 + HC(w)) x Ck(w)
```

## Dimensions

| Symbol | Name | Range | Description |
|---|---|---|---|
| Sa | Soul Alignment | [0, 1] | Alignment with product mission |
| Dp | Demand Pressure | [0, 1.5] | Customer requests, demand signals, bug severity |
| Mf | Market Force | [0.5, 3.0] | Tech inflection, competitive pressure, regulatory urgency |
| Er | Execution Reality | [0, 1] | Inverse complexity, budget headroom, dependency clearance |
| Et | Entropy Tax | [0, 1] | Competitive drift and market divergence |
| HC | Human Curve | [-1, 1] | Explicit priority, team consensus, meeting decisions |
| Ck | Calibration | [0.7, 1.3] | Auto-calibrated or operator-tuned coefficient |

A **zero** in any multiplicative dimension (Sa, Dp, Er) vetoes the work item entirely.

## API Reference

### `computePriority(input, config?)`

Compute the PPA composite priority score for a single work item.

**Parameters:**
- `input: PriorityInput` — Work item data and signal values
- `config?: PriorityConfig` — Optional weights and calibration coefficient

**Returns:** `PriorityScore`

```typescript
interface PriorityScore {
  composite: number;
  dimensions: {
    soulAlignment: number;
    demandPressure: number;
    marketForce: number;
    executionReality: number;
    entropyTax: number;
    humanCurve: number;
    calibration: number;
  };
  confidence: number;  // [0, 1] based on provided vs defaulted inputs
  timestamp: string;
  override?: { reason: string; expiry?: string };
}
```

### `rankWorkItems(items, config?)`

Score and rank multiple work items by descending composite priority.

**Parameters:**
- `items: PriorityInput[]` — Array of work items to score
- `config?: PriorityConfig` — Optional weights and calibration

**Returns:** `Array<PriorityInput & { score: PriorityScore }>`

### `PriorityInput`

| Field | Type | Dimension | Description |
|---|---|---|---|
| `itemId` | `string` | — | Work item identifier |
| `title` | `string` | — | Work item title |
| `description` | `string` | — | Work item description |
| `soulAlignment` | `number?` | Sa | Pre-computed alignment score [0, 1] |
| `customerRequestCount` | `number?` | Dp | Number of customer requests |
| `demandSignal` | `number?` | Dp | Recency-weighted demand [0, 1] |
| `bugSeverity` | `number?` | Dp | Bug severity (1-5, 5=critical) |
| `builderConviction` | `number?` | Dp | Roadmap priority [0, 1] |
| `techInflection` | `number?` | Mf | Technology inflection relevance [0, 1] |
| `competitivePressure` | `number?` | Mf | Competitive pressure [0, 1] |
| `regulatoryUrgency` | `number?` | Mf | Regulatory urgency [0, 1] |
| `complexity` | `number?` | Er | Task complexity (1-10) |
| `budgetUtilization` | `number?` | Er | Budget utilization percent |
| `dependencyClearance` | `number?` | Er | Dependencies clear [0, 1] |
| `competitiveDrift` | `number?` | Et | Competitive drift [0, 1] |
| `marketDivergence` | `number?` | Et | Market divergence [0, 1] |
| `explicitPriority` | `number?` | HC | Explicit priority [0, 1] |
| `teamConsensus` | `number?` | HC | Team consensus signal [0, 1] |
| `meetingDecision` | `number?` | HC | Meeting decision weight [0, 1] |
| `override` | `boolean?` | — | Bypass algorithm (composite = Infinity) |
| `overrideReason` | `string?` | — | Reason for override |

### `PriorityConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `humanCurveWeights.explicit` | `number?` | 0.5 | Weight for explicit priority |
| `humanCurveWeights.consensus` | `number?` | 0.3 | Weight for team consensus |
| `humanCurveWeights.decision` | `number?` | 0.2 | Weight for meeting decisions |
| `calibrationCoefficient` | `number?` | 1.0 | Manual calibration override [0.7, 1.3] |

## Calibration

The calibration loop records each pipeline execution outcome and uses historical data to adjust the calibration coefficient:

```typescript
import { StateStore } from '@ai-sdlc/orchestrator';

const store = StateStore.open('.ai-sdlc/state.db');

// Record a sample after pipeline execution
store.savePrioritySample({
  issueId: 'ISS-42',
  priorityComposite: 0.85,
  priorityConfidence: 0.7,
  outcome: 'success',
  filesChanged: 5,
});

// Compute auto-calibrated coefficient
const coefficient = store.computeCalibrationCoefficient();
// Returns 1.0 with no data, adjusts with historical samples
```

## Integration with Watch Loop

When `priorityPolicy.enabled` is `true`, the watch loop automatically scores items before enqueueing:

- Items below `minimumScore` are silently skipped
- Items below `minimumConfidence` are flagged for review
- The composite score is passed to `ReconcilerLoop.enqueue()` for priority ordering

## Admission Subset (RFC-0008)

Admission uses a strict subset of the full PPA — `M-φ`, `E-τ`, and `C-κ`
are deferred to runtime scoring. The admission composite is:

```
P_admission = SA × D-pi_adjusted × ER × (1 + HC)
```

where `D-pi_adjusted = rawDP × (1 − defectRiskFactor)`,
`ER = min(baseER × autonomyFactor, designSystemReadiness)`, and `SA`
comes from a `DesignIntentDocument` via the three-layer Soul Alignment
scorer.

`computeAdmissionComposite()` returns a `pillarBreakdown` decomposing
the score into Product / Design / Engineering signals and surfacing
cross-pillar `tensions[]` (e.g. `PRODUCT_HIGH_DESIGN_LOW`).

See [Design Intent & Soul Alignment](design-intent) for the full API
surface (admission enrichment, three-layer scorer, feedback flywheel,
drift monitor, pattern-test CLI).
