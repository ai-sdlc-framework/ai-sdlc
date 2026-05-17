# Promoting the Estimation Calibration flag from `experimental` to default-on

**Audience**: AI-SDLC operators (specifically: whoever is dispatching
the RFC-0016 Phase 6 promotion step). This is the runbook for flipping
`AI_SDLC_ESTIMATION_CALIBRATION=experimental → default-on`.

**TL;DR**: promotion is corpus-driven, NOT calendar-gated (per maintainer
directive 2026-05-01). The flag can be promoted when all three criteria
below are met simultaneously.

---

## Promotion criteria (RFC §13 Phase 6 acceptance)

All three must hold **simultaneously** before the flag is promoted:

| # | Criterion | Tool | Target |
|---|---|---|---|
| 1 | **≥95% 1-bucket misses across ≥50 estimates** | `cli-estimate digest` or `cli-estimate show <class>` | `oneBucketMissRate ≥ 0.95` per class + `n ≥ 50` |
| 2 | **<5% 3-bucket misses across ≥50 estimates** | `cli-estimate digest` or `cli-estimate show <class>` | `threeBucketMissRate < 0.05` per class |
| 3 | **Stage-A-coverage >70%** | `cli-estimate show all` or `cli-estimate digest` | `stageACoverageRate > 0.70` per class |

Additionally, the class-proposal queue should be **operator-actionable**
(no stale proposals older than 30 days without a decision) before
promotion — this ensures the class taxonomy is well-maintained before the
flag influences capacity planning and Slack digests.

---

## How to check the current state

```bash
# Full digest across all classes (JSON output for scripting)
node pipeline-cli/bin/cli-estimate.mjs digest --format json

# Human-readable table
node pipeline-cli/bin/cli-estimate.mjs digest --format table

# Per-class detail with drift detection
node pipeline-cli/bin/cli-estimate.mjs show feature --check-drift --format table
node pipeline-cli/bin/cli-estimate.mjs show bug --check-drift --format table
node pipeline-cli/bin/cli-estimate.mjs show chore --check-drift --format table

# Class proposal queue
node pipeline-cli/bin/cli-estimate-classes.mjs review --format table
```

The digest's `promotionReady` field per class is `true` when all three
criteria above are satisfied for that class. Promotion proceeds when
**every active class** is `promotionReady`.

---

## Promotion paths

### Path A: Corpus path (preferred when all criteria met)

1. Verify criteria via `cli-estimate digest --format table`.
2. Confirm `promotionReady: true` for every active class.
3. Confirm the class-proposal queue is actionable
   (`cli-estimate-classes review` shows no stale proposals).
4. Open a PR that removes `AI_SDLC_ESTIMATION_CALIBRATION` from the
   explicit environment configuration (or flips the default in
   `feature-flag.ts` from `false` to `true`).
5. The PR body should link the digest output as evidence.

### Path B: Operator-override path

If the corpus is too sparse (< 50 estimates per class) but the operator
has separate evidence that calibration is working well:

1. Run `cli-estimate show all --format table` and document the output.
2. Review recent PR estimate comments to verify subjective accuracy.
3. Open the PR with an `override:` justification in the PR body
   documenting WHY the corpus-based gate can be bypassed.

---

## Post-promotion checks

After the flag flip lands on `main`:

1. Verify `cli-estimate stage-a <any-task>` still emits correct output.
2. Verify the weekly digest cron (or equivalent scheduled job) fires and
   produces a non-empty digest.
3. Monitor for `EstimateBiasOverCorrected` events in `events.jsonl`
   (indicates the bias multiplier needs re-tuning).
4. If `EstimateBiasOverCorrected` fires within 2 weeks of promotion,
   re-evaluate the bias multipliers per §7.2 before the next release.

---

## Rolling back

If promotion introduces regressions (wrong estimates causing bad
capacity-planning decisions, spurious Slack noise, etc.):

1. Set `AI_SDLC_ESTIMATION_CALIBRATION=` (empty / unset) in the
   environment. All estimation surfaces degrade-open to the "disabled"
   state — no crash, no wrong output.
2. File a follow-up task describing the regression.
3. Re-promote once the regression is fixed and criteria are re-met.

---

## Related tooling

| Tool | Purpose |
|---|---|
| `cli-estimate stage-a <task-id>` | Run Stage A signals for one task |
| `cli-estimate show <class>` | Per-class calibration stats + Stage-A-coverage |
| `cli-estimate digest` | Weekly digest across all classes |
| `cli-estimate-classes review` | List pending class proposals |
| `cli-estimate-classes promote` | Auto-promote ≥3-proposal clusters |
| `cli-estimate-classes list` | Show current class ontology |

---

## References

- RFC-0016 §13 Phase 6 acceptance criteria
- RFC-0016 §7.4 bias drift detection (`EstimateBiasOverCorrected`)
- RFC-0016 §7.3 calibration state token enum (Q6 resolution)
- `docs/operations/dor-promotion.md` — same corpus-driven pattern for the DoR gate
- `docs/operations/orchestrator-promotion.md` — same pattern for the orchestrator
