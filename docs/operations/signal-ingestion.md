# Signal ingestion operator runbook (RFC-0030)

**Audience**: AI-SDLC operators configuring the RFC-0030 Signal Ingestion
Pipeline. Covers adapter configuration, tier-multiplier tuning, SA-resonance
threshold calibration, flooding-detection sensitivity, manual signal entry,
and governance-event audit.

**Status**: feature-flag gated under `AI_SDLC_SIGNAL_INGESTION` during the
RFC-0030 soak window. The flag default is OFF; the YAML config
(`.ai-sdlc/signal-ingestion.yaml`) `spec.enabled: false` is also OFF. Both
must be flipped for the pipeline to be active.

**TL;DR**: signals from configured sources (support tickets, community
threads, manual entries) are classified by tier + ICP + recency, clustered
into demand themes, filtered through SA resonance, then fed into D1 as
cluster-level demand pressure. The classifier + clusterer + significance
gate + SA filter all run deterministically; the LLM is only invoked for
free-text ICP-match disambiguation in adapters that lack structured
metadata.

---

## Background

PPA v1.1 (RFC-0008) defines D1 (Customer Signal Accumulation) as a Demand
Pressure sub-dimension scored against issues admitted to the pipeline. The
existing path translates raw customer signal into human-authored backlog
items — a lossy step that flattens source-tier characteristics, ICP
resonance, recency-of-mention, and cluster context into the issue body.

RFC-0030 ships a parallel input path. Raw signals from configured adapters
are classified deterministically, clustered into demand themes, filtered
through SA resonance per RFC-0029 Principle 4 ("The Soul Holds"), then fed
into D1 alongside backlog-item demand via a normalised composition. The
pipeline is **non-replacement** — human-authored backlog items continue to
contribute.

The full architecture is in
[`spec/rfcs/RFC-0030-signal-ingestion-pipeline.md`](../../spec/rfcs/RFC-0030-signal-ingestion-pipeline.md).
The schema is at
[`spec/schemas/signal-ingestion-config.v1.schema.json`](../../spec/schemas/signal-ingestion-config.v1.schema.json).

---

## 1. Scaffold the config

The signal-ingestion config is NOT scaffolded by default — it's an opt-in
extension to a baseline `ai-sdlc init` install.

```bash
# Fresh install: opt in at init time
ai-sdlc init --with-signal-ingestion

# Already-initialized repo: extend with the signal-ingestion stub
ai-sdlc init --add signal-ingestion
```

Either command writes `.ai-sdlc/signal-ingestion.yaml` with every block
commented-out under `spec.enabled: false`. The pipeline runtime ships
disabled until the operator flips the toggle (see §4 below).

The file is idempotent: re-running `--add signal-ingestion` against a repo
that already has the config produces "skip .ai-sdlc/signal-ingestion.yaml
(already exists)" with no overwrite.

---

## 2. Adapter configuration

Four reference adapters ship with the orchestrator (RFC-0030 OQ-13.1 v0.3 re-walkthrough — env-var-based authentication only):

| Adapter name | Source | Default tier | Credential env var | Notes |
|---|---|---|---|---|
| `signal-source-support-ticket` | Customer support tickets (Zendesk PAT subset) | 1 | `SIGNAL_ZENDESK_PAT` | Adopters supply the API integration in their fork; the shipped adapter is a reference shape |
| `signal-source-community-thread` | Community discussions (Discord, Slack community) | 2 | `SIGNAL_COMMUNITY_BOT_TOKEN` | Subject to the Tier 2 significance threshold (§3) |
| `signal-source-in-app-feedback` | Productboard / Pendo / in-house widgets | 1 | `SIGNAL_IN_APP_FEEDBACK_API_KEY` | API-key based; OAuth integrations defer to credential-mgmt RFC |
| `signal-source-manual` | Operator-entered signals (e.g., from a phone call) | 1 | none | Requires `attestedBy`; `attestedAt` auto-filled from committer; per-operator rate limit + optional `evidenceUrl`; see §6 |

**OAuth-required adapters are NOT supported in v1.** Adapters declaring `requiresOAuth: true` are REFUSED at registration; the registry returns a `Decision: adapter-requires-credential-mgmt-rfc` pointing to the future credential-management RFC. Full Salesforce / HubSpot integrations + Zendesk-with-OAuth-scopes fall in this category.

To register a custom adapter, extend the default registry in your
orchestrator wiring:

```ts
import {
  createDefaultSignalSourceRegistry,
  type SignalSourceAdapter,
} from '@ai-sdlc/orchestrator/signal-ingestion';

class CrmNoteAdapter implements SignalSourceAdapter {
  readonly name = 'signal-source-crm-note';
  readonly defaultTier = 1 as const;
  async fetchSignals(since: Date): Promise<RawSignal[]> {
    /* ... */
  }
  async isAvailable(): Promise<boolean> {
    /* ... */
  }
}

const registry = createDefaultSignalSourceRegistry();
registry.register(new CrmNoteAdapter());
```

Then enable it in the YAML:

```yaml
spec:
  adapters:
    - signal-source-support-ticket
    - signal-source-community-thread
    - signal-source-crm-note
```

Adapter credential lifecycle (OAuth refresh tokens, scope management) is
deferred to a future credential-management RFC per RFC-0030 OQ-13.1 v0.3
resolution. v1 adapters self-validate via env-var probing (`isAvailable()`
returns true when the configured env var is non-empty). Credential
failures emit one of two distinct Decisions so the operator gets the
right downstream task:

| Decision | Trigger | Operator action |
|---|---|---|
| `adapter-credential-not-configured` | Env var missing or empty | Set the env var to enable this adapter |
| `adapter-credential-rejected` | Env var present but upstream auth call failed (401/403) | Rotate / re-generate the credential |
| `adapter-credential-invalid` (legacy) | Adapter has not migrated to env-var probing | Treat as either of the above — preserved for backward-compat |
| `adapter-requires-credential-mgmt-rfc` | Adapter declares `requiresOAuth: true` | Wait for the credential-management RFC, or remove the adapter from `adapters:` |

In all cases the pipeline continues with the remaining valid adapters — credential failure is non-blocking per the G0 contract.

> **RFC-0030 §13.1 cross-link:** The v1 env-var-only adapter scope + dual Decision routing are OQ-13.1 v0.3 refinements (AISDLC-430). The v0.2 resolution delegated credential management without specifying which adapters ship in v1 and collapsed both failure states into one `adapter-credential-invalid` Decision. The re-walkthrough surfaced both gaps and resolved them.

---

## 2.5. Multi-language signals: when to opt in

**RFC-0030 §13.2 cross-link:** Per-org `acceptedLanguages` config + `franc` language detection are OQ-13.2 v0.3 refinements (AISDLC-431). The v0.2 resolution deferred multi-language entirely without specifying the detection mechanism or documenting the actual quality impact on each pipeline stage.

The pipeline detects signal language via the `franc` library (deterministic,
<10ms per signal, JS-native, MIT-licensed, 95%+ accuracy on text >50 chars)
at the classifier stage, before clustering. Signals in unsupported languages
are dropped and logged as `Decision: signal-language-unsupported` — they do
NOT halt the pipeline (G0 routing).

**Default:** English-only (`acceptedLanguages: [en]`).

**When to opt in to multi-language:**

| Scenario | Recommendation |
|---|---|
| Your customer base is English-dominant | Keep the default `[en]` — no precision trade-off. |
| You have significant non-English customer segments (e.g. French-Canadian B2B, Spanish-speaking SMBs) | Add languages: `[en, fr, es]`. Accept the documented BM25 precision degradation. |
| You use embedding-based clustering (RFC-0019) | Multi-language has minimal impact — embeddings are natively multi-language. BM25 degradation only. |
| You're testing pipeline coverage for a new market | Temporarily add the language to measure signal volume from that segment before making it permanent. |

**Documented BM25 quality trade-off (OQ-13.2 v0.3 counter-argument surfaced by re-walkthrough):**

BM25 clustering degrades approximately 15–30% precision without per-language
stopwords and stemming (Robertson & Zaragoza §3.5). This is degraded-but-
functional — not broken. The relevant question is whether the signal loss from
dropping non-English signals (default `onUnsupported: drop-and-log`) outweighs
the clustering-precision cost of including them.

| Pipeline stage | Multi-language impact |
|---|---|
| Classification (tier, ICP, recency) | None — operates on structured metadata |
| Language detection (`franc`) | Deterministic; same speed for any language |
| BM25 clustering | ~15–30% precision drop without per-language stopwords |
| Embedding clustering | None — multilingual embeddings (cohere, openai, e5) are native |
| LLM ICP-resonance disambiguation | None — LLMs handle 50+ languages natively |
| SA resonance filter | None — operates on cluster-level metadata |

**Configuration:**

```yaml
spec:
  acceptedLanguages:
    - en
    - fr
    - es
    - de
```

Non-accepted signals emit `Decision: signal-language-unsupported` to the RFC-0035
catalog, accumulating a visible-gap metric the operator can inspect to see which
languages are generating dropped signal volume and whether it warrants expanding
`acceptedLanguages`.

---

## 3. Tier-multiplier tuning

The default tier multipliers (RFC-0030 §6.1) calibrate for a typical
mixed-customer SaaS product:

```yaml
spec:
  tierMultipliers:
    enterprise: 3.0
    mid: 1.5
    smb: 1.0
    free: 0.5
    churned: 2.0
```

The **Churned multiplier is the highest** (default 2.0). Most systems
ignore churned customers; this pipeline amplifies them because
demand-validated-by-willingness-to-pay-and-found-wanting is the
strongest signal of product-market gap.

**Tuning guidance:**

- **B2B enterprise platforms** typically raise `enterprise` to 5.0+ and
  flatten `smb` / `free` to ~0.25. Enterprise signal-to-noise is high;
  free-tier signal is mostly support volume not strategic demand.
- **Consumer products** typically flatten all tiers toward ~1.0 since the
  tier distinction is less informative — most signal arrives from
  Free/SMB and the tier multiplier matters less.
- **Multi-product portfolios** should consider per-soul config (RFC-0009)
  if soul-level tiers differ; the v1 config is one set of multipliers
  per org.

Every multiplier edit emits a `SignalIngestionConfigChanged` governance
event (see §7 below). Tier multipliers are governance-relevant: they
change which customers the framework treats as load-bearing demand.

---

## 4. SA-resonance threshold calibration

Per RFC-0029 Principle 4, SA resonance is computed against the current
Soul DID. The thresholds map cluster SA resonance to D1 weight bands:

```yaml
spec:
  saResonanceThresholds:
    fullWeight: 0.7    # ≥ this → full weight
    discounted: 0.4    # ≥ this and < fullWeight → weight × 0.7
    excluded: 0.0      # ≥ this and < discounted → weight × 0.3 (flagged for review)
                       # < this → excluded from D1 (logged as out-of-scope demand)
```

**Drift signal:** when aggregate cluster SA resonance across the demand
pipeline drops below 0.4 sustained for 3 sprints, a `SoulDriftDetected`
event fires with `driftSource: 'demandMisalignment'`. This is the canary
for incoming demand diverging from product identity — the operator's
trigger to review whether the Soul DID needs revision (RFC-0031) or the
incoming demand needs more aggressive low-SA filtering.

**Tuning guidance:**

- **Conservative (default 0.7/0.4):** appropriate when the Soul DID is
  stable and recently calibrated. Most clusters that pass cleanly are
  full-weight; mid-resonance gets discounted but contributes.
- **Loose (e.g. 0.5/0.2):** during early-product / pre-PMF when the Soul
  DID is intentionally exploratory. Lets adjacent demand contribute
  rather than being silently down-weighted.
- **Strict (e.g. 0.85/0.6):** post-PMF when the soul is well-known and
  the framework should be aggressive about excluding off-soul demand.

SA threshold edits are governance-relevant and emit
`SignalIngestionConfigChanged` events.

---

## 5. Flooding-detection sensitivity — z-score detector (AISDLC-433)

Flooding detection (RFC-0030 OQ-13.5 v0.3 / AISDLC-433) protects against
adversarial signal injection — a bad actor flooding the community
channel with fabricated signals.

**Two layers of defense:**

1. **Tier 2 significance threshold** — structural floor. Clusters need
   ≥1 Tier 1 signal AND ≥3 unique sources AND ≥7 days age AND ≥5
   signals to feed D1. Community buzz without direct customer signal
   stays in the monitor-only zone:

   ```yaml
   spec:
     tier2SignificanceThreshold:
       minSignalCount: 5
       minUniqueSources: 3
       minTier1SignalCount: 1     # the load-bearing structural defense
       minClusterAgeDays: 7
   ```

2. **Z-score flooding detector + quarantine** — runtime anomaly layer.
   The detector (`detectFlooding()` in
   `orchestrator/src/signal-ingestion/significance.ts`) computes a
   z-score for each in-window source against its rolling 7-day baseline
   and emits `Decision: signal-flooding-detected` + quarantines the
   source's signals when:

   ```
   windowCount > (baselineMean + zScoreThreshold × baselineStddev)
     AND uniqueSources_in_window < minUniqueSourcesForSuspicion
   ```

### Algorithm

For every distinct source observed in the detection window
(`[asOf - windowMinutes, asOf]`, default 60 minutes):

- Compute the per-source `{mean, stddev}` from the per-day signal-count
  samples over the rolling `baselineDays`-day baseline (default 7).
- Compute the source's `windowCount` (signals in the detection window).
- Compute `zScore = (windowCount - mean) / stddev` (z-score returns
  `+Infinity` when `stddev = 0` and `windowCount > mean`).
- Flag the source when `zScore > zScoreThreshold` (default 3.0σ).
- Trigger condition adds a healthy-traffic guard:
  `uniqueSources_in_window < minUniqueSourcesForSuspicion` (default 3).
  When ≥3 distinct sources contribute to the window, it's organic
  traffic — z-score alone doesn't fire.

### Cold-start handling

When the rolling baseline has fewer than `baselineDays` samples (typical
on first deployment / new adapter), the detector returns the
`calibrating` status and emits **no Decisions**. The Tier 2 significance
threshold is the sole defense during the calibration window. After 7
days of corpus accumulation the detector goes live.

### Quarantine state

When the trigger fires:

- Every in-window signal from a flagged source is recorded in the
  `QuarantineStore` with `expiresAt = asOf + quarantineDurationHours`
  (default 24h, per-org configurable).
- The D1 path (`computeClusterD1()`) consults the store via
  `isSignalQuarantined()` and **excludes quarantined signals from
  cluster scoring** — a mixed cluster contributes the clean members'
  weight only.
- Auto-expiry releases the quarantine lazily on read: signals from a
  source whose `expiresAt` has passed are no longer treated as
  quarantined.

### Operator one-click unquarantine

The TUI Blockers pane (RFC-0023) surfaces every active
`signal-flooding-detected` Decision and offers a one-click
**Unquarantine** action. Programmatically:

```ts
import { unquarantineFlooded } from '@ai-sdlc/orchestrator/signal-ingestion';

const falsePositive = unquarantineFlooded({
  store,                              // the runtime QuarantineStore
  originalDecisionId: 'flooding-2026-05-26T1200Z',
  operatorNote: 'Bug bash drove genuine demand spike — false positive.',
});
// falsePositive: SignalFloodingFalsePositiveDecision (or null if idempotent no-op)
```

The `signal-flooding-false-positive` Decision is the **feedback signal**
the v2 reputation-weighting layer will use to calibrate per-source
trust.

### Per-org config

```yaml
spec:
  flooding:
    detection:
      algorithm: z-score              # only z-score is supported (AISDLC-433)
      zScoreThreshold: 3.0
      windowMinutes: 60
      minUniqueSourcesForSuspicion: 3
      baselineDays: 7
    quarantine:
      enabled: true
      durationHours: 24
```

**Tuning guidance:**

- **Sensitive deployments** (small community, fast-moving demand) can
  lower `zScoreThreshold` to 2.5 — catches subtler spikes at the cost
  of more false-positives the operator unquarantines.
- **Noisy baselines** (large community with bursty traffic) can raise
  `zScoreThreshold` to 4.0 to reduce false-positives.
- **Closed communities with curated membership** can disable quarantine
  (`flooding.quarantine.enabled: false`) — Decisions still emit but
  signals stay live in D1; operator reviews after-the-fact.

### Migration from the legacy multiplier-based detector

Pre-AISDLC-433 deployments used `flooding.detection.sourceBaselineDriftMultiplier`
(default 5.0×) on a per-source rolling baseline. AISDLC-433 **replaces**
that detector with the z-score algorithm; the multiplier path is
**deleted** from the codebase.

**Migration recipe:**

1. Open `.ai-sdlc/signal-ingestion.yaml`.
2. Find the `flooding.detection.sourceBaselineDriftMultiplier` line.
3. Replace it with `zScoreThreshold:` set to `multiplier × 0.6`
   (empirical mapping — a 5× multiplier corresponds approximately to a
   3σ spike on most production datasets).
4. Add the other v0.3 keys to the same block:
   `windowMinutes`, `minUniqueSourcesForSuspicion`, `baselineDays`.

**Soak behavior (one release window):** when the legacy key is still
present in the YAML, the loader (`loadSignalIngestionConfigWithDeprecations()`)
emits a `signal-ingestion-config-deprecated-field` Decision **and**
auto-translates the value to the closest z-score equivalent. Operators
get a visible Decision in the catalog while the auto-translation
preserves runtime behavior — no surprise breakage during migration.

**Post-soak hard-error:** when `AI_SDLC_SIGNAL_INGESTION_LEGACY_HARD_ERROR=1`
is set in the operator's environment (the post-soak default that ships
in the next release window), the loader throws on the legacy field
instead of translating. Adopters who haven't migrated fail loudly with
a migration-instruction error.

### Reputation-weighting deferred to v2

Per-source reputation-weighting (analogous to HackerOne / Bugcrowd
researcher reputation, Wikipedia editor reputation) **requires 7+
corpus windows of baseline data to calibrate reliably**. Shipping it
with cold-start data systematically biases against new sources. v2
ships once the corpus accumulates; the `signal-flooding-false-positive`
Decisions accumulating in the catalog during v1 are the feedback
substrate v2 calibrates against.

---

## 6. Manual signal entry workflow

Operators can enter signals manually via the `signal-source-manual`
adapter. Manual entries default to Tier 1 (operator-attested) and require
two audit-trail fields:

- `attestedBy` — operator identity (free-form string; typically the
  operator's email or a stable handle). The adapter REFUSES the entry if
  this field is missing.
- `attestedAt` — auto-filled from the git committer timestamp at the
  point of entry. The adapter does not accept a caller-supplied value
  here; the framework controls it to prevent backdated attestation.

**Why the audit trail is forced:** operator-attested signals are higher-
stakes than automated ones (they bypass the source-system audit + flow
straight into D1). The forced rationale + auto-filled timestamp +
auto-filled committer prevents the manual-entry path from becoming a
quality-substrate bypass. The pattern is borrowed verbatim from the
RFC-0022 OQ-2 audit-trail mechanism for compliance overrides.

Manual entries missing required fields trigger a `Decision:
manual-signal-incomplete` and the entry is refused. The operator gets a
clarification task; the pipeline continues on automated sources without
halting (G0 routing).

**RFC-0030 OQ-13.4 v0.3 re-walkthrough — anti-gaming layers**

Layered on top of the forced audit trail:

1. **Per-operator daily rate limit** (default 10 manual signals per operator per UTC day). Above the cap → `Decision: manual-signal-rate-limit-exceeded`; operator can escalate via batch review.
2. **Optional `evidenceUrl` field** (call recording URL, ticket URL, transcript link). When present, the audit trail is materially stronger; when absent the attested observation stands but is flagged in the share metric.
3. **Manual-share quality metric** (rolling 7-day `manualSignals / totalSignals`). Above 30% sustained → `Decision: manual-signal-share-elevated` (warning, not block — surfaces architectural anti-pattern that pipeline is acting as a data-entry tool rather than automated demand-detection).

Configure all three under `spec.manualEntry` in the YAML:

```yaml
spec:
  manualEntry:
    dailyCapPerOperator: 10          # default; set to 0 to disable
    evidenceUrlOptional: true        # the framework treats evidenceUrl as optional
    qualityMetric:
      enabled: true
      windowDays: 7
      shareWarningThreshold: 0.3     # 30% — emit Decision above this
```

**Usage** (programmatic surface):

```ts
import { ManualSignalSourceAdapter } from '@ai-sdlc/orchestrator/signal-ingestion';

const adapter = new ManualSignalSourceAdapter({
  dailyCapPerOperator: 10, // default 10/day per operator
});

adapter.addSignal({
  sourceId: 'phone-call-2026-05-24-acme-corp',
  sourceTimestamp: new Date(),
  customerId: 'acme-corp',
  customerTier: 'enterprise',
  payload:
    'Acme is evaluating Competitor X because our search relevance dropped after the last index migration.',
  attestedBy: 'dominique@example.com',
  evidenceUrl: 'https://example.com/call-recording/abc123', // OQ-13.4 optional
});
```

When the operator hits the daily cap, `addSignal()` throws `ManualSignalRateLimitExceeded`; the registry converts it into `Decision: manual-signal-rate-limit-exceeded` and the pipeline continues fetching from other adapters. The escalation path is operator-driven batch review (not yet wired to a CLI; tracked as a follow-up).

The manual-share quality metric runs out-of-band. Wire it into your orchestrator tick to surface the warning Decision:

```ts
import { computeManualShareMetric } from '@ai-sdlc/orchestrator/signal-ingestion';

const fetched = await fetchSignalsFromAvailableAdapters(adapters, since);
const metric = computeManualShareMetric(fetched.signals, {
  windowDays: config.manualEntry.qualityMetric.windowDays,
  shareWarningThreshold: config.manualEntry.qualityMetric.shareWarningThreshold,
});
if (metric.elevated && metric.decision) {
  // Forward metric.decision to the RFC-0035 catalog as a warning event
}
```

A future CLI surface (`cli-signals add ...`) will provide a TTY-friendly wrapper that prompts for `attestedBy` + `evidenceUrl` if absent and assembles the RawSignal interactively. Tracked as a follow-up to AISDLC-348.

---

## 6.5. Residency enforcement points in the signal pipeline

Compliance regimes (GDPR / HIPAA / PIPEDA) require enforcement at the
data-handling layer, not just policy declaration. RFC-0022 (Compliance
Posture + Audit Surface) owns regime DECLARATION (`compliance.yaml` +
`derivedGates`); RFC-0030 §13.3 v0.3 specifies the per-stage enforcement
points THIS pipeline applies. AISDLC-432 ships the post-Phase-4
substrate.

The four enforcement points correspond to four pipeline stages, each
gated by a flag in `spec.residencyEnforcement.enforcementPoints` (default
ON for all four when at least one regime is declared):

### a. `fetchSignals` — adapter-level signal tag check

Each adapter tags fetched signals with a `region` derived from upstream
metadata (Zendesk org region, Salesforce sandbox region, Slack workspace
region). The Phase-4 `checkSignalResidency` gate consults the active
regime's `allowedRegions`; out-of-policy signals are refused and emit
`Decision: signal-residency-violation` to the catalog. The pipeline
continues on the remaining signals (G0 non-blocking — RFC-0035). When a
signal has no `region` metadata, the gate skips it (visible-gap surface,
not failure — adapters that don't yet plumb region metadata are flagged
in the population-level region breakdown but not refused).

### b. `clustering` — cross-region merge prevention

`clusterSignalsWithResidency()` partitions signals by
`residencyRegion` BEFORE similarity computation, so cross-region cluster
merge is structurally impossible. The wrapper falls through to
`clusterSignals()` (no partitioning) when `partitionByRegion: false` —
no overhead for adopters with no residency regime declared. Use
`clusterRequiresSegregation()` against the active regime declaration to
decide:

```ts
import {
  clusterRequiresSegregation,
  clusterSignalsWithResidency,
  composePostures,
} from '@ai-sdlc/orchestrator/signal-ingestion';

const declaration = composePostures([
  { regime: 'gdpr', allowedRegions: ['eu', 'gb'] },
  { regime: 'hipaa', allowedRegions: ['us'] },
]);
const partitionByRegion = clusterRequiresSegregation(declaration);
const result = await clusterSignalsWithResidency(signals, {
  partitionByRegion,
});
// result.regionPartitions = { eu: 3, us: 1, ... } when partitioning ran.
```

### c. `storage` — `residencyRegion` field + elevated cross-region read audit

Every stored signal record carries a mandatory `residencyRegion` field
derived from the signal's `region` tag (lower-cased; `'unknown'` when
absent). Use `makeStoredSignalRecord()` at persistence time and
`readSignalRecordWithAudit()` at read time:

```ts
import {
  makeStoredSignalRecord,
  readSignalRecordWithAudit,
} from '@ai-sdlc/orchestrator/signal-ingestion';

const record = makeStoredSignalRecord(rawSignal);
// On read, by an agent / surface in a different region:
const { auditEntry } = readSignalRecordWithAudit(record, {
  callerRegion: 'us',
  reader: 'ppa-d1-aggregator',
});
if (auditEntry !== null) {
  // Persist the elevated audit entry to your audit log
  // (SOC2 CC7.2 / HIPAA accountability mandate).
}
```

Cross-region reads are **logged, not blocked** — the audit obligation is
on read (matching AWS S3 cross-region replication audit semantics). When
either side is `'unknown'`, no audit fires (visible-gap state surfaced
via the population-level region breakdown).

### d. `unifiedCostReport` — per-region cost attribution

Cost-attribution rows from the embedding adapter (RFC-0019 OQ-7), the
LLM classifier, and external-API consumers are tagged with
`residencyRegion` and grouped via `groupCostByRegion()`:

```ts
import {
  groupCostByRegion,
  type CostAttributionRow,
} from '@ai-sdlc/orchestrator/signal-ingestion';

const rows: CostAttributionRow[] = [
  { consumerLabel: 'rfc-0030-clustering', costUsd: 0.05, residencyRegion: 'eu' },
  { consumerLabel: 'rfc-0030-clustering', costUsd: 0.03, residencyRegion: 'us' },
];
const breakdown = groupCostByRegion(rows);
// breakdown = { totalUsd: 0.08, perRegion: { eu: 0.05, us: 0.03 } }
```

The breakdown lets operators audit cross-region cost mingling at a
glance — anomalous concentration of cost in one region against the
declared customer base is a signal worth investigating.

### Multi-posture composition (UNION-of-constraints)

When an adopter declares both HIPAA AND GDPR (or any combination of
regimes), `composePostures()` produces a single
`ResidencyRegimeDeclaration` consumable by every enforcement point. The
composition is **UNION of constraints** — every active regime's
allowed-regions constraint must be satisfied. A signal in `'eu'`
satisfies GDPR but NOT HIPAA-only adopters, so multi-posture deployments
should scope adapter inputs to a single regime per source.

```ts
const declaration = composePostures([
  { regime: 'gdpr', allowedRegions: ['eu', 'gb'] },
  { regime: 'hipaa', allowedRegions: ['us'] },
]);
// declaration.regimes = ['gdpr', 'hipaa']
// declaration.allowedRegionsByRegime = { gdpr: ['eu','gb'], hipaa: ['us'] }
// → an 'eu' signal is refused (violates HIPAA),
//   a 'us' signal is refused (violates GDPR),
//   only signals whose region is in BOTH lists pass (empty set here).
```

The composer is forward-compatible with RFC-0022 OQ-7 multi-posture
declaration; until OQ-7 ships, adopters compose manually via
`composePostures()`.

### Audit export

Every per-stage enforcement point emits either a Decision (adapter
violations), an AuditEvent (cross-region reads), or a structured
breakdown (cost report). The operator's audit export consumer (RFC-0022
audit surface) reads these from `events.jsonl` + per-record audit logs;
filter on `severity: 'elevated'` to surface the audit-worthy entries
that demand SOC2 / HIPAA review attention.

### Disabling enforcement (rare)

Adopters whose regime doesn't require a given enforcement point can
disable it via the per-point flags:

```yaml
spec:
  residencyEnforcement:
    enforcementPoints:
      clustering: false  # adopter accepts cross-region cluster mingling
```

This is rare — the default-ON behaviour matches the conservative
intent of compliance regimes. Every override is governance-relevant +
emits a `SignalIngestionConfigChanged` event.

---

## 7. Governance event audit trail

Configuration changes are governance-relevant per RFC-0030 §11 closing
note. Every load of the config compares the resolved values against
either the framework defaults or a previous snapshot; when there's a
non-empty diff, the orchestrator emits a `SignalIngestionConfigChanged`
event to the date-rotated events file:

```
<ARTIFACTS_DIR>/_orchestrator/events-YYYY-MM-DD.jsonl
```

Example event line:

```json
{
  "ts": "2026-05-24T12:00:00.000Z",
  "type": "SignalIngestionConfigChanged",
  "configPath": "/repo/.ai-sdlc/signal-ingestion.yaml",
  "comparedAgainst": "defaults",
  "changes": [
    { "path": "enabled", "previous": false, "current": true },
    { "path": "tierMultipliers.enterprise", "previous": 3.0, "current": 5.0 }
  ]
}
```

**Reading the event stream:**

```bash
# Today's events
cat artifacts/_orchestrator/events-$(date -u +%Y-%m-%d).jsonl \
  | jq -c 'select(.type == "SignalIngestionConfigChanged")'

# All recent config changes
cat artifacts/_orchestrator/events-*.jsonl \
  | jq -c 'select(.type == "SignalIngestionConfigChanged") | {ts, comparedAgainst, changes}'
```

The events file is the same date-rotated file that
`pipeline-cli/src/orchestrator/events.ts#writeEvent()` writes to, so the
TUI events pane + `cli-status --orchestrator` surface signal-ingestion
governance events alongside dispatch / completion events. No separate
observability silo.

**`comparedAgainst` discriminator:**

- `"defaults"` — the loaded config differs from
  `DEFAULT_SIGNAL_INGESTION_CONFIG`. Fires on the first load of a
  non-default config (operator opted in for the first time, or the
  loader sees an existing customised file).
- `"previous-load"` — the caller supplied a `previousConfigSnapshot` and
  the loaded config differs from it. Fires on subsequent reloads (long-
  running orchestrator detecting an in-flight edit).

**What triggers an event:**

- Setting `enabled: true` (the first opt-in)
- Adjusting any tier multiplier or ICP weight
- Adjusting the recency half-life
- Editing any Tier-2 significance threshold
- Editing any SA resonance threshold
- Switching clustering algorithm (`bm25` ↔ `embedding`)
- Adjusting the similarity threshold
- Adding/removing adapters
- Adjusting D1 composition weights
- Adjusting the accepted-languages list
- Editing any `manualEntry` field (`dailyCapPerOperator`, `evidenceUrlOptional`, `qualityMetric.*`)

**What does NOT trigger an event:**

- Loading the config when the file is absent (loader returns defaults
  silently)
- Loading a config that matches the defaults verbatim
- Calling `loadSignalIngestionConfig()` directly (the no-governance
  variant); only `loadSignalIngestionConfigWithGovernance()` emits

**Product-lead review cadence:** configuration changes are governance-
relevant but NOT DID-level decisions per RFC-0030 §11. The recommended
cadence is weekly review of the event stream during the soak window
(operators verify all changes are intentional + understand the D1 impact)
and monthly during steady-state. The Decision Catalog (RFC-0035) is the
recommended routing surface for the review notes.

---

## 8. Composition with DoR (RFC-0011)

Cluster-derived issues that flow from signal ingestion into the backlog
inherit a partial auto-pass on DoR Gates 1, 4, 5, 6 (testable AC, bounded
scope, named surface, describable done-state) — these are satisfied by
construction since the pipeline structures its output.

Gates 2, 3, 7 (markers, references, dependencies) still run as
structural checks regardless of source. See the
[DoR Promotion runbook](dor-promotion.md) for how this composes with the
broader DoR rubric.

---

## 9. Composition with PPA D1 (RFC-0008)

The reformulated D1 formula (RFC-0030 §10) consumes cluster-level demand:

```
D1(cluster) = Σ over signals in cluster:
    signal.baseWeight              # 1.0 Tier 1; 0.3 Tier 2 above threshold; 0 below
    × signal.tierMultiplier        # configurable per deployment; §3
    × signal.icpResonance          # configurable per deployment; default §6.2
    × signal.recencyDecay          # exp(-age_days × ln(2) / half_life_days)
    × cluster.saResonance          # filter per §4
```

D1 is normalised across all active clusters to `[0, 1]`, then fed into
the existing PPA D formula via `composeD1Inputs()` (RFC-0030 §10 / Phase 5
non-replacement composition). The signal-pipeline D1 input and the
human-authored backlog-item D1 input are blended per `d1Composition`
weights (default 50/50).

When `enabled: false`, only the backlog-item stream contributes — the
existing pre-RFC-0030 behaviour. This is what makes the rollout safe:
adopters who haven't opted in see zero behaviour change.

---

## 9b. Multi-language signals: when to opt in

**RFC-0030 OQ-13.2 v0.3 resolution (2026-05-26).** The pipeline ships
English-only by default but supports per-org multi-language opt-in via the
`spec.acceptedLanguages` list. Language detection is performed by the
[`franc`](https://github.com/wooorm/franc) library — deterministic, MIT-licensed,
JS-native, runs in <10ms per signal, 95%+ accurate on text >50 characters,
returns ISO 639-3 codes.

### Default behaviour (English-only)

```yaml
spec:
  # Default — no need to declare; this is the built-in default
  acceptedLanguages: [en]
  languageDetection:
    library: franc
    minDetectionLength: 50   # franc returns 'und' below this; gate accepts
    onUndetermined: accept   # short payloads pass through (legitimate bug reports)
```

Non-English signals are dropped with `Decision:
signal-language-unsupported` and logged to the catalog as a visible-gap
metric. The decision payload includes the detected ISO 639-3 code (e.g.
`'cmn'`, `'fra'`, `'spa'`) so operators can see what's being filtered.

### Opting in to multi-language

To accept additional languages, add their tags to `acceptedLanguages`. The
matcher accepts BCP-47, ISO 639-1, and ISO 639-3 forms — all equivalent
for the common-language set:

```yaml
spec:
  # Multi-language opt-in — pick what your customer base actually speaks
  acceptedLanguages: [en, fr, es, de]   # ISO 639-1 (most common)
  # acceptedLanguages: [eng, fra, spa, deu]  # ISO 639-3 (equivalent)
  # acceptedLanguages: [en-US, fr-CA, es-MX, de-DE]  # BCP-47 (equivalent)
```

For uncommon languages not in the built-in ISO 639-1 → 639-3 mapping
(e.g. Tagalog `tgl`, Northern Pashto `pbu`, Norwegian Bokmål `nob`),
specify the ISO 639-3 form directly.

### The trade-off: BM25 quality degradation

Adopting multi-language is **not free**. The pipeline's clustering step
uses BM25 similarity, which is degraded-but-functional in any language
without per-language stopword + stemming calibration. Per Robertson &
Zaragoza (2009) §3.5, expect **~15-30% precision drop** on clustering
quality for non-English signals compared to English baseline.

The three pipeline stages have different multi-language costs:

| Stage | Multi-language cost | Why |
|---|---|---|
| Tier classification (RFC-0030 §6.1) | None | Metadata-driven (customerTier, customerId), language-independent |
| ICP resonance (LLM-based) | None | Modern LLMs (Claude, GPT-4) handle 50+ languages natively |
| Clustering (BM25 default) | **~15-30% precision drop** | No per-language stopwords / stemming in v1 |
| Clustering (embedding option, RFC-0019) | Minimal | Multilingual embedding models (`cohere-embed-multilingual-v3`, `openai text-embedding-3-large`, `multilingual-e5-large`) are native multi-language |

**Practical implication:** if your customer base is predominantly
non-English and clustering quality matters (long-tail demand themes that
the framework should consolidate), strongly consider configuring the
embedding-based clustering algorithm:

```yaml
spec:
  acceptedLanguages: [en, fr, es]
  clustering:
    algorithm: embedding    # multilingual-friendly
    similarityThreshold: 0.6
```

Then wire up an RFC-0019 embedding adapter that uses a multilingual model
(see `docs/operations/embedding-adapter.md` for setup).

### When to opt in (decision rubric)

| Scenario | Recommendation |
|---|---|
| English-first product, occasional non-English ticket | Stay default `[en]`. Non-English signals dropped; visible-gap metric tracks the loss. |
| Bilingual product (e.g. EN + FR Canadian, EN + ES Latin American) | Opt in to both languages. Accept ~20% BM25 precision drop, OR switch to embedding clustering. |
| Truly multilingual product (5+ languages, no dominant one) | Opt in to top-3 by signal volume. Strongly consider embedding clustering. Track manual-share quality metric (§6) — if it drifts up because clustering loses signal, that's the canary. |
| Enterprise B2B with multi-region customer base | Opt in per-region — usually one operator covers one region, so the org-wide `acceptedLanguages` covers the union. |

### Operator visibility

The dropped-language gap is observable via the events stream:

```bash
# Count of signals dropped by detected language over the last 7 days
find artifacts/_orchestrator -name 'events-*.jsonl' \
  -newer "$(date -u -v-7d +%Y-%m-%d)" \
  -exec jq -c 'select(.type == "Decision" and .decision == "signal-language-unsupported")' {} \; \
  | jq -r '.detectedLanguage' \
  | sort | uniq -c | sort -rn
```

If a non-English language consistently shows up (e.g. `fra` 50 drops/week),
that's the operator's signal to consider opt-in. Per-org configurability
is the right model for "you know your data better than the framework does."

### Tuning the language gate

Three knobs control behaviour:

```yaml
spec:
  languageDetection:
    library: franc           # or 'none' to disable the gate entirely
    minDetectionLength: 50   # raise for fewer false-detects on short text
    onUndetermined: accept   # or 'drop' for strict mode (drops short/ambiguous)
```

**`minDetectionLength`**: franc's documented accuracy threshold is 50
chars. Bumping it to 100+ trades coverage for accuracy (more signals fall
into the `und` bucket and are handled by `onUndetermined`). Lower than 50
risks misclassification of short technical English as Nordic languages
(common franc gotcha — see code comment in
`orchestrator/src/signal-ingestion/classifier.ts` `checkLanguage`).

**`onUndetermined: accept`** (default): conservative, biased toward
keeping signal. Use this unless you've measured a high false-accept rate
on actually-foreign short signals.

**`onUndetermined: drop`**: strict, biased toward filtering noise. Use
when your signal sources produce primarily long-form English (e.g.
customer-success call transcripts) and you want to flag short ambiguous
payloads for manual review.

**`library: none`**: disables the gate entirely. Use during integration
testing or when you have an upstream language filter (e.g. Zendesk's
per-language ticket views) and want zero double-filtering.

### Why franc instead of LLM-based detection

Per RFC-0030 OQ-13.2 v0.3 rubric: `franc`'s 95%+ accuracy on text >50
chars is sufficient for the routing decision; LLM-based detection is
100-500× slower (network round-trip + inference), costs money per signal
(API tokens), and is less deterministic (model updates change outputs).
franc is a 270 kB JS bundle with one tiny dependency, runs locally, and
gives the same answer for the same input forever.

---

## 10. Common operations

### Verify the loader sees your edits

```bash
# Round-trip the config through the loader + print the resolved values
node -e "
  import('./orchestrator/dist/signal-ingestion/index.js').then(({loadSignalIngestionConfig}) => {
    console.log(JSON.stringify(loadSignalIngestionConfig({projectRoot: process.cwd()}), null, 2));
  });
"
```

### Inspect the governance event stream

```bash
# Today's signal-ingestion events
jq -c 'select(.type == "SignalIngestionConfigChanged")' \
  artifacts/_orchestrator/events-$(date -u +%Y-%m-%d).jsonl

# All time
find artifacts/_orchestrator -name 'events-*.jsonl' \
  -exec jq -c 'select(.type == "SignalIngestionConfigChanged")' {} \;
```

### Validate the YAML against the JSON Schema

```bash
# Editor integration: point your YAML language server at the schema
# .vscode/settings.json:
#   "yaml.schemas": {
#     "spec/schemas/signal-ingestion-config.v1.schema.json": [
#       ".ai-sdlc/signal-ingestion.yaml"
#     ]
#   }

# Or validate manually:
npx ajv validate \
  --spec=draft2020 \
  -s spec/schemas/signal-ingestion-config.v1.schema.json \
  -r spec/schemas/common.schema.json \
  -d .ai-sdlc/signal-ingestion.yaml
```

### Disable the pipeline mid-soak

If the pipeline misbehaves, you have two opt-outs that compose:

```bash
# 1. Unset the env flag (fastest, no commit needed)
unset AI_SDLC_SIGNAL_INGESTION

# 2. Set spec.enabled: false in .ai-sdlc/signal-ingestion.yaml + commit
#    (persistent across operators)
```

Both options are degrade-open: the orchestrator falls back to the
pre-RFC-0030 backlog-only D1 path; no dispatcher work is rejected.

---

## 11. Promotion

See the [Signal-ingestion promotion runbook](signal-ingestion-promotion.md)
for the procedure to flip `AI_SDLC_SIGNAL_INGESTION` from default-OFF to
default-ON.

---

## 12. Re-walkthrough provenance (v0.3 refinements, 2026-05-26)

This section documents what changed between the v0.2 operator walkthrough
(2026-05-16) and the v0.3 re-walkthrough (2026-05-26) that produced the
AISDLC-430..434 refinement family. Cross-link to RFC-0030 §13 v0.3.

**Why a second walkthrough?**

The 2026-05-16 v0.2 walkthrough resolved all 5 §13 OQs but was
subsequently flagged as too shallow — "skims over questions and recommends
authors' recommendations" without sufficient industry research or
counter-argument. The 2026-05-26 v0.3 re-walkthrough applied the **full
rigor rubric** per OQ: problem statement → industry research → 3-4 options
with tradeoffs → recommendation + counter-argument.

**What changed at the architectural level (not just docs):**

| OQ | v0.2 resolution | v0.3 refinement | Task |
|---|---|---|---|
| **OQ-13.1** (adapter auth) | "Delegate to future RFC; adapters self-validate" | Added explicit v1 adapter scope (env-var-only); split `adapter-credential-invalid` into `adapter-credential-not-configured` vs `adapter-credential-rejected` | AISDLC-430 |
| **OQ-13.2** (multi-language) | "English-only v1; defer to v2" | Added per-org `acceptedLanguages` opt-in + specified `franc` for detection + documented BM25 quality degradation explicitly | AISDLC-431 |
| **OQ-13.3** (residency) | "Delegate to RFC-0022" | Added explicit per-stage enforcement points (fetchSignals, clustering, storage, unified-cost-report) + UNION multi-posture forward-compat | AISDLC-432 |
| **OQ-13.4** (manual entry) | "Forced attestedBy + attestedAt" | Added per-operator daily rate limit + optional `evidenceUrl` + rolling 7d manual-share quality metric | AISDLC-430 |
| **OQ-13.5** (flooding) | "Tier 2 significance threshold as partial defense; future RFC for reputation-weighting" | Specified z-score detection algorithm + quarantine state + operator one-click unquarantine + reputation-weighting explicitly deferred to v2 with cold-start rationale | AISDLC-433 |

**What did NOT change:**

The core architecture (adapters → classifier → clusterer → SA filter → D1)
is unchanged from v0.2. The non-replacement composition (signal pipeline and
human-authored backlog items both feed D1) is unchanged. The G0 non-blocking
routing contract (RFC-0035) is unchanged. The phase task breakdown
(AISDLC-343..348) shipped unmodified; the AISDLC-430..434 family lands on
top of that substrate.

**How to verify the v0.3 substrate is running:**

```bash
# Confirm the default config reflects v0.3 defaults
node -e "
  import('./orchestrator/dist/signal-ingestion/index.js').then(({DEFAULT_SIGNAL_INGESTION_CONFIG}) => {
    const c = DEFAULT_SIGNAL_INGESTION_CONFIG;
    console.log('adapters:', c.adapters);
    console.log('acceptedLanguages:', c.acceptedLanguages);
    console.log('manualEntry.dailyCapPerOperator:', c.manualEntry.dailyCapPerOperator);
    console.log('flooding.detection.algorithm:', c.flooding.detection.algorithm ?? 'z-score');
    console.log('residencyEnforcement.multiPostureBehavior:', c.residencyEnforcement.multiPostureBehavior);
  });
"
# Expected output:
# adapters: [ 'signal-source-support-ticket', 'signal-source-community-thread', 'signal-source-in-app-feedback' ]
# acceptedLanguages: [ 'en' ]
# manualEntry.dailyCapPerOperator: 10
# flooding.detection.algorithm: z-score
# residencyEnforcement.multiPostureBehavior: union
```

---

## See also

- [`spec/rfcs/RFC-0030-signal-ingestion-pipeline.md`](../../spec/rfcs/RFC-0030-signal-ingestion-pipeline.md)
  — the canonical specification
- [`spec/schemas/signal-ingestion-config.v1.schema.json`](../../spec/schemas/signal-ingestion-config.v1.schema.json)
  — config schema
- [`spec/schemas/signal-source-adapter.v1.schema.json`](../../spec/schemas/signal-source-adapter.v1.schema.json)
  — adapter schema
- [DoR promotion runbook](dor-promotion.md) — RFC-0011 flag-flip runbook
  (this pipeline's promotion runbook follows the same hybrid corpus +
  operator-override pattern)
- [Deps composition promotion runbook](deps-composition-promotion.md) —
  RFC-0014 flag-flip runbook (same hybrid model)
- [Orchestrator promotion runbook](orchestrator-promotion.md) — RFC-0015
  flag-flip runbook (same hybrid model)
