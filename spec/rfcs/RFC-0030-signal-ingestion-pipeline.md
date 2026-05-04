---
id: RFC-0030
title: Signal Ingestion Pipeline (Demand Sources → D1)
status: Draft
lifecycle: Draft
author: Alexander Kline
created: 2026-05-04
updated: 2026-05-04
targetSpecVersion: v1alpha1
requires:
  - RFC-0005
  - RFC-0008
  - RFC-0011
  - RFC-0029
requiresDocs: []
---

# RFC-0030: Signal Ingestion Pipeline (Demand Sources → D1)

**Document type:** Normative (draft)
**Status:** Draft v1 — Initial proposal. Reformulates D1 (Demand Pressure / Customer Signal Accumulation) to consume classified, clustered, SA-filtered demand from external sources rather than human-authored backlog items.
**Lifecycle:** Draft
**Authors:** Alexander Kline (Head of Product Strategy / Product Authority; PPA v1.0/v1.1 author)
**Requires:** RFC-0005 (PPA), RFC-0008 (PPA Triad Integration), RFC-0011 (DoR Gate), RFC-0029 (Product Pillar Architectural Vision — Principle 4 "The Soul Holds")

> The bold-style status block above is preserved for human readability. The YAML frontmatter at the top of the file is the source of truth for tooling.

---

## Sign-Off

| Person | Role | Status | Date |
|--------|------|--------|------|
| Alexander Kline | Head of Product Strategy / Product Authority | ✍️ Authored v1 | 2026-05-04 |
| Dominique Legault | CTO / Engineering Authority | ⏸ Pending | — |
| Morgan Hirtle | Chief of Design / Design Authority | ⏸ Pending | — |

## Revision History

| Version | Date | Author | Notes |
|---------|------|--------|-------|
| v1 | 2026-05-04 | Alexander | Initial draft. Defines the signal ingestion pipeline (frontline + community + CRM + competitive + in-app sources → classified clusters → SA filter → D1 input). Reformulates D1 to consume cluster-level demand instead of raw backlog items. Specifies tier multipliers (configurable per deployment) + recency decay + Tier 2 significance threshold. |

---

## 1. Summary

PPA v1.1 (RFC-0008) defines D1 (Customer Signal Accumulation) as a Demand Pressure sub-dimension scored against issues admitted to the pipeline. In practice, the framework today produces D1 input from human-authored backlog items — a manual translation from raw customer signal (support tickets, community discussions, CRM notes, competitive intelligence, in-app feedback) into Tracked Issues.

This translation is **lossy**: signal urgency, source characteristics, ICP match rate, and recency-of-mention all get flattened into the issue body. D1 then has to re-derive these from prose, with degraded fidelity.

This RFC defines a **Signal Ingestion Pipeline** that:

1. Accepts raw signals from configured external sources via pluggable adapters
2. Classifies signals on three deterministic axes (tier, ICP resonance, recency)
3. Clusters signals into demand themes
4. Filters clusters through SA resonance (per RFC-0029 Principle 4 "The Soul Holds") before they enter D1
5. Reformulates D1 to consume cluster-level demand with explicit weight + filter components

The pipeline is **non-replacement**: human-authored backlog items continue to feed D1 alongside signal-pipeline-generated demand. The pipeline adds a parallel input path; it does not remove the existing one.

## 2. Motivation

### 2.1 The current D1 input is human-translated, lossy

PPA v1.1 §3.1 specifies D1 as `Customer Signal Accumulation`, time-weighted and tier-weighted. The implementation reads from backlog items only. Every customer signal must be hand-translated by an operator before D1 can score it.

The translation loses:

- **Source-tier characteristics** — was this a churned-customer complaint, a Free-tier feature request, or an Enterprise renewal blocker?
- **ICP resonance** — does the signal come from the product's ideal customer profile, or peripheral users?
- **Recency-of-mention** — was this raised once 18 months ago, or surfaced in 12 conversations this quarter?
- **Cluster context** — three independent reports of the same underlying problem are stronger evidence than one report; the translation usually preserves only the most-recent surfacing

Without these, D1's scoring is a noisy approximation of demand. PPA v1.1 §3.1 documents the tier-weighting ambition; this RFC supplies the input pipeline that makes it real.

### 2.2 The product needs to listen automatically

Per RFC-0029 Principle 4 ("The Soul Holds"), the product should listen to the market without obeying the market. That implies:

- The framework consumes signals automatically (no manual translation step)
- The framework **filters** signals through SA resonance before they enter scoring (high-SA = full weight; low-SA = discounted; zero-SA = excluded but logged for Product review)
- The framework surfaces low-SA but high-volume signals as "demand for a different product" — flagged for human triage, not silently ignored

The signal ingestion pipeline operationalizes all three.

### 2.3 The clustering step is itself information

Three signals about "search performance" from different sources, different tiers, and over different time windows aggregate into a stronger demand signal than any individual signal. The clustering step preserves this aggregation. Without it, D1 sees three separate items each at one-third weight; with it, D1 sees one cluster at full aggregate weight.

### 2.4 Configurable tier weights respect deployment heterogeneity

A B2B enterprise platform may weight Enterprise customers 5×; a consumer product may flatten the tiers. The pipeline's tier weights MUST be configurable per deployment, with default values calibrated for a typical mixed-customer SaaS product. Configuration changes require Product Lead approval (governance-relevant decisions).

## 3. Goals

1. **Pluggable source adapters** — same pattern as RFC-0010 §13 harness adapters and RFC-0019 embedding adapters
2. **Deterministic-first classification** — tier, ICP resonance, recency computed from structured signal metadata where possible; LLM only for free-text ICP-match disambiguation
3. **Cluster-level demand** — signals about the same underlying need aggregate into a cluster; D1 scores clusters, not individual signals
4. **SA resonance filter on demand** — Principle 4: high-SA full weight, mid-SA discounted, low-SA flagged for review, zero-SA excluded
5. **Configurable per deployment** — tier multipliers, ICP resonance weights, recency half-life, Tier 2 significance threshold all operator-tunable
6. **Reformulated D1** — consumes cluster-level demand with explicit filter components in the formula
7. **Non-replacement of manual flow** — human-authored backlog items continue to feed D1; the pipeline is a parallel input path

## 4. Non-Goals

1. **Not a CRM** — the pipeline reads from external sources; it does not store customer relationship data
2. **Not a sentiment analysis engine** — classification operates on tier + ICP + recency, not emotional valence
3. **Not a privacy/anonymization layer** — adapters are responsible for source-specific privacy guarantees; the pipeline assumes signals arriving are already privacy-cleared
4. **Not a feature voting system** — the pipeline records signal weight, not votes; clusters are derived from semantic similarity, not user voting
5. **Not retroactive** — signals predating pipeline activation can be backfilled via adapter, but the pipeline's recency decay applies (old signals get heavily decayed weight)

## 5. Source Adapters

The pipeline accepts signals from configured sources via the `SignalSourceAdapter` interface. Reference adapters (initial set):

| Source | Adapter | Signal Tier (default) |
|---|---|---|
| Customer support tickets (Zendesk, Intercom, Help Scout) | `signal-source-support-ticket` | Tier 1 |
| Sales call notes / CRM (Salesforce, HubSpot) | `signal-source-crm-note` | Tier 1 |
| Community discussions (Discord, Slack community, Discourse) | `signal-source-community-thread` | Tier 2 |
| In-app feedback widgets (e.g., Productboard) | `signal-source-in-app-feedback` | Tier 1 |
| Competitive intelligence (manual entry, periodic) | `signal-source-competitive-intel` | Tier 2 |

### 5.1 Adapter contract

```typescript
export interface SignalSourceAdapter {
  name: string;                      // e.g., 'support-ticket-zendesk'
  defaultTier: 1 | 2;
  fetchSignals(since: Date): Promise<RawSignal[]>;
  isAvailable(): Promise<boolean>;
}

export interface RawSignal {
  sourceId: string;                  // e.g., zendesk-ticket-12345
  sourceTimestamp: Date;
  customerId?: string;               // optional; tier inference depends on it
  customerTier?: 'enterprise' | 'mid' | 'smb' | 'free' | 'churned';
  payload: string;                   // free-text body
  metadata?: Record<string, unknown>;
}
```

Adapters MUST NOT mutate signals once fetched. Re-fetches are idempotent (deduplicated by `sourceId`).

## 6. Classification

Each raw signal is classified on three deterministic axes:

### 6.1 Tier

| Tier | Default weight | Default multiplier |
|---|---|---|
| Enterprise | `1.0` baseline | `3.0` |
| Mid-market | `1.0` baseline | `1.5` |
| SMB | `1.0` baseline | `1.0` |
| Free | `1.0` baseline | `0.5` |
| **Churned** | `1.0` baseline | **`2.0`** |

The Churned multiplier (`2.0`) is the highest. Demand validated by willingness-to-pay-and-found-wanting carries the strongest signal of product-market gap. Most systems ignore churned customers; this pipeline amplifies them.

Tier inference order:
1. Adapter-provided `customerTier` (when source supports tier metadata)
2. `customerId` lookup against configured tier registry (when registry is configured)
3. Default tier per source adapter (Tier 1 for support, Tier 2 for community)

### 6.2 ICP Resonance

| Resonance | Default weight |
|---|---|
| Strong | `1.5` |
| Partial | `1.0` |
| Weak | `0.5` |

Strong = signal source matches declared ICP segments verbatim. Partial = adjacent segment (e.g., enterprise but wrong industry vertical). Weak = peripheral (e.g., student account on a B2B product).

ICP resonance is computed deterministically when the adapter supplies structured customer metadata (industry, segment, size). For free-text-only sources, an LLM-tie-breaker pass classifies into `strong / partial / weak` per the deterministic-first principle (RFC-0029 Principle 2). The LLM never assigns "very strong" or "very weak" — only the three tiers.

### 6.3 Recency Decay

Exponential decay with **30-day half-life** (default; configurable). Signals older than ~6 months contribute < 2% of their original weight; old signals don't disappear, they just become background.

Recency decay is applied at scoring time, not at ingest time, so the pipeline doesn't need to re-compute weights as time passes (the decay function takes age as input).

## 7. Clustering

Signals are clustered into demand themes. Clustering is configurable, with defaults:

- **Algorithm**: BM25 + structural overlap by default; optional embedding-based clustering when an embedding adapter (RFC-0019) is configured
- **Threshold**: clusters merge when pairwise BM25 similarity > 0.6 (configurable)
- **Minimum cluster size**: 1 (singleton clusters allowed)
- **Maximum cluster size**: no cap (a cluster may absorb arbitrarily many signals)

Cluster-level metadata aggregated from member signals:

```typescript
interface DemandCluster {
  clusterId: string;
  signals: RawSignal[];
  topSummary: string;                  // adapter or LLM-generated summary of the cluster theme
  saResonance: number;                 // [0, 1]; computed against current Soul DID
  icpMatchRate: number;                // [0, 1]; fraction of strong-resonance member signals
  churnCorrelation: number;            // [0, 1]; fraction of churned-customer member signals
  oldestSignalAt: Date;
  newestSignalAt: Date;
  signalCount: number;
  uniqueSources: number;
}
```

## 8. Tier 2 Significance Threshold

Tier 2 signals (community, competitive) only feed D1 when a cluster crosses a significance threshold:

- 5+ signals in cluster
- 3+ unique sources
- ≥1 Tier 1 signal in cluster
- 7+ days old (the cluster has persisted past initial-buzz)

Below threshold: cluster is **monitored** but does not feed D1 scoring. Above threshold: cluster joins the D1 pipeline at full Tier 2 weight.

Rationale: ambient signal (community chatter, competitive observations) confirms and amplifies direct signal (support tickets, CRM notes); it does not replace direct signal. A cluster with 30 community mentions and zero Tier 1 signals is buzz, not demand.

## 9. SA Resonance Filter (per RFC-0029 Principle 4)

Per cluster, SA resonance is computed against the current Soul DID using the deterministic-first SA assessment (PPA v1.2 direction).

| `cluster.saResonance` | D1 effect |
|---|---|
| ≥ 0.7 | Full weight. Demand aligns with product identity. |
| 0.4 – 0.7 | Weight × 0.7. Adjacent to identity. Include but discount. |
| < 0.4 | Weight × 0.3. Flag for Product Lead review (low-SA but real demand). |
| 0.0 (scope gate) | Excluded from D1. Logged as out-of-scope demand for separate triage. |

When aggregate cluster SA resonance across the demand pipeline drops below 0.4 sustained for 3 sprints, a `SoulDriftDetected` event fires with `driftSource: 'demandMisalignment'` indicating incoming demand is diverging from the product's soul.

## 10. Reformulated D1 Formula

```
D1(cluster) = Σ over signals in cluster:
    signal.baseWeight              # 1.0 Tier 1; 0.3 Tier 2 above threshold; 0 Tier 2 below
    × signal.tierMultiplier        # configurable per deployment; defaults in §6.1
    × signal.icpResonance          # configurable per deployment; defaults in §6.2
    × signal.recencyDecay          # exp(-age_days × ln(2) / half_life_days)
    × cluster.saResonance          # filter per §9
```

D1 is normalized across all active clusters to `[0, 1]` and fed into the existing PPA D formula (PPA v1.1 §3.1).

## 11. Configurable Parameters

The full set of operator-tunable parameters with defaults:

```yaml
# .ai-sdlc/signal-ingestion.yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: SignalIngestionConfig
spec:
  enabled: false                     # default OFF; explicit opt-in
  tierMultipliers:
    enterprise: 3.0
    mid: 1.5
    smb: 1.0
    free: 0.5
    churned: 2.0
  icpResonanceWeights:
    strong: 1.5
    partial: 1.0
    weak: 0.5
  recencyHalfLifeDays: 30
  tier2SignificanceThreshold:
    minSignalCount: 5
    minUniqueSources: 3
    minTier1SignalCount: 1
    minClusterAgeDays: 7
  saResonanceThresholds:
    fullWeight: 0.7
    discounted: 0.4
    excluded: 0.0
  clustering:
    algorithm: bm25                  # or 'embedding' when RFC-0019 adapter configured
    similarityThreshold: 0.6
  adapters:
    - signal-source-support-ticket
    - signal-source-community-thread
```

Configuration changes require Product Lead approval (logged as governance events; not DID changes but governance-relevant).

## 12. Composition with DoR (RFC-0011)

Cluster-derived issues that flow from the signal ingestion pipeline into the backlog inherit a partial auto-pass on DoR Gates 1, 4, 5, 6 (testable AC, bounded scope, named surface, describable done-state) — these are satisfied by construction since the pipeline structures its output.

Gates 2, 3, 7 (markers, references, dependencies) still run as structural checks regardless of source.

This requires AdmissionInput to gain a `sourceType: 'signal-pipeline'` field per RFC-0029 Part II's RFC-0024 cross-reference.

## 13. Open Questions

### 13.1 Adapter authentication / credential management

The pipeline needs OAuth tokens / API keys for many sources. Should credential management be in this RFC, or delegated to a future RFC? **Position**: delegate to a future "Adapter Credential Management" RFC; this RFC requires only that adapters can self-validate.

### 13.2 Multi-language signal processing

Sources may produce signals in non-English languages. Tier classification works on metadata (language-independent); ICP resonance and clustering on text payloads do not. **Position**: defer multi-language support to v2; v1 ships English-only with the limitation documented.

### 13.3 Privacy / customer-data residency

Signals from EU customers may be subject to GDPR; signals from healthcare may be HIPAA-protected. **Position**: delegate to RFC-0022 (Compliance Posture). Adopters declaring HIPAA / GDPR posture get adapter-level data-handling guidance derived from regime mapping.

### 13.4 Manual signal entry

Operators may want to enter signals manually (e.g., from a phone call). Should the pipeline accept manual entries? **Position**: yes, via a `signal-source-manual` adapter that requires `attestedBy` + `attestedAt` fields. Treats manual entries as Tier 1.

### 13.5 Adversarial signal injection

A bad actor could flood the community channel with fabricated signals. **Position**: the Tier 2 significance threshold (≥1 Tier 1 signal required) provides partial defense. A future RFC can add reputation-weighting per source if observed in practice.

## 14. Non-goals (re-stated)

- Not a CRM. Not a sentiment analysis engine. Not a privacy layer. Not a feature voting system. Not retroactive (within the limit of recency decay).

## 15. References

- **RFC-0005**: Product Priority Algorithm (PPA framework spec)
- **RFC-0008**: PPA Triad Integration (D1 specification)
- **RFC-0010**: Parallel Execution + Worktree Pooling (§13 harness adapter pattern this RFC mirrors)
- **RFC-0011**: Definition-of-Ready Gate (composition with DoR; partial auto-pass)
- **RFC-0019**: Embedding Provider Adapter (optional clustering algorithm)
- **RFC-0022**: Compliance Posture + Audit Surface (privacy / regime defaults)
- **RFC-0024**: Emergent Issue Capture + Triage (AdmissionInput sourceType)
- **RFC-0029**: Product Pillar Architectural Vision (Principle 4 "The Soul Holds")

---

**End of RFC-0030.**
