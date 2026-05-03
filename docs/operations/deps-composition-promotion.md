# Promoting `AI_SDLC_DEPS_COMPOSITION` from default-OFF to default-ON

**Audience**: AI-SDLC operators (specifically: whoever is dispatching the
final flag-flip PR for RFC-0014). This is the runbook for the final step
of RFC-0014 Phase 5 — flipping the `AI_SDLC_DEPS_COMPOSITION` env-var
default from `off` to `on` so the depth-aware dispatcher composition
becomes the standard behaviour.

**TL;DR**: there are two paths. Both produce the same default-on
end-state. Pick based on whether the snapshot corpus is rich enough.

| Path | When to use | Tooling | Authority |
|---|---|---|---|
| **Corpus path** | Snapshot corpus has ≥30 entries | `cli-deps-corpus aggregate` | Math-rigorous; recommendation drops out of the data |
| **Override path** | Corpus is sparse OR the operator has separate evidence (dashboard `/deps` page from AISDLC-167.4) the dispatcher isn't surprising | Eyeball recent dispatch decisions in the dashboard / `cli-deps frontier` output | Operator judgment |

---

## Background: why two paths?

Per maintainer directive 2026-05-01 (RFC-0014 §11 Phase 5): **calendar
duration is a side-effect, not a gate**. The promotion criteria are:

- **Dispatch correctness > 95%** (composition mode's top-of-frontier
  matches the baseline mode's top-of-frontier — i.e. the composition
  isn't shuffling the ranking in surprising ways), AND
- **No operator override-rate spike** vs baseline (operators aren't
  routinely picking past the dispatcher's top — measured via the
  override log AISDLC-167.5 ships).

Whichever path satisfies the criteria first wins. Until the snapshot
corpus accumulates enough data after Phase 1-4 ship for confident
math, the operator may use the override path (eyeball + judgment) so
the promotion isn't gated on calendar time.

The two paths produce the same end-state: the
`AI_SDLC_DEPS_COMPOSITION` default flips from `off` to `on` in the
appropriate config file (see "The flag flip" below). The only
difference is which evidence justified the flip.

---

## Corpus path (preferred when snapshotCount ≥ 30)

### 1. Collect snapshot artifacts

The Phase 1 `cli-deps snapshot` writer emits a JSONL artifact per
pipeline tick (when the flag is opted-on by an operator). Collect
recent snapshots into a single directory:

```bash
mkdir -p ./deps-corpus
# Local — every operator who opted in has snapshots under their
# project-local `$ARTIFACTS_DIR/_deps/`. The conventional location is
# `./artifacts/_deps/` when ARTIFACTS_DIR isn't set.
cp -r ./artifacts/_deps/* ./deps-corpus/
```

If you've also been uploading snapshots as workflow artifacts (e.g.
from a CI job that runs `cli-deps snapshot --tag dispatch`), download
them with `gh run download`:

```bash
gh run list --limit 100 --json databaseId \
  | jq -r '.[].databaseId' \
  | while read run_id; do
      gh run download "$run_id" --pattern '*-deps-snapshots' --dir ./deps-corpus 2>/dev/null || true
    done
```

The `gh run download` layout drops one subdirectory per artifact;
`cli-deps-corpus` recurses into the root and globs all snapshot
JSONLs automatically. **Do NOT delete the operator overrides log**
(`overrides.jsonl`) — the aggregator joins it with the snapshot
corpus to compute the override rate.

### 2. Run the aggregator

```bash
node pipeline-cli/bin/cli-deps-corpus.mjs aggregate ./deps-corpus --format table
```

Or for JSON output (useful when chaining with `jq` for the dispatch
decision):

```bash
node pipeline-cli/bin/cli-deps-corpus.mjs aggregate ./deps-corpus
```

The aggregator auto-detects an `overrides.jsonl` file under the input
root. To point at one outside the root, pass `--overrides-file
./path/to/overrides.jsonl`.

### 3. Read the `recommendation` field

- **`safe-to-promote`** — `snapshotCount ≥ minSnapshots`,
  `dispatchAgreementRate ≥ 95%`, and `overrideRate < 10%`. Dispatch
  the flag flip (see "The flag flip" below).
- **`continue-soak`** — corpus has enough data, but at least one of
  the gates above failed. The `reason` field names the failing
  metric — that's the next thing to tune (or wait on more data).
- **`insufficient-data`** — `snapshotCount < minSnapshots`. Either
  wait for more activity or use the override path below.

Tunables (rarely needed; defaults match RFC-0014 §11 Phase 5):

- `--min-snapshots` — corpus-size floor (default 30)
- `--correctness-threshold` — dispatch agreement floor (default 0.95)
- `--override-threshold` — operator override-rate ceiling (default 0.10)

### 4. Dispatch the flag flip

Once `recommendation: safe-to-promote` lands, follow "The flag flip"
section below. Include the `cli-deps-corpus aggregate` JSON envelope
in the PR body as the audit trail.

---

## Override path (when corpus is sparse but signal is clearly fine)

Use this when:

- `cli-deps-corpus` returns `insufficient-data`, AND
- The operator has separate evidence the dispatcher isn't surprising
  (e.g. they've spot-checked recent dispatch decisions in the
  dashboard `/deps` page from AISDLC-167.4, or scanned the output of
  `cli-deps frontier --format table` over recent ticks and the
  rankings looked reasonable).

### Steps

1. **Spot-check the dashboard or `cli-deps frontier`**:

   ```bash
   AI_SDLC_DEPS_COMPOSITION=1 node pipeline-cli/bin/cli-deps.mjs frontier --format table
   ```

   - Is the top-of-frontier task one a human would have picked? (Good
     — the composition is matching operator intuition.)
   - Is the top-of-frontier surprising — a low-priority item in the
     #1 slot? Trace the rationale via the `EffPri`/`CPL` columns.
     If it's clear ("oh, this leaf unblocks a critical-tagged chain"),
     that's the composition working as intended. If it's unclear,
     do NOT promote yet.

2. **Check the override log** (the ground-truth signal):

   ```bash
   node pipeline-cli/bin/cli-deps.mjs list-overrides --format table
   ```

   How often did operators apply `cli-deps log-override`? If you can
   find ~5 examples in recent activity and the snapshot corpus has
   <30 entries, the override path is what you want — the corpus is
   sparse but the operator-decision signal is healthy.

3. **Document the decision**: when dispatching the flag-flip PR,
   include a short note in the PR body explaining which path was
   used and the evidence the operator looked at. The override path
   is the operator's call to make, but the audit trail is mandatory.

4. **Dispatch the flag flip** the same way as the corpus path. The
   flip is identical — the only difference is which evidence
   justified it.

---

## The flag flip

The `AI_SDLC_DEPS_COMPOSITION` default is currently OFF. The flag
parser lives in `pipeline-cli/src/deps/snapshot.ts` (`isCompositionEnabled`)
and follows the standard truthy-string semantics
(`1`/`true`/`yes`/`on` case-insensitive). To flip the default to ON,
choose the surface appropriate to your deployment:

### Option A — flip the default in the parser (single-PR flip)

Edit `pipeline-cli/src/deps/snapshot.ts#isCompositionEnabled` so the
flag defaults to ON when unset, and operators opt OUT via
`AI_SDLC_DEPS_COMPOSITION=0`. This is the cleanest "default-on" flip
but inverts the parser's polarity — every consumer that branches on
the flag value should be reviewed in the same PR.

### Option B — set the env in the orchestrator entrypoint

Add `AI_SDLC_DEPS_COMPOSITION=1` to the env block of every workflow
that invokes `cli-deps`/`cli-deps-corpus` — leaves the parser's
default OFF and lets local operators opt out by running with the env
unset. Less invasive but doesn't propagate to operator shells.

The corpus-path PR should pick Option A (true default-on); the
override path may pick either depending on confidence. **Both produce
the same operator UX**: snapshots materialise on every `cli-deps
snapshot` invocation, the dispatcher sorts by `effectivePriority`
unless overridden, and the DoR comment includes the blast-radius
callout.

After the flip lands, update:

- `CLAUDE.md` — change the "Off by default" line in the
  `AI_SDLC_DEPS_COMPOSITION` bullet to "On by default; set to `0` to
  disable."
- `docs/operations/deps-composition.md` — flip the "TL;DR" and the
  enable-instructions section to reflect the new default.
- `pipeline-cli/docs/deps.md` — flip the "Phase 1 ships behind a
  feature flag" framing to "Phase 1+ are on by default; opt-out via
  `AI_SDLC_DEPS_COMPOSITION=0`".
- AISDLC-167 (parent) — close ACs #2, #3, #5 ("flag promoted, dogfood
  pipeline running with composition end-to-end, runbook extended").

---

## Logging an override (operator workflow)

When an operator dispatches a task that ISN'T the dispatcher's
top-of-frontier, log the decision so the next aggregator run captures
it:

```bash
node pipeline-cli/bin/cli-deps.mjs log-override \
  --picked AISDLC-XXX \
  --reason "B is gated on a third-party PR I just got merged"
```

The CLI:

- Computes the current ranked frontier (composition mode, regardless
  of the env flag — the override IS the soak signal).
- Refuses if `picked` is already the dispatcher's top pick (no
  override happened).
- Refuses if `picked` isn't on the ranked frontier at all (operator
  typo, or task isn't ready yet).
- Else writes one JSONL line to `$ARTIFACTS_DIR/_deps/overrides.jsonl`
  capturing the snapshot path, dispatcher top, operator pick, the
  top-10 ranking, and the optional reason.

The aggregator (`cli-deps-corpus aggregate`) joins this log with the
snapshot corpus to compute `operatorOverrideRate`.

---

## What happens after the flip

Once `AI_SDLC_DEPS_COMPOSITION` is ON by default:

- `cli-deps snapshot` materialises a snapshot every tick (no longer
  a no-op). Set `AI_SDLC_DEPS_COMPOSITION=0` locally to revert.
- `cli-deps frontier` ranks by `effectivePriority` automatically;
  every operator + slash command that calls it gets the composition
  view.
- The DoR comment template includes the blast-radius callout for
  high-radius issues; bypass-admitted high-radius tasks get the
  maintainer-tone FYI variant.
- Future Phase 4 surfaces (Slack digest, dashboard) consume the
  snapshot artifact directly.

If the flip turns out to be premature (override-rate spikes after
promotion), revert the parser change (Option A) or remove the env
override (Option B) in a single-line PR. The snapshot artifacts and
the override log keep accumulating regardless of mode; nothing
on-disk needs to be undone.

---

## Verification

After the flip lands, verify:

```bash
# Default-on: snapshot writes without an explicit env override.
node pipeline-cli/bin/cli-deps.mjs snapshot --tag rolling
# Should report `"written": true`.

# Frontier composition: top pick should match the previous
# AI_SDLC_DEPS_COMPOSITION=1 output.
node pipeline-cli/bin/cli-deps.mjs frontier --format table
# Compare against the explicit-on version:
AI_SDLC_DEPS_COMPOSITION=1 node pipeline-cli/bin/cli-deps.mjs frontier --format table
# (Should be identical.)

# Opt-out path still works.
AI_SDLC_DEPS_COMPOSITION=0 node pipeline-cli/bin/cli-deps.mjs snapshot --tag rolling
# Should report `"written": false`.
```

Then run one full `/ai-sdlc execute` cycle and confirm the dispatch
decision matches the composition view.

---

## References

- RFC-0014 §11 Phase 5 (corpus-driven exit criteria)
- RFC-0014 §12 Q1 (dispatcher sort order)
- AISDLC-167.5 (this PR — corpus aggregator + override capture +
  this runbook)
- AISDLC-167.2 (Phase 2 — depth-aware dispatcher composition)
- AISDLC-167.3 (Phase 3 — DoR blast-radius surfacing)
- AISDLC-167.4 (Phase 4 — Slack + dashboard digest, the "spot-check
  recent dispatch decisions" surface for the override path)
- [`docs/operations/deps-composition.md`](deps-composition.md) — the
  enable / disable / observability runbook for the flag itself
- [`docs/operations/dor-promotion.md`](dor-promotion.md) — sister
  promotion runbook for the RFC-0011 DoR `enforce` flip; same
  hybrid-corpus-OR-override structure
