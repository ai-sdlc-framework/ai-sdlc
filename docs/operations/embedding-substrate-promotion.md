# Promoting `AI_SDLC_EMBEDDING_PROVIDER` from default-OFF to default-ON

**Audience**: AI-SDLC operators (specifically: whoever is dispatching the
final flag-flip PR for RFC-0019). This is the runbook for the final
step of RFC-0019 Phase 5 — flipping the `AI_SDLC_EMBEDDING_PROVIDER`
env-var default from `off` to `on` so the embedding provider
adapter framework becomes the standard substrate available to all
downstream consumers.

**TL;DR**: there are two paths. Both produce the same default-on
end-state. Pick based on whether the embedding-corpus signal is rich
enough for spot-check math.

| Path | When to use | Tooling | Authority |
|---|---|---|---|
| **Corpus path** | A downstream consumer has shipped + the `_embeddings/` JSONL store has accumulated entries across ≥1 full pipeline window | `jq` over `_embeddings/*.jsonl` + `cli-cost-report --unified` invoice reconciliation | Math-rigorous; recommendation drops out of the data |
| **Override path** | Corpus is sparse OR the operator has separate evidence (`cli-status --embeddings` spot-check, manual `embed()` smoke tests) the substrate isn't surprising | Eyeball recent `_embeddings/*.jsonl` writes + cost-tracker `embeddingTokens` totals | Operator judgment |

This runbook is the **sibling** of the
[`deps-composition-promotion.md`](deps-composition-promotion.md) and
[`orchestrator-promotion.md`](orchestrator-promotion.md) runbooks —
same hybrid-corpus-OR-override structure, same single-line
flag-flip mechanic, same single-line revert rollback. Read those
first if you've never run a flag flip before; the differences for
embeddings are noted inline below.

---

## Background: why two paths?

Per RFC-0019 §11 Phase 5 (and the maintainer convention established
in RFC-0014 §11 Phase 5): **calendar duration is a side-effect, not
a gate**. The promotion criteria are:

- **At least one downstream consumer has shipped** that depends on
  the framework. The first such consumer is RFC-0009 Phase 4.2 Eτ
  rule #2 (AISDLC-317 — `Eτ_tessellation_drift` via embedding
  distance). The orchestrator MUST be successfully invoking
  `adapter.embed(...)` from at least one production pipeline call
  site that exercises a non-trivial code path. A consumer that
  is wired up but never invoked does NOT count.
- **One full corpus window has run with the framework enabled**
  without operator-flagged regressions. "Corpus window" = at least
  one pipeline iteration in which every dispatched task that
  reaches the consumer surface produces at least one `embed()`
  call. In practice: a typical dogfood week with the consumer
  exercised on real backlog work.
- **Cost-tracker totals align with provider invoice** within
  tolerance. The `cli-cost-report --unified` view aggregates
  `embeddingTokens` against the OpenAI billing dashboard for the
  same period; the absolute-USD discrepancy MUST be within ±10%
  (tolerance covers OpenAI's rounding, mid-window pricing changes,
  and the difference between "tokens charged" and "tokens we
  counted at the API call site"). >10% drift indicates the
  cost-tracker is mis-instrumented and MUST block promotion until
  resolved.
- **No high-severity stale-vector or cross-provider Decisions in
  the catalog** for the soak window. Per RFC-0019 §15 OQ-2 / OQ-3
  resolutions, these route through RFC-0035 G0 as non-blocking
  pipeline contracts — they don't halt the pipeline, but a flood
  of HIGH-severity entries is signal that the adapter swap story
  (lazy-re-embed default) isn't converging. Spot-check
  `cli-decisions list --scope embedding --severity high` before
  flipping.

Whichever path satisfies the criteria first wins. Because the
embedding store is operator-local (JSONL on disk under
`$ARTIFACTS_DIR/_embeddings/`) and the consumer surface is small
in v1 (drift detection on RFC-0009 Tessellated Design Intent
revisions), the override path is the **expected default** until
multiple consumers ship in parallel — there isn't a multi-operator
embedding corpus to aggregate yet.

The two paths produce the same end-state: the
`AI_SDLC_EMBEDDING_PROVIDER` default flips from `off` to `on` in
the appropriate config file (see "The flag flip" below). The only
difference is which evidence justified the flip.

---

## Corpus path (preferred once a consumer is dogfooded for ≥1 week)

### 1. Verify the downstream consumer is genuinely exercising the substrate

The RFC-0019 framework can be wired without being USED — pipeline-load
resolves the adapter, but if no consumer ever calls `adapter.embed()`
the flip is premature. Confirm at least one call site is firing:

```bash
# Tail the cost-tracker JSONL for embedding line items in the last 7 days.
node pipeline-cli/bin/cli-cost-report.mjs \
  --line-item embeddingTokens \
  --since "$(date -v-7d +%Y-%m-%d)" \
  --format table
```

Look for:

- **Non-zero `embeddingTokens` total** — confirms at least one
  `embed()` call happened in the window.
- **`consumerLabel` populated** for ≥1 row — confirms the consumer
  is passing its label per RFC-0019 OQ-6 (e.g.
  `rfc-0009-tessellation-drift`). A flood of `unspecified` rows
  signals a call site that forgot to thread the label through;
  file follow-up before flipping (per-consumer attribution is
  load-bearing for finance reporting and CANNOT be retrofitted
  silently).
- **At least 2 distinct `(provider, modelVersion)` rows** is NOT
  required for v1 — single-provider is the expected v1 case. If
  you see 2+ providers, that's an adopter that's already running
  the override path on their own; cross-reference their config.

### 2. Reconcile cost-tracker against the provider invoice

This is the **load-bearing spot-check** of Phase 5. The cost-tracker
records `costUsd` at every `embed()` call site using the
adapter-declared `pricingModel`; the provider's invoice is the
ground truth. If they diverge by >10%, the framework is mis-counting
and a default-on flip would silently distort every consumer's
finance reporting.

```bash
# Step 1: produce the framework's view of the spend window.
node pipeline-cli/bin/cli-cost-report.mjs \
  --line-item embeddingTokens \
  --group-by provider,modelVersion \
  --since 2026-05-01 --until 2026-05-31 \
  --format json > ./embedding-spend-may.json

jq '.totals' ./embedding-spend-may.json
# Expected shape:
# {
#   "openai-text-embedding-3-small": {
#     "tokens": 4312891,
#     "costUsd": 0.0862578
#   }
# }
```

Now log into the provider dashboard (for OpenAI: <https://platform.openai.com/usage>)
and filter to the same window + the embeddings line item.

| Comparison | Action |
|---|---|
| Framework total within ±10% of provider total | Spot-check passes; record both numbers in the flag-flip PR body. |
| Framework total <90% of provider total (under-counted) | A call site is calling the provider API directly without routing through the adapter. Block promotion; trace the missing instrumentation. Common culprit: ad-hoc operator scripts that import `openai` directly. |
| Framework total >110% of provider total (over-counted) | The framework is double-counting (e.g. batch interface double-records). Block promotion until the over-counting is fixed; `pipeline-cli/src/cli/cost-report.ts` is the place to start tracing. |
| Provider dashboard shows zero embeddings spend | Either no `embed()` call actually reached the API (mock adapter / hermetic test mode) or the API key in the framework points at a different account than the dashboard you're checking. Verify `adapter.getAccountId()` matches the dashboard's API key fingerprint. |

### 3. Verify storage growth matches expectations

The JSONL backend is the v1 storage default. Confirm the on-disk
footprint is what you'd expect for the spend you observed:

```bash
# How many vectors did we write in the window?
ls -la artifacts/_embeddings/
wc -l artifacts/_embeddings/openai-text-embedding-3-small-2024-01-25.jsonl

# Rough sanity: average chars per entry × line count ≈ on-disk size.
# 1536-dim float64 JSONL entry is ~10 KB; 1000 entries ≈ 10 MB.
```

| Observation | Action |
|---|---|
| Line count consistent with `embed()` invocation count in cost-tracker | Healthy; proceed. |
| Line count significantly LESS than `embed()` count | Storage backend is silently dropping writes. Block promotion; `orchestrator/src/embedding/storage/jsonl-backend.ts` is the place to trace. |
| Line count significantly MORE than `embed()` count | The deduplication path (textHash cache lookup) is not firing — every call writes a fresh entry even for identical text. This is a perf concern, not a correctness blocker, but file follow-up. |
| Line count exceeds RFC-0019 §15 scale-escalation heuristic (>100K per `<provider, modelVersion>`, OR p95 read latency >250ms) | Promote anyway, but file a follow-up task to swap in a sqlite or vector-DB backend. The heuristic is operator-visible, not blocking. |

### 4. Check the Decision Catalog for stale-vector / cross-provider noise

Per RFC-0019 §15 OQ-2 / OQ-3 / OQ-4 resolutions, the substrate
emits Decisions to the RFC-0035 catalog on stale-vector
encounters, cross-provider comparison attempts, and deprecation
milestones. None of these halt the pipeline (G0 non-blocking
contract), but a flood is signal that the substrate isn't
behaving the way the resolutions anticipated.

```bash
# All embedding-scoped Decisions in the soak window.
node pipeline-cli/bin/cli-decisions.mjs list \
  --scope embedding \
  --since 2026-05-01 \
  --format table
```

Expected baseline for a healthy substrate over a 1-week soak:

| Decision key | Healthy baseline | Block-promotion threshold |
|---|---|---|
| `stale-vector-encountered` | 0–5 (lazy-re-embed silently migrates; few make it to the catalog) | >50 — adapter swap is happening more often than the framework anticipates; trace which consumer is the source. |
| `cross-provider-comparison-attempted` | 0 | ≥1 — single-provider v1; any cross-provider attempt is a bug. |
| `embedding-provider-deprecated` | 0 (no provider should be in the warning window) | ≥1 — re-pin a stable adapter before flipping default-on; flipping default-on while the active provider is in its deprecation warning window is operator-hostile. |
| `embedding-provider-removed` | 0 | ≥1 — pipeline-load is already failing; flipping default-on without resolving the migration is a hard regression. |
| `cost-budget-exceeded` (scoped to embedding) | 0 | ≥1 — the configured budget needs raising or a consumer is over-querying; resolve before flipping. |

### 5. Dispatch the flag flip

Once all four checks pass:

- Consumer is exercising the substrate (Step 1)
- Cost-tracker reconciles to invoice within ±10% (Step 2)
- Storage footprint matches expectations (Step 3)
- Decision Catalog has no blocking-threshold entries (Step 4)

Follow "The flag flip" section below. Include the `cli-cost-report
--unified` output, the `cli-decisions list --scope embedding` table,
and the on-disk `_embeddings/` `wc -l` numbers in the PR body as
the audit trail.

---

## Override path (when corpus is sparse but signal is clearly fine)

Use this when:

- The downstream consumer has shipped but the soak window is
  shorter than one full corpus iteration (typical for v1 — RFC-0009
  Eτ drift fires only on RFC revisions, not on every pipeline tick), AND
- The operator has separate evidence the substrate isn't
  surprising (e.g. they've manually run `embed()` smoke tests, the
  adapter `isAvailable()` probe is green, the cost-tracker shows
  expected pricing math for a handful of test calls, and no
  high-severity Decisions are in the catalog).

The override path is the **expected default** for v1 because the
embedding corpus is operator-local — there isn't a multi-operator
aggregation surface analogous to `cli-deps-corpus aggregate` or
`cli-orchestrator-corpus aggregate`. Operator judgment + spot-check
is the rigorous path here, not a lesser path.

### Steps

1. **Smoke-test the adapter end-to-end** (cheap and definitive):

   ```bash
   AI_SDLC_EMBEDDING_PROVIDER=on \
   OPENAI_API_KEY=$OPENAI_API_KEY \
     node -e '
       import("./orchestrator/dist/embedding/registry.js").then(async ({ getEmbeddingAdapter }) => {
         const adapter = getEmbeddingAdapter("openai-text-embedding-3-small");
         const avail = await adapter.isAvailable();
         console.log("available:", avail);
         const vec = await adapter.embed("smoke test");
         console.log("dimensions:", vec.length, "first5:", vec.slice(0, 5));
       });
     '
   ```

   - `available: { available: true }` confirms the env-var probe + provider health check pass.
   - `dimensions: 1536` confirms the adapter returns the declared shape.
   - A non-error exit confirms the API key has billing permission for the embeddings line item.

2. **Spot-check the cost-tracker captured the smoke-test spend**:

   ```bash
   node pipeline-cli/bin/cli-cost-report.mjs \
     --line-item embeddingTokens \
     --since "$(date -v-1H -u +%Y-%m-%dT%H:%M:%SZ)" \
     --format json
   ```

   Look for a row matching your smoke test (~few tokens, ~$0.00000005).
   If the cost-tracker recorded NOTHING, the wiring between
   `adapter.embed()` and the cost-tracker is broken — fix that
   before promoting.

3. **Spot-check the JSONL backend wrote your smoke-test vector**:

   ```bash
   tail -1 artifacts/_embeddings/openai-text-embedding-3-small-2024-01-25.jsonl | \
     jq '{provider: .embeddingProvider, version: .embeddingModelVersion, dims: (.vector | length), text}'
   ```

   - The provider and version MUST match the configured adapter.
   - `dims` MUST equal the adapter-declared dimensions (1536 for `3-small`).
   - `text` MUST be the smoke-test string you sent (not truncated, not transformed).

4. **Scan the Decision Catalog** as in corpus-path Step 4 above.
   Block-promotion thresholds are the same.

5. **Document the decision**: when dispatching the flag-flip PR,
   include a short note in the PR body explaining which path was
   used and the evidence the operator looked at (smoke-test
   output, cost-tracker row, last-line JSONL entry, Decision
   Catalog snapshot). The override path is the operator's call to
   make, but the audit trail is mandatory.

6. **Dispatch the flag flip** the same way as the corpus path. The
   flip is identical — the only difference is which evidence
   justified it.

---

## The flag flip

The `AI_SDLC_EMBEDDING_PROVIDER` default is currently OFF. The flag
parser lives in `orchestrator/src/embedding/pipeline-load.ts`
(`isEmbeddingFrameworkEnabled`) and follows the canonical truthy-string
semantics (`1`/`true`/`yes`/`on` case-insensitive); anything else
(including unset) is OFF. To flip the default to ON, choose the
surface appropriate to your deployment:

### Option A — flip the default in the parser (single-PR flip)

Edit `orchestrator/src/embedding/pipeline-load.ts#isEmbeddingFrameworkEnabled`
so the flag defaults to ON when unset, and operators opt OUT via
`AI_SDLC_EMBEDDING_PROVIDER=off`. This is the cleanest "default-on"
flip but inverts the parser's polarity — every consumer that branches
on the flag value should be reviewed in the same PR.

A mechanical reference diff (do NOT apply blindly — review every
caller first):

```diff
-export function isEmbeddingFrameworkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
-  const raw = env.AI_SDLC_EMBEDDING_PROVIDER;
-  if (!raw) return false;
-  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
-}
+const FALSY = new Set(['off', '0', 'false', 'no']);
+export function isEmbeddingFrameworkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
+  const raw = env.AI_SDLC_EMBEDDING_PROVIDER;
+  if (!raw) return true; // default-on after RFC-0019 §11 Phase 5 promotion
+  return !FALSY.has(raw.trim().toLowerCase());
+}
```

Tests at `orchestrator/src/embedding/pipeline-load.test.ts` MUST be
updated in the same PR: the existing "OFF when unset" assertions
need flipping to "ON when unset", and a new "OFF when explicitly
disabled" assertion added. Both the truthy-string set (legacy
opt-in) AND the falsy-string set (new opt-out) MUST have test
coverage.

### Option B — set the env in the orchestrator entrypoint

Add `AI_SDLC_EMBEDDING_PROVIDER=on` to the env block of every
workflow / systemd unit / Docker container / CI job that invokes
the orchestrator with `Pipeline.spec.embedding` set — leaves the
parser's default OFF and lets local operators opt out by running
with the env unset. Less invasive but doesn't propagate to operator
shells.

The corpus-path PR should pick Option A (true default-on); the
override path may pick either depending on confidence. **Both
produce the same operator UX**: pipelines with
`Pipeline.spec.embedding` set load the substrate; pipelines without
it continue to no-op gracefully (consumers emit
`EmbeddingProviderNotConfigured` per RFC-0019 §10.2).

After the flip lands, update:

- `CLAUDE.md` — add an `AI_SDLC_EMBEDDING_PROVIDER` bullet to the
  "Feature flags" section mirroring the `AI_SDLC_DEPS_COMPOSITION`
  and `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` entries. Phrase as
  "On by default since AISDLC-NNN (YYYY-MM-DD, operator
  override-path promotion). Opt out via `AI_SDLC_EMBEDDING_PROVIDER=off`."
- `docs/operations/embedding-providers.md` — flip the "off by
  default in v1" framing in the Configuration overview section to
  reflect the new default. The "Required environment variables"
  table stays unchanged (the provider's own env var is still
  required).
- `spec/rfcs/RFC-0019-embedding-provider-adapter.md` — append a v0.4
  Revision History entry noting Phase 5 completion and the date
  the flag flipped. Lifecycle stays `Implemented`.
- AISDLC-341 (this task) — close all ACs ("runbook ships, soak
  completed, cost-tracker reconciles, default-on flipped").

---

## What happens after the flip

Once `AI_SDLC_EMBEDDING_PROVIDER` is ON by default:

- Pipelines with `Pipeline.spec.embedding` set load the substrate
  on every pipeline-load without operators having to set the env.
  Set `AI_SDLC_EMBEDDING_PROVIDER=off` locally to revert.
- Pipelines WITHOUT `Pipeline.spec.embedding` continue to no-op —
  the flag flip does not retroactively create a substrate where
  none was configured. Consumers that depend on embeddings (RFC-0009
  Eτ drift, future PPA similarity, etc.) continue to emit
  `EmbeddingProviderNotConfigured` when invoked without a spec.
- The `_embeddings/*.jsonl` files keep growing per `embed()` call;
  the per-org `gcRetentionDays` (default 90d) governs
  `cli-embedding-gc` retention sweeps.
- Cost-tracker keeps recording `embeddingTokens` line items; the
  `cli-cost-report --unified` view aggregates them with
  `inputTokens`, `outputTokens`, and SubscriptionLedger window
  consumption per RFC-0019 OQ-7 resolution.
- Deprecation milestones for the configured adapter continue to
  emit Decisions at the catalog-deduplicated milestones (89d, 60d,
  30d, 7d, 1d before `deprecatedAt` per RFC-0019 OQ-4). The
  flag flip does NOT change deprecation behaviour — it changes
  whether the substrate loads at all.

### Rollback procedure

The flag is designed to be a single-line revert. **Data persists
across the rollback** — the `_embeddings/*.jsonl` files, the
cost-tracker history, the Decision Catalog entries, and the
per-consumer wiring all keep flowing through the rollback.

Rollback is the mirror of the flip:

```bash
# Option A rollback — re-flip the parser default to OFF.
git revert <flag-flip-sha>
git push origin HEAD --force-with-lease  # only on a feature branch
```

```bash
# Option B rollback — remove the env from the workflow/unit file.
# (No code change; the workflow re-runs with the new env block.)
```

The next corpus-aggregation or smoke-test will reflect the rollback
state. Consumers that depended on the substrate when default-on will
start emitting `EmbeddingProviderNotConfigured` again — that's the
signal the flip was premature.

**Note on data persistence vs. consumer behaviour**: the rollback
does NOT delete vectors. If you re-enable later, the existing
`_embeddings/*.jsonl` files are read as if the rollback never
happened — the stale-vector policy (lazy-re-embed default) governs
how reads handle the gap. This is intentional: the substrate is
operator-owned data, not a derived cache, and a flag flip is
operator-policy, not a content-deletion event.

---

## Post-flip monitoring (RFC-0025 framework-quality metrics)

Per [RFC-0025 Framework Quality Monitoring](../../spec/rfcs/RFC-0025-framework-quality-monitoring.md),
every default-on framework feature ships with a defined set of
runtime quality metrics the orchestrator surfaces in `cli-status`
and the dashboard. For the embedding substrate post-flip:

| Metric | Source | Healthy baseline | Investigation trigger |
|---|---|---|---|
| `embedding.embed_calls_per_pipeline_run` | Cost-tracker `embeddingTokens` invocation count, joined to pipeline-run id | Stable around the consumer's expected rate (e.g. RFC-0009 Eτ drift fires on RFC revisions, not on every tick — should be ~0-10 per run depending on revision activity) | Sudden 10x increase → a new consumer wired without operator awareness; spot-check `consumerLabel` distribution. |
| `embedding.p95_embed_latency_ms` | Per-call timing recorded by the registry wrapper | <500ms for OpenAI SaaS (network-bound); <50ms for local ONNX (CPU-bound) | >1500ms p95 → provider degradation or rate-limiting; check `EmbeddingAvailability.reason: 'rate-limited'` in the Decision Catalog. |
| `embedding.stale_vector_event_rate` | RFC-0035 Decision Catalog, `stale-vector-encountered` key | <1 per 100 reads (lazy-re-embed silently migrates; few make it to the catalog) | >10 per 100 → the adapter swap story is converging slowly; either re-run `cli-embedding-bump` to flush the legacy provider, or investigate why so many reads hit stale vectors. |
| `embedding.dollar_drift_vs_invoice` | `cli-cost-report --unified` framework total vs. provider dashboard total, computed monthly | Within ±10% | >10% over a full billing month → cost-tracker instrumentation gap; trace the missing call site. |
| `embedding.jsonl_count_per_provider_version` | `wc -l artifacts/_embeddings/*.jsonl` per file | Within the scale-escalation heuristic (<100K per file) | >100K OR p95 read latency >250ms → swap storage backend per RFC-0019 §15 OQ-1; the heuristic is operator-visible, not blocking. |
| `embedding.deprecation_window_active` | Loader-emitted `DeprecationWarningEvent` against the configured adapter | False (no provider should be in the warning window for default-on adapters) | True → pin a stable adapter; the framework's milestone-dedup'd Decisions will surface the 89/60/30/7/1-day milestones in the catalog. |

Surface these in your dashboard's framework-quality pane following
the RFC-0025 template. The orchestrator emits the underlying
events to `events.jsonl` per RFC-0025 §4; the dashboard composes
the view.

If any metric crosses its investigation threshold for >7 days post-flip,
the rollback procedure is the safe revert. The metrics + data
persist across rollback, so the same evidence that triggered the
revert is available to drive the next-attempt flip.

---

## Logging an operator override (if you opted to bypass cost-tracker reconciliation)

When an operator dispatches the flag flip via the override path
WITHOUT having reconciled cost-tracker totals against the provider
invoice (e.g., dogfood smoke-test was the entire soak), log the
decision so future cost reconciliation has the baseline:

```bash
node pipeline-cli/bin/cli-decisions.mjs add \
  --summary "RFC-0019 default-on flip via override path; cost reconciliation deferred" \
  --scope embedding \
  --option "defer-reconciliation:Cost-tracker reconciliation deferred to first full billing month post-flip" \
  --evidence "smoke-test passed, 1 consumer (RFC-0009 Eτ drift) wired"
```

The first post-flip billing cycle MUST then complete the
reconciliation (corpus-path Step 2). If reconciliation fails the
±10% threshold at that point, the rollback procedure applies.

---

## Verification

After the flip lands, verify:

```bash
# Default-on: pipeline-load resolves the substrate without an explicit env override.
unset AI_SDLC_EMBEDDING_PROVIDER
node -e '
  import("./orchestrator/dist/embedding/pipeline-load.js").then(({ isEmbeddingFrameworkEnabled }) => {
    console.log("framework enabled (env unset):", isEmbeddingFrameworkEnabled({}));
  });
'
# Should print: framework enabled (env unset): true

# Opt-out path still works.
AI_SDLC_EMBEDDING_PROVIDER=off node -e '
  import("./orchestrator/dist/embedding/pipeline-load.js").then(({ isEmbeddingFrameworkEnabled }) => {
    console.log("framework enabled (env=off):", isEmbeddingFrameworkEnabled({ AI_SDLC_EMBEDDING_PROVIDER: "off" }));
  });
'
# Should print: framework enabled (env=off): false

# End-to-end: a pipeline with spec.embedding set loads the substrate
# without operator intervention.
pnpm --filter @ai-sdlc/orchestrator test src/embedding/pipeline-load.test.ts
# All test cases pass with the new default-on parser.
```

Then run one full `/ai-sdlc execute` cycle against a task that
exercises a downstream embedding consumer (e.g. an RFC-0009 Eτ
drift signal) and confirm:

- The pipeline-load step does NOT log `EmbeddingProviderDisabled`.
- The cost-tracker records at least one `embeddingTokens` line item
  with a populated `consumerLabel`.
- The `_embeddings/*.jsonl` file gains at least one new entry.
- No new `cross-provider-comparison-attempted` or
  `embedding-provider-removed` Decisions appear in the catalog.

---

## References

- RFC-0019 §11 Phase 5 (corpus-driven exit criteria)
- RFC-0019 §10.2 (feature flag definition + corpus-driven promotion pattern)
- RFC-0019 §15 OQ-1 (scale-escalation heuristic for JSONL storage)
- RFC-0019 §15 OQ-2 / OQ-3 (stale-vector + cross-provider policy contracts)
- RFC-0019 §15 OQ-4 (deprecation milestone dedup)
- RFC-0019 §15 OQ-6 / OQ-7 (per-consumer attribution + unified cost report)
- RFC-0011 §11 Phase 5 (corpus-driven flag-promotion convention — origin pattern)
- RFC-0014 §11 Phase 5 (sibling promotion pattern for `AI_SDLC_DEPS_COMPOSITION`)
- RFC-0015 §11 Phase 5 (sibling promotion pattern for `AI_SDLC_AUTONOMOUS_ORCHESTRATOR`)
- RFC-0025 (Framework Quality Monitoring) — post-flip metrics framework
- RFC-0035 (Decision Catalog) — G0 non-blocking pipeline contract for operator-impacting events
- AISDLC-340 (Phase 4 — pipeline integration + schema; the prerequisite this runbook builds on)
- AISDLC-317 (RFC-0009 Phase 4.2 Eτ rule #2 — the first downstream consumer; the "at least one consumer shipped" gate)
- [`docs/operations/embedding-providers.md`](embedding-providers.md) — day-to-day operations runbook for the flag itself
- [`docs/operations/deps-composition-promotion.md`](deps-composition-promotion.md) — sister promotion runbook for RFC-0014's `AI_SDLC_DEPS_COMPOSITION` flip; same hybrid-corpus-OR-override structure
- [`docs/operations/orchestrator-promotion.md`](orchestrator-promotion.md) — sister promotion runbook for RFC-0015's `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` flip; same hybrid structure
- [`docs/operations/dor-promotion.md`](dor-promotion.md) — sister promotion runbook for RFC-0011 DoR `enforce` flip; the original hybrid-path pattern
