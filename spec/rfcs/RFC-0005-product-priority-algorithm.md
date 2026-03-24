# RFC-0005: Product Priority Algorithm (PPA)

**Status:** Draft
**Author:** Alexander Kline (Arcana Concept Studio), AI-SDLC Contributors
**Created:** 2026-03-24
**Updated:** 2026-03-24
**Target Spec Version:** v1alpha1

---

## Summary

This RFC introduces a continuous product prioritization layer into the AI-SDLC Framework. When engineering capacity is effectively unlimited (autonomous agents can build faster than teams can decide), the bottleneck shifts from execution to prioritization. The framework currently answers "how should this be built?" but has no mechanism for "should this be built, and in what order?"

The Product Priority Algorithm (PPA) fills this gap with a multiplicative composite scoring function that synthesizes five dimensions — Soul Alignment, Demand Pressure, Market Force, Execution Reality, and Entropy Tax — plus bounded human influence and self-calibrating feedback. This RFC proposes embedding PPA as a `priorityPolicy` extension within the existing `Pipeline.spec` resource (following the RFC-0004 cost governance precedent), three new adapter interface contracts for external signal ingestion, and priority-aware queue processing in the reconciliation loop.

## Motivation

### The prioritization bottleneck is real

The AI-SDLC orchestrator can take a well-specified work item from backlog to production in hours. The two-hour sprint planning meeting to decide *whether* to build it now costs more than just building it. This inversion creates three problems:

1. **The backlog becomes a firehose.** When build capacity is unlimited, every idea becomes a candidate. Without continuous scoring, the pipeline either builds arbitrarily or stalls waiting for human triage.

2. **Strategic alignment is invisible.** The framework routes by complexity (1-10 scale) and enforces quality gates, but a feature that perfectly aligns with the product's purpose and one that contradicts it receive identical treatment at the same complexity.

3. **External signals have no voice.** Customer demand, competitive moves, regulatory shifts, and market dynamics all influence what should be built. The framework operates on backlog contents as given, with no mechanism to synthesize signals from outside the development perimeter.

### The spec has execution governance but no product governance

| What exists | Where | Limitation |
|---|---|---|
| Complexity scoring (1-10) | `executePipeline()` | Measures execution difficulty, not strategic value |
| Quality gates | QualityGate resource | Enforces build quality, not build priority |
| Autonomy levels | AutonomyPolicy resource | Controls agent trust, not task ordering |
| Cost governance | RFC-0004, Pipeline.spec.costPolicy | Controls spending, not value-per-spend |

There is no way to:
- Score a work item's strategic alignment with the product's purpose
- Ingest customer support signals, CRM data, or product analytics
- Detect competitive pressure or regulatory urgency
- Learn from build outcomes to improve future prioritization
- Protect product identity from incremental drift

## Goals

- Enable continuous, autonomous prioritization of work items across multiple signal dimensions
- Provide a multiplicative composite scoring function where every dimension is a necessary condition (zero in any dimension zeros the score)
- Integrate with existing AI-SDLC infrastructure: complexity scoring, cost governance, adapter layer, provenance, episodic memory
- Bound the Market Force multiplier to [0.5, 3.0] to prevent single-dimension domination
- Provide bounded human influence via tanh-capped Human Curve (can amplify or suppress, but cannot manufacture signal)
- Feed build outcomes back into calibration for self-improving priority accuracy
- Support priority-ordered queue processing in the reconciler watch loop

## Non-Goals

- Replacing human product judgment (PPA augments, not replaces)
- Implementing a design governance layer (future work)
- Multi-product portfolio-level resource allocation (future work)
- Real-time market data ingestion (PPA operates on periodically refreshed signals)
- Modifying the core resource model (no new top-level resource type; embedded in Pipeline.spec)

## Proposal

### 1. Pipeline.spec.priorityPolicy

Embed priority configuration in the Pipeline resource, following the RFC-0004 pattern for cost governance:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: my-pipeline
spec:
  priorityPolicy:
    enabled: true
    minimumScore: 0.1        # items below this score are not dispatched
    minimumConfidence: 0.3    # items below this confidence are held for human review
    soulPurpose: |
      A developer productivity platform that makes AI agents safe and
      governable for enterprise software teams.
    dimensions:
      marketForce:
        maxMultiplier: 3.0    # upper bound (default 3.0)
        minMultiplier: 0.5    # lower bound (default 0.5)
      humanCurve:
        weights:
          explicit: 0.2
          consensus: 0.5
          decision: 0.3
    calibration:
      enabled: true
      lookbackPeriod: 90d
    adapters:
      supportChannel: zendesk-adapter
      crm: hubspot-adapter
      analytics: posthog-adapter
  # ... existing stages, triggers, etc.
```

### 2. Composite Priority Function

For any candidate work item *w*:

```
P(w) = Sα(w) × Dπ(w) × Mφ(w) × Eρ(w) × (1 − Eτ) × (1 + HC(w)) × Cκ(w)
```

| Term | Name | Range | Source |
|---|---|---|---|
| **Sα** | Soul Alignment | [0, 1] | Semantic distance from `soulPurpose` + LLM assessment |
| **Dπ** | Demand Pressure | [0, 1.5] | SupportChannel + IssueTracker signals |
| **Mφ** | Market Force | [0.5, 3.0] | External signals, bounded |
| **Eρ** | Execution Reality | [0, 1] | AI-SDLC complexity score + CostTracker budget status |
| **(1 − Eτ)** | Entropy Tax | [0, 1] | Competitive drift + market divergence |
| **(1 + HC)** | Human Curve | [0, 2] | Backlog priority + team consensus + meeting decisions |
| **Cκ** | Calibration | [0.7, 1.3] | Historical accuracy feedback |

The multiplicative structure ensures every dimension is a necessary condition. A perfectly aligned feature with zero demand scores zero. A high-demand feature that cannot be built scores zero.

### 3. New Adapter Interfaces

Three new adapter interface contracts for external signal ingestion:

#### SupportChannel@v1

```typescript
interface SupportChannel {
  listTickets(filter: SupportTicketFilter): Promise<SupportTicket[]>;
  getTicket(id: string): Promise<SupportTicket>;
  getFeatureRequestCount(featureTag: string, since?: string): Promise<number>;
  watchTickets(filter: SupportTicketFilter): EventStream<SupportTicketEvent>;
}
```

#### CrmProvider@v1

```typescript
interface CrmProvider {
  getAccount(id: string): Promise<CrmAccount>;
  listAccounts(filter?: { tier?: string; minHealthScore?: number }): Promise<CrmAccount[]>;
  getEscalations(since?: string): Promise<CrmEscalation[]>;
  getFeatureRequests(accountId?: string): Promise<CrmFeatureRequest[]>;
}
```

#### AnalyticsProvider@v1

```typescript
interface AnalyticsProvider {
  getFeatureUsage(feature: string, period?: string): Promise<FeatureUsage>;
  getActiveUsers(period?: string): Promise<number>;
  getRetentionRate(cohort?: string, period?: string): Promise<number>;
  getNpsScore(period?: string): Promise<number | undefined>;
}
```

### 4. Priority-Aware Queue Processing

The `ReconcilerLoop.enqueue()` method accepts an optional `priority` parameter. Items are dispatched in priority-descending order. This enables PPA-scored items to process before lower-priority items without architectural changes to the reconciler.

```typescript
// Before PPA: FIFO order
loop.enqueue(pipeline);

// With PPA: priority-ordered
const score = computePriority(input);
loop.enqueue(pipeline, score.composite);
```

### 5. Integration Points

#### Integration Point 1: Priority Stack as Trigger Source

The orchestrator's watch loop scores all candidate issues via PPA before enqueueing. Items below `minimumScore` are skipped. Items below `minimumConfidence` are flagged for human review.

#### Integration Point 2: Shared Execution Reality

PPA reads existing AI-SDLC data instead of computing independently:

- **Complexity**: `parseComplexity(issue.description)` from execute.ts
- **Budget**: `CostTracker.getBudgetStatus().utilizationPercent`
- **Dependencies**: Issue labels and linked issues from IssueTracker

#### Integration Point 3: Outcome Feedback

After each completed pipeline execution, PPA records a calibration entry:

- Pre-build priority score and confidence
- Post-build outcome (adoption, retention impact, bug resolution)
- Delta feeds back into the calibration coefficient Cκ

This data is stored in the existing StateStore episodic memory tables.

## Design Details

### Schema Changes

Add optional `priorityPolicy` to `Pipeline.spec`:

```json
{
  "priorityPolicy": {
    "type": "object",
    "description": "Product Priority Algorithm configuration for autonomous work item prioritization.",
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": false
      },
      "minimumScore": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.1
      },
      "minimumConfidence": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "default": 0.3
      },
      "soulPurpose": {
        "type": "string",
        "description": "The product's irreducible identity — the problem it solves, the feeling it creates, and the direction it's heading."
      },
      "dimensions": {
        "type": "object",
        "properties": {
          "marketForce": {
            "type": "object",
            "properties": {
              "maxMultiplier": { "type": "number", "default": 3.0 },
              "minMultiplier": { "type": "number", "default": 0.5 }
            }
          },
          "humanCurve": {
            "type": "object",
            "properties": {
              "weights": {
                "type": "object",
                "properties": {
                  "explicit": { "type": "number", "default": 0.2 },
                  "consensus": { "type": "number", "default": 0.5 },
                  "decision": { "type": "number", "default": 0.3 }
                }
              }
            }
          }
        }
      },
      "calibration": {
        "type": "object",
        "properties": {
          "enabled": { "type": "boolean", "default": true },
          "lookbackPeriod": { "type": "string", "default": "90d" }
        }
      },
      "adapters": {
        "type": "object",
        "properties": {
          "supportChannel": { "type": "string" },
          "crm": { "type": "string" },
          "analytics": { "type": "string" }
        }
      }
    }
  }
}
```

### Behavioral Changes

1. **Watch loop**: When `priorityPolicy.enabled` is true, the watch loop scores all candidate issues via `computePriority()` before calling `enqueue(pipeline, priority)`.

2. **Execution pipeline**: `executePipeline()` receives a pre-computed priority score in `ExecuteOptions`. The score is recorded in provenance metadata and the cost receipt.

3. **Reconciler queue**: `ReconcilerLoop.processQueue()` sorts by priority descending before dispatching. Higher-scored items are processed first.

4. **Outcome recording**: After pipeline completion, priority metadata is appended to the existing episodic memory record for calibration feedback.

### Migration Path

No migration required. `priorityPolicy` is an optional field with `enabled: false` as default. Existing pipelines are unaffected.

## Backward Compatibility

- **Not a breaking change.** All new fields are optional with sensible defaults.
- **Existing resources validate without modification.** The `priorityPolicy` field is optional in the schema.
- **No changes to existing enforcement behavior.** PPA only activates when explicitly enabled.
- **New adapter interfaces are additive.** `SupportChannel@v1`, `CrmProvider@v1`, `AnalyticsProvider@v1` are new interface contracts that don't modify existing ones.

## Alternatives Considered

### Alternative 1: New PriorityPolicy Resource Type

Create a sixth top-level resource type (`PriorityPolicy`) alongside Pipeline, AgentRole, QualityGate, AutonomyPolicy, and AdapterBinding.

**Rejected because:** Adding a core resource type is the highest-friction change in the spec process. RFC-0004 demonstrated that embedding policy in Pipeline.spec is sufficient for governance extensions. PPA's configuration (soul purpose, dimension weights, adapter references) fits naturally as a Pipeline extension. A standalone resource would be warranted only if priority policies need to be shared across multiple pipelines — a multi-product portfolio scenario that is explicitly a non-goal for v1.

### Alternative 2: External Prioritization Service

Keep PPA entirely external to AI-SDLC and have it write priority scores to issue labels/fields that the orchestrator reads.

**Rejected because:** This creates a loosely-coupled system where PPA has no access to AI-SDLC's complexity scoring, cost governance, or outcome feedback. The integration points that make PPA valuable (shared Execution Reality, outcome calibration) require tighter coupling. Additionally, external services lose provenance guarantees.

### Alternative 3: Use RICE/WSJF/ICE Scoring

Adopt an existing prioritization framework rather than creating a new composite function.

**Rejected because:** RICE (Reach, Impact, Confidence, Effort) and WSJF (Weighted Shortest Job First) are additive or ratio-based. They lack the multiplicative structure that makes PPA's zero-propagation property work (zero soul alignment zeros the entire score regardless of demand). They also lack market force awareness, entropy tax, and the feedback calibration loop. PPA was specifically designed for the autonomous engineering context where these dimensions are essential.

## Implementation Plan

- [x] Proof-of-concept scoring module (`orchestrator/src/priority.ts` — `computePriority()`, `rankWorkItems()`, 41 tests)
- [x] Priority queue support in ReconcilerLoop (`enqueue(resource, priority?)`, 5 tests)
- [x] SupportChannel, CrmProvider, AnalyticsProvider adapter interfaces (type definitions)
- [x] Market Force bounded to [0.5, 3.0] (not the paper's unbounded [0.025, 45])
- [ ] Update Pipeline JSON Schema with `priorityPolicy` field
- [ ] Update normative spec document (spec.md) with priority policy semantics
- [ ] Update glossary with PPA terms (Soul Alignment, Demand Pressure, Market Force, Execution Reality, Entropy Tax, Human Curve, Calibration)
- [ ] Update primer with prioritization architecture
- [ ] Wire `computePriority()` into `startWatch()` enqueue path
- [ ] Wire outcome feedback into existing episodic memory tables
- [ ] Conformance tests for priority scoring behavior
- [ ] Contrib adapter stubs for Zendesk, Intercom (SupportChannel), HubSpot, Salesforce (CRM), PostHog, Amplitude (Analytics)

## Open Questions

1. **Soul Alignment via LLM**: Computing Sα₂ (Vibe Coherence) requires an LLM call. Should this be computed asynchronously on a schedule (e.g., when issues are created) or synchronously in the scoring path? The current implementation accepts pre-computed `soulAlignment` as input, deferring this decision to the caller.

2. **Product lifecycle sensitivity**: Should dimension weights shift based on product phase? Pre-launch products may need Soul Alignment to dominate; post-launch may need Demand Pressure. If so, the model needs a lifecycle-phase parameter.

3. **Multi-product portfolio**: Does each product get its own PPA instance or is there a portfolio-level meta-algorithm? This is explicitly a non-goal for v1 but should be considered for the schema's extensibility.

4. **Soul health diagnostic**: When PPA scores cluster in the 0.3-0.5 range (nothing high, nothing low), it may signal the product's soul purpose needs revisiting. Should this trigger an automatic alert?

5. **Calibration data retention**: How long should priority-vs-outcome calibration data be retained? The default `lookbackPeriod: 90d` is a starting point but may need tuning per product velocity.

## References

- Alexander Kline, "The Product Priority Algorithm," Arcana Concept Studio, March 2026
- [RFC-0004: Cost Governance and Attribution](RFC-0004-cost-governance-and-attribution.md) — precedent for embedding policy in Pipeline.spec
- [RFC-0002: Pipeline Orchestration Policy](RFC-0002-pipeline-orchestration.md) — pipeline stage and failure policy design
- [RFC-0003: Infrastructure Provider Adapters](RFC-0003-infrastructure-adapters.md) — adapter registration and interface contracts
- Koren, "Collaborative Filtering with Temporal Dynamics," KDD 2009 — exponential decay for signal freshness
- Christensen, "The Innovator's Dilemma," 1997 — sustaining vs. disruptive innovation dynamics
