# Promoting the DoR gate from `warn-only` to `enforce`

**Audience**: AI-SDLC operators (specifically: whoever is dispatching
AISDLC-115.9). This is the runbook for the final step of RFC-0011 Phase 8
— flipping `evaluationMode: warn-only → enforce` in the dogfood project's
`.ai-sdlc/dor-config.yaml`.

**TL;DR**: there are two paths. Both produce the same `evaluationMode:
enforce` end-state. Pick based on whether the calibration corpus is rich
enough.

| Path | When to use | Tooling | Authority |
|---|---|---|---|
| **Corpus path** | Corpus has ≥50 entries | `cli-dor-corpus aggregate` | Math-rigorous; recommendation drops out of the data |
| **Override path** | Corpus is sparse OR the operator has separate evidence the gate isn't refusing real issues | Eyeball recent dor-ingress runs in the GitHub Actions UI | Operator judgment |

---

## Background: why two paths?

RFC-0011 Phase 7 (AISDLC-115.8) AC #5 specifies a corpus-driven exit
criterion: false-positive rate < 10% per gate AND override-rate plateau.
That criterion was adopted per maintainer directive 2026-05-01: **calendar
duration is a side-effect, not a gate**.

Until AISDLC-161 landed, the GitHub Action ingress (`dor-ingress.yml`)
ran the rubric on every issue + PR change but wrote calibration entries
to the runner's tmpdir, which was discarded at job end. **Net effect:
zero calibration data accumulated** despite the workflow running
hundreds of times.

AISDLC-161 fixed the ingress side (artifact upload + `cli-dor-corpus`
aggregator), but until enough runs accumulate after the fix lands, the
corpus may legitimately be too small for the math-rigorous decision. The
override path covers that gap so the operator isn't gated on calendar
time.

---

## Corpus path (preferred when n ≥ 50)

1. Find recent DoR workflow runs that produced calibration artifacts:

   ```bash
   gh run list --workflow=dor-ingress.yml --limit 100 --json databaseId,status,conclusion
   ```

2. Download all `dor-calibration-*` artifacts into a single directory:

   ```bash
   mkdir -p ./dor-corpus
   gh run list --workflow=dor-ingress.yml --limit 100 --json databaseId \
     | jq -r '.[].databaseId' \
     | while read run_id; do
         gh run download "$run_id" --pattern 'dor-calibration-*' --dir ./dor-corpus 2>/dev/null || true
       done
   ```

   The `gh run download` layout drops one subdirectory per artifact
   (e.g. `./dor-corpus/dor-calibration-issue-42-1/calibration.jsonl`).
   `cli-dor-corpus` recurses into the root and globs all `*.jsonl`
   automatically.

3. Run the aggregator:

   ```bash
   node pipeline-cli/bin/cli-dor-corpus.mjs aggregate ./dor-corpus --format table
   ```

   Or for JSON output (useful when chaining with `jq` for the dispatch
   decision):

   ```bash
   node pipeline-cli/bin/cli-dor-corpus.mjs aggregate ./dor-corpus
   ```

4. Read the `recommendation` field:

   - **`safe-to-enforce`** — n ≥ minSamples, all gates have FP rate
     < `--fp-threshold` (default 10%), aggregate override rate
     < `--override-threshold` (default 5%). Dispatch AISDLC-115.9 to flip
     the config.
   - **`continue-soak`** — corpus has enough data, but at least one
     gate's FP rate or the aggregate override rate exceeds threshold.
     The `reason` field names the offending gate / metric — that's the
     next thing rubric tuning should target. Re-run after the next batch
     of activity.
   - **`insufficient-data`** — n < minSamples (default 50). Either wait
     for more activity or use the override path below.

   Tunables (rarely needed; defaults match RFC-0011 §5.5):

   - `--min-samples` — corpus-size floor (default 50)
   - `--fp-threshold` — per-gate FP-rate ceiling (default 0.10)
   - `--override-threshold` — aggregate override-rate ceiling (default 0.05)

5. Once `recommendation: safe-to-enforce` lands, dispatch AISDLC-115.9
   following its task body. The promotion is one-line YAML edit in
   `.ai-sdlc/dor-config.yaml`.

---

## Override path (when corpus is sparse but signal is clearly fine)

Use this when:

- `cli-dor-corpus` returns `insufficient-data`, AND
- The operator has separate evidence the gate isn't refusing real issues
  (e.g. they've spot-checked recent dor-ingress runs in the GitHub
  Actions UI and the comments look reasonable).

Steps:

1. **Spot-check recent `dor-ingress` workflow runs** in the GitHub
   Actions UI. Open the workflow page, scan the last ~20 runs, and
   inspect:

   - Are the `needs-clarification` verdicts hitting issues that
     legitimately needed more detail? (Good — the gate is working as
     intended.)
   - Are the `needs-clarification` verdicts hitting issues that were
     fine and the author had to push back? (Bad — that's a false
     positive; do NOT promote yet.)

   The DoR comments themselves are the artifact — they're posted to the
   issue / PR via `dor-render-comment`. `gh issue view N --comments` and
   `gh pr view N --comments` are the fastest way to scan them in bulk.

2. **Check the override rate via the UI**: how often did maintainers
   apply `dor-bypass`? If you can find ~5 examples in recent activity,
   that's already higher than the corpus-path threshold (5%) — fall back
   to corpus path or wait. If the override label is rare-or-absent
   across the runs you eyeballed, the gate isn't spuriously firing.

3. **Document the decision**: when dispatching AISDLC-115.9, include a
   short note in the PR body explaining which path was used and the
   evidence the operator looked at. The override path is the operator's
   call to make, but the audit trail is mandatory.

4. **Dispatch AISDLC-115.9** the same way as the corpus path. The flag
   flip is identical — the only difference is which evidence justified it.

---

## What happens after the flip

Once `evaluationMode: enforce` is live in `.ai-sdlc/dor-config.yaml`:

- The `/ai-sdlc execute` path REFUSES to start work on a backlog task
  whose verdict is `needs-clarification` (per
  `pipeline-cli/src/dor/ingress-claude.ts` `shouldRefuseExecution`).
- The PPA admission flow rejects `needs-clarification` issues at the
  intake layer (per RFC-0011 §7.1).
- The `dor-bypass` label remains the maintainer escape hatch (RFC §7.4)
  — that's how operator overrides get logged into the calibration corpus
  going forward.
- AISDLC-115 (parent) AC #2 + AC #3 mark complete; close the parent task.

If the flip turns out to be premature (FP rate spikes after promotion),
revert `evaluationMode: warn-only` in `.ai-sdlc/dor-config.yaml`. The
calibration log keeps accumulating in either mode; nothing on-disk needs
to be undone.

---

## References

- RFC-0011 §5.5 (calibration log + confidence model)
- RFC-0011 §10 (evaluation modes: warn-only / enforce)
- AISDLC-115.8 (Phase 7 soak — corpus-driven exit criterion)
- AISDLC-115.9 (Phase 8 — the actual flag flip)
- AISDLC-161 (this PR — wired up CI calibration data collection +
  aggregator CLI)
