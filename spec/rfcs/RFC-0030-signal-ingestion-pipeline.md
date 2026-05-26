---
id: RFC-0030
title: Signal Ingestion Pipeline (Demand Sources → D1)
status: Draft
lifecycle: Ready for Review
author: Alexander Kline
created: 2026-05-04
updated: 2026-05-26
targetSpecVersion: v1alpha1
requires:
  - RFC-0005
  - RFC-0008
  - RFC-0011
  - RFC-0019
  - RFC-0022
  - RFC-0024
  - RFC-0025
  - RFC-0029
  - RFC-0035
requiresDocs: []
---

# RFC-0030: Signal Ingestion Pipeline (Demand Sources → D1)

**Document type:** Normative
**Status:** Ready for Review v0.3 — operator OQ re-walkthrough complete 2026-05-26 with **full rigor rubric** (problem statement → industry research → 3-4 options → recommendation + counter-argument per OQ) after 2026-05-16 first-pass was flagged as too shallow. Refinements over v0.2: (OQ-13.1) env-var-only adapter scope for v1 + dual Decision routing (`adapter-credential-not-configured` vs `adapter-credential-rejected`); (OQ-13.2) per-org `acceptedLanguages` config + explicit `franc` library for language detection + documented BM25 quality degradation for multi-language; (OQ-13.3) **specified per-stage residency enforcement points** (fetchSignals, clustering, storage, unified-report) + multi-posture UNION composition forward-compat; (OQ-13.4) per-operator rate limit (default 10/day) + optional `evidenceUrl` field + manual-share quality metric (`Decision: manual-signal-share-elevated` when >30% sustained); (OQ-13.5) z-score flooding detection on 7d rolling baseline + quarantine state + operator one-click unquarantine (logs `signal-flooding-false-positive` for v2 reputation-weighting calibration). Operator-impacting events (unsupported language, residency violation, attestation gap, flooding) **route through [RFC-0035 G0 non-blocking pipeline contract](RFC-0035-decision-catalog-operator-routing.md)** — pipeline never halts. §11 config schema updated to reflect refinements. Original phase tasks AISDLC-343..348 shipped (in `backlog/completed/`); follow-up refinement tasks AISDLC-430..434 land on top of shipped substrate.
**Lifecycle:** Ready for Review
**Updated:** 2026-05-26
**Authors:** Alexander Kline (Head of Product Strategy / Product Authority; PPA v1.0/v1.1 author)
**Requires:** RFC-0005 (PPA), RFC-0008 (PPA Triad Integration), RFC-0011 (DoR Gate), RFC-0019 (Embedding Provider Adapter — clustering option), RFC-0022 (Compliance Posture — data residency per OQ-13.3), RFC-0024 (Emergent Capture — catalog substrate), RFC-0025 (Framework Quality Monitoring — over-blocking audit), RFC-0029 (Product Pillar Architectural Vision — Principle 4 "The Soul Holds"), RFC-0035 (Decision Catalog — G0 non-blocking routing)

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
| v0.2 | 2026-05-16 | dominique | Operator OQ walkthrough resolved all 5 §13 OQs. Resolutions: delegate adapter credentials to future RFC (OQ-13.1); English-only v1 with multi-language deferred to v2 (OQ-13.2); delegate data residency to RFC-0022 Compliance Posture (OQ-13.3); `signal-source-manual` adapter with forced `attestedBy` + auto-filled `attestedAt` from git committer (OQ-13.4; reuses RFC-0022 OQ-2 audit-trail pattern); Tier 2 significance threshold as v1 partial defense with reputation-weighting as future Decision (OQ-13.5). Cross-cutting framing: operator-impacting events (unsupported language, residency violation, attestation gap, flooding) route through RFC-0035 G0 catalog. Frontmatter requires expanded: added RFC-0019 (embedding clustering option), RFC-0022 (residency), RFC-0024 (capture substrate), RFC-0025 (audit), RFC-0035 (catalog routing). Lifecycle promoted Draft → Ready for Review. Implementation broken into 6 phase tasks: AISDLC-343 (Phase 1 adapter interface + 2 default adapters), AISDLC-344 (Phase 2 classification), AISDLC-345 (Phase 3 clustering BM25 default + embedding option), AISDLC-346 (Phase 4 significance + SA + flooding), AISDLC-347 (Phase 5 D1 formula + RFC-0008 integration), AISDLC-348 (Phase 6 schema + governance events + runbook). |
| v0.3 | 2026-05-26 | dominique (Operator re-walkthrough) | Re-walked all 5 §13 OQs with **full rigor rubric per OQ** (problem statement → industry research → 3-4 options with tradeoffs → recommendation + counter-argument). 2026-05-16 first-pass resolutions flagged as too shallow ("skims over questions and recommends authors' recommendations"); this re-walkthrough surfaces substantive refinements on every OQ. Refinements: **(OQ-13.1)** v1 env-var-only adapter scope explicit (`signal-source-manual`, support-ticket via PAT, in-app-feedback via API key, community-thread via Discord/Slack bot token; OAuth-required adapters wait for credential-mgmt RFC) + dual Decision routing (`adapter-credential-not-configured` vs `adapter-credential-rejected`). **(OQ-13.2)** per-org `acceptedLanguages` config + explicit `franc` library for language detection (deterministic, <10ms, JS-native, MIT) + documented BM25 quality degradation (~15-30% precision drop for multi-language) — adopters opt in knowingly. **(OQ-13.3)** explicit per-stage residency enforcement points (fetchSignals tag check, clustering cross-region prevention, storage residencyRegion field, unified-report region boundaries) + multi-posture UNION composition forward-compat (strictest regime applies when adopter declares multiple). **(OQ-13.4)** RFC-0022 OQ-2 audit-trail pattern preserved + per-operator rate limit (default 10/day, per-org configurable) + optional `evidenceUrl` field + manual-share quality metric (`Decision: manual-signal-share-elevated` when >30% rolling 7d sustained). **(OQ-13.5)** z-score flooding detection on 7d rolling baseline (>3σ AND <3 unique sources in 1h window) + quarantine state (signals recorded but not D1-fed; default 24h) + operator one-click unquarantine (logs `signal-flooding-false-positive` for v2 reputation-weighting calibration) + reputation-weighting explicitly deferred to v2 (cold-start unsafe in v1). §11 config schema expanded with `languageDetection`, `residencyEnforcement`, `manualEntry` hardening, `flooding` blocks. Original phase tasks AISDLC-343..348 shipped (in `backlog/completed/`); follow-up refinement tasks AISDLC-430..434 land on top of shipped substrate. Practitioner-validation gates remain pending corpus run. |

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
  adapters:                          # OQ-13.1 re-walkthrough: env-var-based v1 only
    - signal-source-manual
    - signal-source-support-ticket
    - signal-source-community-thread
    - signal-source-in-app-feedback

  # NEW (re-walkthrough): language detection + acceptance config (OQ-13.2)
  languageDetection:
    library: franc                   # deterministic; <10ms per signal; JS-native; MIT
    acceptedLanguages: [en]          # default English-only; orgs opt in to [en, fr, es, ...]
                                     # multi-language enables degraded BM25 (~15-30% precision drop)
    onUnsupported: drop-and-log      # Decision: signal-language-unsupported

  # NEW (re-walkthrough): per-stage residency enforcement (OQ-13.3)
  residencyEnforcement:
    sourceFromCompliancePosture: true   # RFC-0022 owns regime declaration
    enforcementPoints:
      fetchSignals: true                 # check signal residency tag against allowed regions
      clustering: true                   # prevent cross-region cluster merging when regime requires
      storage: true                      # persist residencyRegion field; cross-region read = elevated audit
      unifiedCostReport: true            # respect region boundaries in cost attribution
    multiPostureBehavior: union          # when adopter declares multiple regimes, strictest applies

  # NEW (re-walkthrough): manual-entry anti-gaming (OQ-13.4)
  manualEntry:
    auditTrail:                          # preserved from v0.2 (RFC-0022 OQ-2 pattern)
      forcedAttestedBy: true
      autoFillAttestedAt: true           # from git committer
    dailyCapPerOperator: 10              # per-operator rate limit (NEW)
    evidenceUrlOptional: true            # optional evidenceUrl field (NEW)
    qualityMetric:                       # manual-share quality metric (NEW)
      enabled: true
      windowDays: 7
      shareWarningThreshold: 0.30        # >30% rolling 7d → Decision: manual-signal-share-elevated

  # NEW (re-walkthrough): adversarial-injection defense (OQ-13.5)
  flooding:
    detection:
      algorithm: z-score                 # rolling 7d baseline per source
      zScoreThreshold: 3.0
      windowMinutes: 60
      minUniqueSourcesForSuspicion: 3
      baselineDays: 7
    quarantine:
      enabled: true
      durationHours: 24                  # quarantined signals not fed to D1; operator can unquarantine
      operatorUnquarantineLogs: signal-flooding-false-positive
                                         # feedback into v2 reputation-weighting calibration
    reputationWeighting:
      shipsInVersion: v2                 # cold-start unsafe in v1; requires 7+ corpus windows
```

Configuration changes require Product Lead approval (logged as governance events; not DID changes but governance-relevant). **Re-walkthrough additions (2026-05-26)** marked NEW above: env-var-only adapter scope (OQ-13.1); languageDetection block (OQ-13.2); residencyEnforcement block (OQ-13.3); manualEntry hardening (OQ-13.4); flooding detection block (OQ-13.5).

## 12. Composition with DoR (RFC-0011)

Cluster-derived issues that flow from the signal ingestion pipeline into the backlog inherit a partial auto-pass on DoR Gates 1, 4, 5, 6 (testable AC, bounded scope, named surface, describable done-state) — these are satisfied by construction since the pipeline structures its output.

Gates 2, 3, 7 (markers, references, dependencies) still run as structural checks regardless of source.

This requires AdmissionInput to gain a `sourceType: 'signal-pipeline'` field per RFC-0029 Part II's RFC-0024 cross-reference.

## 13. Open Questions — resolved (operator re-walkthrough 2026-05-26 with full rubric)

> **Resolution status (2026-05-26):** All 5 OQs re-walkthrough'd with **full rigor rubric** per OQ (problem statement → industry research → 3-4 options with tradeoffs → recommendation + counter-argument). The 2026-05-16 first-pass resolutions were flagged as too shallow ("skims over questions and recommends authors' recommendations"); this re-walkthrough surfaces substantive refinements on every OQ. **Cross-cutting framing:** operator-impacting events route through [RFC-0035 G0 non-blocking pipeline contract](RFC-0035-decision-catalog-operator-routing.md). §11 config schema updated to reflect refinements. Original phase tasks AISDLC-343..348 shipped (in `backlog/completed/`); follow-up refinement tasks AISDLC-430..434 land on top of shipped substrate.

### 13.1 Adapter authentication / credential management

The pipeline needs OAuth tokens / API keys for many sources. Should credential management be in this RFC, or delegated to a future RFC? **Position**: delegate to a future "Adapter Credential Management" RFC; this RFC requires only that adapters can self-validate.

**Resolution (2026-05-26 re-walkthrough, full rubric):** **Delegate credential lifecycle to future RFC + ENV-VAR-ONLY v1 adapter scope + DUAL Decision routing.** Industry research: AWS SDK uses credentials chain separate from per-service APIs; GitHub Actions secrets are platform-level not per-action; Kubernetes `Secret` is core API not per-controller; LangChain / RFC-0019 EmbeddingAdapter use per-provider env-var convention; OAuth-required services (Salesforce, full Zendesk, HubSpot) need refresh-token lifecycle the env-var pattern doesn't cover. **Two substantive gaps in v0.2 surfaced by re-walkthrough:** (1) v0.2 didn't specify v1-shippable adapter scope, leaving Phase 1 ambiguous about which adapters ship now vs. wait; (2) v0.2 collapsed credential-not-configured (env var missing → setup task) and credential-rejected (env var present but auth failed → rotation task) into one `Decision: adapter-credential-invalid` — different states, different downstream operator actions. **Refinement over v0.2:** (a) v1 ships **env-var-based adapters ONLY** (`signal-source-manual`, `signal-source-support-ticket` via Zendesk PAT, `signal-source-in-app-feedback` via API key, `signal-source-community-thread` via Discord-bot-token / Slack-bot-token). OAuth-required adapters (full Salesforce / HubSpot integrations, Zendesk-with-OAuth-scopes) wait for credential-mgmt RFC. (b) Two distinct Decisions: `adapter-credential-not-configured` (emit setup task) vs `adapter-credential-rejected` (emit rotation task). Pipeline continues with remaining valid adapters in both cases. **Counter-argument:** "Env-var-only v1 is too limited — Zendesk PAT can't access all support data for tier inference." Rebuttal: tier inference reads per-customer metadata which Zendesk PAT exposes for ticket-owner records; PAT subset covers the v1 use case (read tickets, read customer tier). OAuth would unlock write-back + comment-threads + agent metadata — those are Phase 2+ enrichment, not D1 inputs. **Selected over v0.2** because v0.2's silence on v1 scope leaves Phase 1 implementers guessing AND single-Decision routing collapses two distinct operator actions. **Selected over inline credential management** because OAuth lifecycle is a substantial separate concern. **Selected over pure delegation with no v1 adapter spec** because v1 needs at least one working end-to-end path to validate the pipeline shape.

### 13.2 Multi-language signal processing

Sources may produce signals in non-English languages. Tier classification works on metadata (language-independent); ICP resonance and clustering on text payloads do not. **Position**: defer multi-language support to v2; v1 ships English-only with the limitation documented.

**Resolution (2026-05-26 re-walkthrough, full rubric):** **English-only DEFAULT + per-org `acceptedLanguages` opt-in + explicit `franc` library for language detection.** Industry research: BM25 is degraded-but-functional in any language (Robertson & Zaragoza §3.5 — ~15-30% precision drop without per-language stopwords/stemming, NOT broken); multilingual embeddings exist (`cohere-embed-multilingual-v3`, `openai text-embedding-3-large`, `multilingual-e5-large`); modern LLMs (Claude, GPT-4) handle 50+ languages natively for ICP-resonance classification; customer-support platforms (Zendesk, Intercom) support multi-language tickets via language detection + per-language indexing; `franc` (JS-native, no model download, deterministic, MIT-licensed) and `langdetect` (Python port of Google CLD) are standard detection libraries with 95%+ accuracy on text >50 chars. **Two substantive flaws in v0.2 surfaced by re-walkthrough:** (1) "multi-language is hard" framing is wrong on 2 of 3 stages — BM25 is degraded-but-works, LLM ICP-resonance is native-multi-language; the actual cost of multi-language v1 is **clustering precision**, not pipeline correctness. (2) v0.2 said "non-English signal detection at classifier" but didn't specify HOW — Phase 1 implementers would each pick a detection mechanism (`franc` vs `langdetect` vs LLM-based) creating inconsistency. **Refinement over v0.2:** (a) Default English-only (matches conservative intent); per-org `acceptedLanguages: [en, fr, es, ...]` config with documented BM25 quality degradation in operator runbook — orgs with non-English customer bases opt in knowingly. (b) Explicit `franc` library specified for language detection (deterministic, <10ms per signal, free, JS-native). (c) Non-accepted-language signals → `Decision: signal-language-unsupported` (drop + log to catalog for visible-gap metric). **Counter-argument:** "Letting adopters enable multi-language without per-language BM25 stopword calibration is a footgun — clustering quality silently degrades." Rebuttal: 15-30% precision drop is the documented worst case (well-studied across languages), not a surprise. Operator runbook explicitly states the trade-off; per-org opt-in is the right model for "you know your data better than the framework does." Composes with per-org-configurability convention. **Selected over v0.2 (English-only with drop)** because v0.2 loses signal from non-English markets AND leaves detection mechanism unspecified. **Selected over multi-language v1 force-all** because English-first orgs pay clustering-precision tax for capability they don't need. **Selected over LLM-based language detection** because `franc`'s 95%+ accuracy on text >50 chars is sufficient for the routing decision; LLM-based is 100-500× slower, costs more, and is less deterministic.

### 13.3 Privacy / customer-data residency

Signals from EU customers may be subject to GDPR; signals from healthcare may be HIPAA-protected. **Position**: delegate to RFC-0022 (Compliance Posture). Adopters declaring HIPAA / GDPR posture get adapter-level data-handling guidance derived from regime mapping.

**Resolution (2026-05-26 re-walkthrough, full rubric):** **Delegate regime declaration to RFC-0022 + specified per-stage enforcement points + multi-posture UNION forward-compat.** Industry research: AWS uses regional services + IAM policy = enforcement at API call layer; Stripe Atlas residency per-customer with payment routing; Salesforce Hyperforce blocks cross-region replication unless declared; GDPR/HIPAA/CCPA all require enforcement at data-handling layer (not just policy declaration); "let compliance team handle this" anti-pattern FAILS when no actual mechanism wires in. RFC-0022 (Ready for Review) owns regime declaration + `derivedGates` mapping. **Substantive gap in v0.2 surfaced by re-walkthrough:** v0.2 said "adapters consume per-regime data-handling guidance via `compliance.derivedGates` lookup" but never specified the **enforcement points for THIS pipeline** — `signal-residency-violation` is abstract; it has concrete enforcement points needing definition. **Refinement over v0.2:** keep RFC-0022 as regime-declaration source (architecturally correct) and add explicit per-stage enforcement spec: (a) at adapter `fetchSignals()` — per-signal residency tag from upstream metadata (Zendesk org region, Salesforce sandbox region) checked against declared posture's allowed regions; (b) at clustering — residency-tagged signals MUST NOT co-mingle across forbidden region boundaries (GDPR-strict: EU customer signals never cluster with US customer signals); (c) at storage — signal records persist with `residencyRegion` field; cross-region read requires elevated audit; (d) at unified-cost-report (from RFC-0019 OQ-7) — cost-attribution respects region boundaries. Residency violation → `Decision: signal-residency-violation` → auto-action: refuse signal + log to catalog + emit `compliance.yaml regimeOverrides` clarification task. **Multi-posture forward-compat**: when RFC-0022 OQ-7 ships multi-posture (adopter declares both HIPAA AND GDPR), signal-pipeline takes UNION of regime constraints (strictest applies). **Counter-argument:** "Specifying enforcement points here duplicates RFC-0022's surface; let RFC-0022 own end-to-end." Rebuttal: RFC-0022 owns the regime → controls **mapping** (abstract: "GDPR → encryption-at-rest, residency, right-to-erasure"); pipeline-specific **enforcement** (which signal-pipeline operations gate? what happens at cluster boundaries?) is per-substrate. RFC-0022 can't enumerate every consuming substrate's enforcement points — that's the consuming substrate's job (same pattern as RFC-0019 specifying its own embedding-substrate enforcement; RFC-0024 specifying its capture-substrate enforcement). **Selected over v0.2 (delegation with hand-wave)** because Phase 1 implementers would reinvent residency enforcement ad-hoc — guaranteed inconsistency across adopter deployments. **Selected over inline privacy spec in this RFC** because regime-declaration belongs in RFC-0022 (separation of concerns). **Selected over no-residency-v1** because compliance-relevant adopters can't ship without it.

### 13.4 Manual signal entry

Operators may want to enter signals manually (e.g., from a phone call). Should the pipeline accept manual entries? **Position**: yes, via a `signal-source-manual` adapter that requires `attestedBy` + `attestedAt` fields. Treats manual entries as Tier 1.

**Resolution (2026-05-26 re-walkthrough, full rubric):** **Forced audit-trail (RFC-0022 OQ-2 pattern) + per-operator rate limit + optional `evidenceUrl` field + manual-share quality metric.** Industry research: SOC2 CC7.2 / FDA 21 CFR Part 11 / HIPAA accountability all require WHO + WHEN + WHAT + WHY audit; Salesforce inline edit has heavy audit-trail; JIRA / Linear use lighter audit-trail; anti-gaming patterns include per-user rate limiting (Wikipedia 6/min new pages), evidence-link requirement (Stack Overflow citations), source-evidence linking (academic citations); OKR / metric-input systems track manual:automated ratio as a quality signal. **Three substantive gaps in v0.2 surfaced by re-walkthrough:** (1) **no rate limiting** — attestation prevents identity-laundering but NOT volume; operator could attest 50 fabricated signals in one session, all passing audit-trail. (2) **No evidence-link mechanism** — attestation says "I vouch"; evidence-link says "...and here's the call recording / chat transcript." Without it, manual entries are unfalsifiable claims. (3) **No manual-share quality metric** — if manual signals dominate (say >40% of D1 input), the pipeline is acting as a data-entry tool, not automated demand-detection — anti-pattern that should surface. **Refinement over v0.2:** keep RFC-0022 OQ-2 audit-trail pattern (forced `attestedBy` + auto-filled `attestedAt` from git committer; proven, in production) and add three anti-gaming hooks: (a) per-operator rate limit (default 10 manual signals per operator per day; per-org configurable via `manualEntry.dailyCapPerOperator`); above cap → `Decision: manual-signal-rate-limit-exceeded` → operator escalates via batch review. (b) Optional `evidenceUrl` field (call recording, ticket URL, transcript link) — when present, audit trail is materially stronger; when absent, attested observation stands but is flagged in quality metric. (c) Manual-share quality metric: track `manualSignals / totalSignals` rolling 7d; when >30% sustained → `Decision: manual-signal-share-elevated` (warning, not block — surfaces architectural anti-pattern to operator). Manual entries missing forced fields → `Decision: manual-signal-incomplete` (preserved from v0.2). **Counter-argument:** "10/day rate limit is arbitrary — what's the principled basis?" Rebuttal: it's the framework default, not fixed limit. Reasoning: a single operator processing >10 high-signal conversations per day for the framework specifically is exceptional (most operator-time goes elsewhere); 10/day allows ~50/week which captures sales-team conference-week scenarios; per-org override exists for genuinely high-throughput contexts. Principled basis: "make gaming require sustained effort while not blocking legitimate use." Exact number is operator-tunable. **Selected over v0.2 (forced attestation only)** because v0.2 is structurally easy to game via volume. **Selected over no-manual-entry** because manual signal IS valuable (phone calls, conference conversations, hallway feedback) — outright refusal loses real signal. **Selected over mandatory-evidenceUrl** because requiring URL blocks legitimate untranscribed observations (sales conversation in hallway, customer feedback at trade show).

### 13.5 Adversarial signal injection

A bad actor could flood the community channel with fabricated signals. **Position**: the Tier 2 significance threshold (≥1 Tier 1 signal required) provides partial defense. A future RFC can add reputation-weighting per source if observed in practice.

**Resolution (2026-05-26 re-walkthrough, full rubric):** **Tier 2 significance threshold (preserved) + z-score flooding detection on 7d rolling baseline + quarantine state + operator one-click unquarantine + reputation-weighting deferred to v2 (corpus-calibrated).** Industry research: spam/abuse detection patterns use rate limiting + z-score anomaly detection on rolling baselines + behavioral baselines; GitHub Actions abuse uses per-org rate limits + IP throttling; HackerOne / Bugcrowd use reputation-weighting per researcher (analogous pattern); Discord / Slack trust-level systems restrict new members; anti-spam in email uses reputation scoring (DKIM, SPF, sender reputation gradients); Wikipedia editor reputation + revert tracking; z-score thresholds in production systems typically 2.5-3.0σ. Time-window choice: 1h catches burst attacks, 24h catches slow-drip, 7d establishes baseline — most production systems use cascading. **Four substantive gaps in v0.2 surfaced by re-walkthrough:** (1) **Flooding-detection algorithm unspecified** — v0.2 said "volume spike + low source diversity" but didn't specify algorithm (static threshold? z-score? per-source baseline?); Phase 1 implementer choice creates cross-deployment inconsistency. (2) **Time-window unspecified** — 1h vs 24h vs 7d catch different attack shapes. (3) **Auto-throttle behavior unspecified** — v0.2 said "auto-throttle low-confidence sources" but what does throttle mean? (4) **Recovery from false-positive throttling unspecified** — legitimate signal spikes happen (genuine new bug surfacing); without explicit recovery, automated throttling becomes a denial-of-service vector against legitimate signal. **Refinement over v0.2:** four-part specification — (a) **Detection algorithm**: z-score on rolling 7-day baseline per source; trigger `Decision: signal-flooding-detected` when `volume > 3σ` AND `uniqueSources < 3` within 1h window. Per-org configurable thresholds: `flooding.detection.zScoreThreshold` (default 3.0), `flooding.detection.windowMinutes` (default 60), `flooding.detection.minUniqueSourcesForSuspicion` (default 3), `flooding.detection.baselineDays` (default 7). (b) **Auto-action**: quarantine — flooding signals recorded with `quarantined: true` flag; quarantined signals do NOT feed D1; Decision surfaces to operator batch review. Quarantine duration default 24h (per-org `flooding.quarantineDurationHours`). (c) **Operator recovery**: TUI batch-review surface includes one-click unquarantine; unquarantine logs `Decision: signal-flooding-false-positive` (feedback into v2 reputation-weighting calibration). (d) **Reputation-weighting**: deferred to v2 once 7+ corpus windows have accumulated per-source baseline data sufficient to compute reputation reliably (anti-pattern: shipping reputation-weighting with cold-start data = systematically biased against new sources). **Counter-argument:** "Z-score with 3σ threshold on 7-day baseline is over-engineered for v1 — just rate-limit and move on." Rebuttal: rate-limiting catches the simplest attack (single-source flood) but misses the realistic attack (coordinated low-volume burst from N suspicious sources). Z-score catches both by detecting unusual patterns relative to history rather than fixed thresholds. Implementation cost is low (~50 lines for detector); operational benefit is real; per-org configurability handles edge cases. **Selected over v0.2 (unspecified algorithm/window/recovery)** because v0.2 guarantees inconsistency across deployments + likely DoS when first false-positive hits. **Selected over static thresholds** because they require operator tuning per source AND don't adapt to baseline changes. **Selected over ML-based v1** because cold-start (no historical signals to train on for v1 launch) is fatal; z-score is statistically principled starting from day-7.

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
