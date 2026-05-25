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

Three reference adapters ship with the orchestrator:

| Adapter name | Source | Default tier | Notes |
|---|---|---|---|
| `signal-source-support-ticket` | Customer support tickets (Zendesk, Intercom, Help Scout) | 1 | Adopters supply the API integration in their fork; the shipped adapter is a reference shape |
| `signal-source-community-thread` | Community discussions (Discord, Slack community, Discourse) | 2 | Subject to the Tier 2 significance threshold (§3) |
| `signal-source-manual` | Operator-entered signals (e.g., from a phone call) | 1 | Requires `attestedBy` (operator); `attestedAt` auto-filled from git committer per the RFC-0022 OQ-2 audit-trail pattern |

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

Adapter credential management (OAuth tokens, API keys) is deferred to a
future RFC per RFC-0030 OQ-13.1 resolution. v1 adapters self-validate via
`isAvailable()` only; credential failures emit a `Decision:
adapter-credential-invalid` rather than halting the pipeline. The
remaining valid adapters continue to fetch.

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

## 5. Flooding-detection sensitivity

Flooding detection (RFC-0030 OQ-13.5 / Phase 4) protects against
adversarial signal injection — a bad actor flooding the community channel
with fabricated signals.

The Tier 2 significance threshold provides the **structural defense**:
clusters need ≥1 Tier 1 signal AND ≥3 unique sources AND ≥7 days age AND
≥5 signals to feed D1. Community buzz without direct customer signal
stays in the monitor-only zone:

```yaml
spec:
  tier2SignificanceThreshold:
    minSignalCount: 5
    minUniqueSources: 3
    minTier1SignalCount: 1     # the load-bearing defense
    minClusterAgeDays: 7
```

The runtime flooding detector (`detectFlooding()` in
`orchestrator/src/signal-ingestion/significance.ts`) emits
`Decision: signal-flooding-detected` when:

- Volume spike from a single source (e.g. >5x baseline in a 24h window)
- Source-diversity drop (single source dominates the cluster's signal
  count)
- Per-source baseline drift (a source previously contributing 5/day
  suddenly contributing 50/day)

Auto-action: low-confidence sources are throttled at the per-org
configurable threshold. High-severity cases (multi-source coordinated
spike, structural drift) surface to operator batch review via the
Decision Catalog (RFC-0035 G0 routing).

**Tuning guidance:**

- **Open communities with high baseline noise** can raise
  `minClusterAgeDays` to 14 or `minSignalCount` to 10 to reduce
  false-positive Tier-2 admissions.
- **Closed communities with curated membership** can lower
  `minUniqueSources` to 2 or `minClusterAgeDays` to 3 — flooding is less
  of a concern, and faster Tier-2 admission lets emergent demand feed D1
  sooner.

A future RFC will add per-source reputation-weighting once corpus data
justifies the calibration. For v1, the structural defense (≥1 Tier 1
signal) is the primary line.

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

**Usage** (programmatic surface):

```ts
import { ManualSignalSourceAdapter } from '@ai-sdlc/orchestrator/signal-ingestion';

const adapter = new ManualSignalSourceAdapter({
  attestedBy: 'dominique@example.com',
  // attestedAt is auto-filled from git committer; not supplied here.
});
await adapter.recordSignal({
  sourceId: 'phone-call-2026-05-24-acme-corp',
  sourceTimestamp: new Date(),
  customerId: 'acme-corp',
  customerTier: 'enterprise',
  payload:
    'Acme is evaluating Competitor X because our search relevance dropped after the last index migration.',
});
```

A future CLI surface (`cli-signals add ...`) will provide a TTY-friendly
wrapper that prompts for `attestedBy` if absent and assembles the
RawSignal interactively. Tracked as a follow-up to AISDLC-348.

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
