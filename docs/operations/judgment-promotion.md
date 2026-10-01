# Promoting a judgment from `shadow` to `enforce`

**Audience**: AI-SDLC operators. This is the runbook for the step that lets a judgment
decide instead of only being logged: changing `mode: shadow` to `mode: enforce` for one
judgment in `.ai-sdlc/judgment-config.yaml`. It follows RFC-0049 section 8; the shape
mirrors [`dor-promotion.md`](dor-promotion.md). Setup, providers and the log are in
[`judgment-layer.md`](judgment-layer.md).

**TL;DR**: the bar depends on the judgment's `riskClass`. Seam and tighten judgments
can promote on a labelled corpus or on a documented operator override. A relax judgment
can promote on a corpus only.

| `riskClass` | Corpus path | Operator-override path |
|---|---|---|
| `seam` | n >= 50 labelled items, act-band precision >= 90% | Allowed, with the evidence the operator looked at recorded in the PR |
| `tighten` | n >= 50 labelled items, act-band precision >= 90% | Allowed, same condition |
| `relax` | n >= 50 rows from the findings ledger, act-band precision >= 95% | **Not allowed** |

A `relax` judgment is one whose wrong answer reduces review of code that merges. It
has no override path: the runtime refuses an `override` promotion record for it, so
the only way to promote one is to clear the 95% corpus bar.

"Act-band precision" is the share of items the judgment would have acted on, at the
proposed thresholds, where the labelled outcome agrees with the decision.

The runtime enforces the bar in code (the `no-promotion` downgrade): a promotion
record that does not satisfy the judgment's `riskClass` bar leaves the judgment running
as `shadow`. `openai-compatible` judgments cannot be promoted in v1 (they are
uncalibrated); promotion applies to a calibrated provider such as `jev`.

---

## Before you start

- Pin an exact model version in `spec.model` (for example `jev-1.13.0`). Aliases such
  as `jev-latest` stay in `shadow`.
- Thresholds and promotion records are keyed by `provider@model`
  (for example `jev@jev-1.13.0`). They never carry from one provider or version to
  another.
- Find the judgment's `riskClass` and the threshold names it reads:

  ```bash
  node pipeline-cli/bin/cli-judgment.mjs list --config .ai-sdlc/judgment-config.yaml
  ```

---

## Corpus path

### 1. Build a labelled corpus

`eval` reads JSONL: one `{"input": ..., "label": ...}` object per line, where `input`
is what the judgment is given and `label` is the outcome you consider correct. Limits:
20 MiB and 10,000 items.

The corpora that exist today (RFC-0049 section 8): operator overrides in the classifier
calibration corpus, `_dor/calibration.jsonl` and the `spec/dor-corpus/` fixtures for
definition-of-ready, the estimate log, the decision log's `overridden` events, the
review-routing calibration log, and the findings ledger for relax judgments. Shadow
logging fills the gaps.

Converter shipped with `cli-judgment`: `export-corpus` turns a classifier calibration
file (`.ai-sdlc/classifier-corpus/<task-type>.yaml`) into eval JSONL. Only entries that
carry an operator override become rows; the override is the label.

```bash
node pipeline-cli/bin/cli-judgment.mjs export-corpus capture-severity --out severity-corpus.jsonl
```

Task types: `capture-triage`, `capture-severity`, `pr-comment-is-capture`,
`dor-answer-is-new-concern`, `decision-recommendation`. Without `--out` the JSONL goes
to stdout; `--corpus-dir <dir>` reads a different directory. The command writes
`wrote N rows to <file>`; if N is below 50 the corpus is too small for this path.

For other judgments, convert your source to the same two-field JSONL shape. The `label`
must be comparable by the judgment's own comparison (its `agrees` function); for the
classifier judgments the label is the classification string.

### 2. Run the evaluation

`eval` calls the provider once per item, so it needs a configured provider and its
credential (`TYPESAFE_API_KEY` for `jev`). Run it in shadow config; `eval` forces
shadow itself and turns the answer cache on, so a repeat run is free.

```bash
node pipeline-cli/bin/cli-judgment.mjs eval capture.severity --corpus severity-corpus.jsonl --config .ai-sdlc/judgment-config.yaml
```

Without a working provider every item abstains and the report shows
`abstain` for all of them with a note that the layer is disabled or the provider is
unavailable; fix that first (`cli-judgment doctor`). Judgments that read thresholds use
the ones in your config for the active `provider@model`; override them for one run with
`--threshold <name>=<number>` (repeatable). `--source-kind` (default `backlog`) sets the
kind of work items; only `backlog` may decide permissively.

### 3. Choose thresholds with `--sweep`

`--sweep <name>=<from>:<to>:<step>` recomputes the outcomes across a range of one
threshold from the answers already collected, so it makes no extra provider calls. Use
it to find the setting that clears the bar with the most items still acted on.

```bash
node pipeline-cli/bin/cli-judgment.mjs eval capture.severity --corpus severity-corpus.jsonl --config .ai-sdlc/judgment-config.yaml --sweep confidence=0.5:0.9:0.1
```

`<name>` must be a threshold the judgment reads (`capture.severity` reads
`confidence`; the noul-style `capture.pr-comment` reads `distance`). A range over
1,000 steps, `from` above `to`, or a non-positive `step` is refused.

### 4. Read the report

`eval` prints a summary and writes the full report to
`.ai-sdlc/judgment-evals/<judgment>-<provider>-<model>-<date>.json`. Commit that file
with the promotion PR.

| Line | What it tells you |
|---|---|
| `judgment <id> v<N> on <provider@model>: n=<N>` | How many corpus items were evaluated. Needs >= 50. |
| `bands: act ..., escalate ..., abstain ...` | How many items landed in each band, with shares. A judgment that acts on almost nothing is safe but saves nothing. |
| `act-band precision: P% (agreeing/act)` | The number the bar is about: of the items it acted on, how many agree with the label. |
| `latency p50 ... p95 ...; calls, cache hits; input tokens; cost` | Latency percentiles and spend for the run. |
| `confusion (decision rows, label columns)` | Decision against label. Rows are `act:<decision>`, `escalate` or `abstain`. Read it for which wrong answers dominate. Omitted when there are too many distinct values. |
| `sweep <name>:` table | Per threshold value: counts per band and act-band precision. |
| `MET` or `NOT MET: ...` | The bar for the judgment's `riskClass`, stated with the numbers. |

If the statement says `NOT MET`, do not promote on this path. Tune thresholds, add
labelled items, or (seam and tighten only) use the override path below.

### 5. Paste the promotion record

`eval` ends with a `promotion snippet`. Paste it into the judgment's block in
`.ai-sdlc/judgment-config.yaml`, add the thresholds you chose, and set the mode. The
snippet carries `path: corpus`, `n` and `evalReport`; it also carries
`actBandPrecision` when at least one item landed in the act band. For example:

```yaml
spec:
  judgments:
    capture.severity:
      mode: enforce
      thresholds:
        jev@jev-1.13.0:
          confidence: 0.8
      promotion:
        jev@jev-1.13.0:
          path: corpus
          n: 75
          actBandPrecision: 0.93
          evalReport: .ai-sdlc/judgment-evals/capture.severity-jev-jev-1.13.0-2026-10-14.json
```

Open a pull request with that change. The PR is the audit trail: it cites the report.
Then confirm the runtime accepts it:

```bash
node pipeline-cli/bin/cli-judgment.mjs list --config .ai-sdlc/judgment-config.yaml
```

The `effective` column reads `enforce` when every condition holds, or
`shadow (<reason>)` naming what is missing (see the downgrade reasons in
[`judgment-layer.md`](judgment-layer.md)).

---

## Override path (seam and tighten only)

Use this when the corpus is too small or the labelled outcomes are not available, and
you have separate evidence that the judgment's acts are sound. It is never available
for a `relax` judgment.

1. **Look at the shadow data.** Shadow logging records the judgment's answers next to
   what the existing path decided (`incumbent`). Replay it under the thresholds you
   propose:

   ```bash
   node pipeline-cli/bin/cli-judgment.mjs replay --since 2026-10-01 --judgment capture.severity --config .ai-sdlc/judgment-config.yaml --threshold confidence=0.8
   ```

   The output reports records, outcomes per band and agreement with the incumbent. It
   makes no provider calls. A judgment whose `compose` reads its input cannot be
   replayed, because the log keeps a hash of the input and not the input.
2. **Spot-check.** Read a sample of the acted outcomes against the underlying work
   items. Note what you checked and what you found.
3. **Record it.** Write a promotion record with `path: override` and non-empty
   `evidence` text saying what you looked at:

   ```yaml
   promotion:
     jev@jev-1.13.0:
       path: override
       evidence: Spot-checked 30 shadow records against the incumbent; no wrong act outcomes.
   ```

   The runtime requires non-empty `evidence` on this path, and the PR must carry the
   same evidence. The override is the operator's call, but the audit trail is
   mandatory.
4. Set `mode: enforce`, add thresholds for the active `provider@model`, and open the
   PR.

---

## Rollback

Set the judgment's mode back to `shadow` in `.ai-sdlc/judgment-config.yaml` and merge.
Nothing on disk needs undoing: the log keeps accumulating and callers resume their
existing path. To stop all judgments at once, set `AI_SDLC_JUDGMENT=off` in the
environment (see the kill switch in [`judgment-layer.md`](judgment-layer.md)).

## What happens on a model version change

A change to the pinned `spec.model` returns every `enforce` judgment to `shadow`:
thresholds and promotion records are keyed by `provider@model`, so none exist for the
new version (`no-thresholds`, then `no-promotion`). If the provider reports a
different version than the one pinned, the judgment also runs as `shadow`
(`model-mismatch`). To restore enforcement, re-run `eval` against the new version,
add thresholds and a promotion record under the new key, and open a PR. The old key's
records can stay for history.

## References

- RFC-0049 section 8, Evaluation and promotion
- [`judgment-layer.md`](judgment-layer.md), operator runbook
- [`judgment-definitions.md`](judgment-definitions.md), what `riskClass` requires
- [`dor-promotion.md`](dor-promotion.md), the corpus-versus-override pattern this
  runbook follows
