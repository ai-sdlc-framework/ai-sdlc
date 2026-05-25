# Promoting `AI_SDLC_SIGNAL_INGESTION` from default-OFF to default-ON

**Audience**: AI-SDLC operators (specifically: whoever is dispatching the
final flag-flip PR for RFC-0030). This is the runbook for the final step
of RFC-0030 — flipping the `AI_SDLC_SIGNAL_INGESTION` env-var default
from `off` to `on` so the signal ingestion pipeline becomes the standard
demand-input path for D1 alongside human-authored backlog items.

**TL;DR**: there are two paths. Both produce the same default-on
end-state. Pick based on whether the adopter corpus is rich enough.

| Path | When to use | Tooling | Authority |
|---|---|---|---|
| **Corpus path** | ≥3 adopter projects have run the pipeline with `enabled: true` for ≥30 days each AND emitted SoulDriftDetected events at rates consistent with their non-pipeline baseline | Aggregator over per-adopter telemetry | Math-rigorous; recommendation drops out of the data |
| **Override path** | Corpus is sparse OR the operator has separate evidence (spot-check of cluster outputs, manual review of D1 ranking deltas, no soul-drift surprises) the pipeline isn't disrupting | Eyeball recent `SignalIngestionConfigChanged` events + `cli-status --orchestrator` events tail | Operator judgment |

This runbook intentionally mirrors the structure of the established
flag-flip runbooks for the framework's other major composition layers
([deps-composition-promotion.md](deps-composition-promotion.md),
[orchestrator-promotion.md](orchestrator-promotion.md), and
[dor-promotion.md](dor-promotion.md)) so operators who've shipped one
have the muscle memory for the rest.

---

## Background: why two paths?

Per the cross-RFC pattern (RFC-0011 / RFC-0014 / RFC-0015 / RFC-0030):
**calendar duration is a side-effect, not a gate**. The promotion criteria
are:

- **Signal classification correctness > 95%** (manual spot-check on a
  sampled cluster set: the classifier's tier + ICP + recency assignments
  match what an operator would assign), AND
- **No SA-drift false-alarm spike** vs the baseline rate (the
  `SoulDriftDetected` event with `driftSource: 'demandMisalignment'`
  is not firing more often under signal-ingestion than under the
  backlog-only baseline — the soul-resonance filter is doing its job
  without manufacturing false positives), AND
- **No D1 ranking-delta spike** vs baseline that surprises operators
  (when both pipelines are enabled and weighted 50/50, the resulting D1
  ranking is not dramatically different from what the backlog-only path
  would have produced for the same set of issues — at most a few
  candidates re-ranked, not a wholesale reshuffle)

Whichever path satisfies the criteria first wins. Until enough adopter
corpus accumulates for confident math, the operator may use the override
path (eyeball + judgment) so the promotion isn't gated on calendar time.

The two paths produce the same end-state: the `AI_SDLC_SIGNAL_INGESTION`
default flips from `off` to `on` in the appropriate config file (see
"The flag flip" below). The only difference is which evidence justified
the flip.

---

## Corpus path (preferred when adopter telemetry available)

### 1. Collect adopter telemetry

Each adopter who opted into the pipeline produces per-tick governance
events under their project-local
`<ARTIFACTS_DIR>/_orchestrator/events-YYYY-MM-DD.jsonl`:

- `SignalIngestionConfigChanged` events — confirm operators are tuning
  rather than thrashing (a stable config means the defaults work).
- `SoulDriftDetected` events with `driftSource: 'demandMisalignment'` —
  the canary for soul-drift false alarms.

The framework does not centrally collect adopter telemetry; the corpus
path requires adopters to opt in to sharing aggregated metrics. The
recommended share-shape (anonymised):

```jsonl
{"adopter":"adopter-a","windowStartIso":"2026-04-01","windowEndIso":"2026-05-01","configChangedEventCount":3,"soulDriftEvents":0,"d1RankShuffleRate":0.04}
{"adopter":"adopter-b","windowStartIso":"2026-04-01","windowEndIso":"2026-05-01","configChangedEventCount":7,"soulDriftEvents":1,"d1RankShuffleRate":0.07}
```

(Schema is informal; the future `cli-signal-corpus aggregate` follow-up
will publish a canonical shape.)

### 2. Apply the promotion criteria

Compute, across the corpus:

- **Mean `d1RankShuffleRate` < 10%** — under 50/50 composition, the
  signal-pipeline-derived demand isn't reshuffling D1 dramatically.
- **`soulDriftEvents` per adopter < 1 per quarter** — the SA filter
  isn't manufacturing false drift alarms.
- **Adopter count ≥ 3** — single-adopter signal could be deployment-
  specific.
- **Soak duration per adopter ≥ 30 days** — flooding-style adversarial
  signal patterns take time to surface.

When all four hold: the recommendation is `safe-to-promote`. Dispatch the
flag flip (see "The flag flip" below).

### 3. When the corpus is sparse

If you have ≥3 adopters but the soak duration is under 30 days, or you
have longer soak but only 1-2 adopters, the corpus is **not** sufficient
for the math-rigorous recommendation. Switch to the override path.

---

## Override path (operator judgment)

Use this path when:

- The corpus is sparse or non-existent.
- You have separate evidence — spot-checks of the cluster outputs,
  manual review of D1 ranking deltas, observation that
  `SignalIngestionConfigChanged` events are infrequent (operators aren't
  thrashing the config because the defaults work), no soul-drift
  surprises.
- You want to ship the promotion ahead of corpus-readiness because the
  cost of waiting (operators having to remember the env-flag opt-in)
  outweighs the marginal confidence the corpus would add.

### Spot-check protocol

For each adopter who has opted in:

1. **Read recent `SignalIngestionConfigChanged` events** (last 4 weeks):

   ```bash
   find artifacts/_orchestrator -name 'events-*.jsonl' \
     -newer <(date -d '4 weeks ago' +%Y-%m-%d) \
     -exec jq -c 'select(.type == "SignalIngestionConfigChanged") | {ts, comparedAgainst, changes: .changes | length}' {} \;
   ```

   Expectations:
   - Initial first-load event (`comparedAgainst: "defaults"`, often a
     handful of changes from the opt-in commit).
   - 0-3 subsequent tuning events (`comparedAgainst: "previous-load"`)
     in the first month.
   - Steady-state: < 1 event per month per adopter.

   Red flag: weekly config thrash. If you see this, the defaults aren't
   working for the adopter — don't promote on top of unstable config;
   investigate first.

2. **Sample 10 clusters from the current `_signal-ingestion/clusters/`
   dir (when it exists in your adopter's artifacts)** and manually
   review:

   - Does the cluster's `topSummary` match the underlying signal payloads?
   - Does the cluster's `icpMatchRate` align with the member signals'
     customer tiers?
   - Does the cluster's `saResonance` match what you'd assign by hand
     (within ±0.15)?

   A 9/10 hit rate is the bar. < 7/10 → don't promote; investigate the
   classifier or clustering tuning first.

3. **Check `SoulDriftDetected` events** for `driftSource:
   'demandMisalignment'`:

   ```bash
   jq -c 'select(.type == "SoulDriftDetected" and .driftSource == "demandMisalignment")' \
     artifacts/_orchestrator/events-*.jsonl
   ```

   Expectations: 0 per adopter per quarter under the default SA
   threshold (0.7 / 0.4 / 0.0). 1-2 are tolerable if the operator
   confirms they were intentional (the soul actually drifted, or the
   incoming demand actually drifted). > 3 → either the SA threshold is
   too strict for the adopter or the soul-drift detection is hyper-
   sensitive; don't promote until the false-alarm rate stabilises.

4. **Review the D1 ranking under 50/50 composition** for the last
   sprint:

   - Top 10 candidates under signal-pipeline-on vs signal-pipeline-off.
   - Acceptable: 1-3 candidates shuffled between the two ranks.
   - Concerning: >5 candidates shuffled, including the top-3 — the
     pipeline is reshaping prioritisation, which may be correct (it's
     supplying signal the backlog-only path lost) but the operator
     should confirm before promotion.

When all four spot-checks pass: dispatch the flag flip.

---

## The flag flip

Both paths converge on the same diff: change the default in
`pipeline-cli/src/orchestrator/feature-flag.ts` (or whichever module
owns the env-flag resolution for signal-ingestion, mirroring the
`AI_SDLC_DEPS_COMPOSITION` / `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` pattern):

```diff
- const DEFAULT_SIGNAL_INGESTION = 'off';
+ const DEFAULT_SIGNAL_INGESTION = 'on';
```

…and the corresponding test fixture(s) flip.

**Backward-compat:** keep the opt-out path live indefinitely. Adopters
opt out via `AI_SDLC_SIGNAL_INGESTION=off` (or `0`/`false`/`no`/`disabled`,
case-insensitive) just like the deps + orchestrator flags. Truthy values
(`1`/`true`/`yes`/`on`) remain honoured for compatibility with anyone
who scripted the opt-in.

**CLAUDE.md note:** add a one-liner under the `## Feature flags` section
matching the format used for the other promoted flags:

```markdown
- **`AI_SDLC_SIGNAL_INGESTION`** (RFC-0030): gates the signal ingestion
  pipeline. **On by default since AISDLC-NNN (YYYY-MM-DD, operator
  <path> promotion).** Opt out via `AI_SDLC_SIGNAL_INGESTION=off`
  (or `0`/`false`/`no`, case-insensitive); truthy values
  (`1`/`true`/`yes`/`on`) are honored for backward-compat. The YAML
  `spec.enabled: false` toggle still independently controls per-org
  participation. See
  [`docs/operations/signal-ingestion.md`](docs/operations/signal-ingestion.md)
  and
  [`docs/operations/signal-ingestion-promotion.md`](docs/operations/signal-ingestion-promotion.md).
```

---

## Rollback

If the promotion surfaces a regression (false-positive soul drift, D1
ranking instability, classifier mis-tiering at scale), the rollback is a
one-line PR reverting the default flip. Adopters who'd come to rely on
the default-on behaviour without explicitly opting in will lose the
pipeline — that's the intended signal that the promotion was premature.

The per-adopter YAML toggle (`spec.enabled`) is unaffected by env-flag
rollback; adopters who explicitly set `true` retain their behaviour.

---

## Post-flip monitoring

For 30 days after the flag flip:

1. **Watch `SoulDriftDetected` events** with `driftSource:
   'demandMisalignment'` across the framework's own dogfood corpus. A
   spike means the SA filter calibration the operator chose was tuned
   for a smaller signal set; bump the default `fullWeight` threshold up
   (e.g. 0.75) in a follow-up PR if needed.

2. **Watch `SignalIngestionConfigChanged` event volume.** A surge in
   first-load events (`comparedAgainst: "defaults"`) is expected (every
   adopter is now starting with `enabled: true`); a surge in
   `comparedAgainst: "previous-load"` events would suggest adopters are
   thrashing the defaults — that's a signal to refine the shipped
   defaults, not to walk back the promotion.

3. **Track the open-PR / capture-record stream** for issue titles
   matching `signal-ingestion: ` — these are operator-filed concerns
   that should feed into a v2 RFC if the pattern is structural.

---

## See also

- [`docs/operations/signal-ingestion.md`](signal-ingestion.md) — the
  operator runbook for using the pipeline; this promotion runbook
  assumes operators have read it.
- [`docs/operations/dor-promotion.md`](dor-promotion.md) — RFC-0011 DoR
  promotion runbook; same hybrid-corpus pattern.
- [`docs/operations/deps-composition-promotion.md`](deps-composition-promotion.md)
  — RFC-0014 deps-composition flag-flip; same hybrid-corpus pattern,
  most recently promoted (AISDLC-410 / 2026-05-23).
- [`docs/operations/orchestrator-promotion.md`](orchestrator-promotion.md)
  — RFC-0015 autonomous-orchestrator flag-flip; same hybrid-corpus
  pattern, promoted alongside deps-composition (AISDLC-411 /
  2026-05-23).
- [`spec/rfcs/RFC-0030-signal-ingestion-pipeline.md`](../../spec/rfcs/RFC-0030-signal-ingestion-pipeline.md)
  — the source-of-truth specification.
