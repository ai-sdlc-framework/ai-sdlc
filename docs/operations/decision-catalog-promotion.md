# Promoting `AI_SDLC_DECISION_CATALOG` from default-OFF to default-ON

**Audience**: AI-SDLC operators (specifically: whoever is dispatching the
default-on flip PR for RFC-0035, and any operator running a downstream
adopter project who needs to mirror the flip). This is the runbook for
the final step of RFC-0035 Phase 11 — flipping the
`AI_SDLC_DECISION_CATALOG` env-var default from `off` to `on` so the
Decision Catalog (the operator's first-class decision queue per VISION.md
§3) becomes the standard behaviour.

> **Status (dogfood project, 2026-05-22):** The internal dogfood
> repository completed this promotion as AISDLC-392 — `AI_SDLC_DECISION_CATALOG`
> is **default-ON** in `main`. The runbook below is retained for two
> audiences: (a) adopter projects flipping the same default in their own
> deployment, and (b) the dogfood operator if rollback evidence ever
> surfaces (see "Rollback procedure" below). The corpus + override
> tooling continues to operate identically post-flip — the only
> difference is which evidence justified flipping.

**TL;DR**: there are two paths. Both produce the same default-on
end-state. Pick based on whether the calibration corpus is rich enough.

| Path | When to use | Tooling | Authority |
|---|---|---|---|
| **Corpus path** | Substrate corpus has ≥30 resolved entries across ≥3 task types AND `decision-recommendation` accuracy ≥ 80% | `cli-decisions corpus aggregate` | Math-rigorous; recommendation drops out of the data |
| **Override path** | Corpus is sparse OR the operator has separate evidence (TUI calibration pane / `cli-decisions exemplars digest`) the Stage C recommendations aren't surprising | Eyeball recent decisions in the pending-exemplars digest + spot-check `cli-decisions list` | Operator judgment |

---

## Background: why two paths?

Per maintainer directive 2026-05-01 (mirrors RFC-0014 §11 Phase 5 and
RFC-0015 §11 Phase 5): **calendar duration is a side-effect, not a
gate**. The promotion criteria are:

- **Stage C recommendation accuracy ≥ 80%** on the
  `decision-recommendation` substrate corpus (operator-affirmed vs
  operator-overridden, computed as `positive / (positive + negative)`
  per `cli-decisions corpus aggregate`). The 80% floor is lower than
  the RFC-0011 DoR gate's 90% because Decision Catalog recommendations
  are *advisory* — every recommendation goes into the override-window
  pattern (OQ-3 / §15.1 Design Pattern 3), so wrong recommendations
  are catch-able rather than silently load-bearing.
- **Operator override rate < 25%** in the rolling 30-day window —
  measured as `overridden / (auto-applied + operator-answered)` across
  all sources. A higher override rate means the Stage C confidence
  threshold is mis-tuned and needs `calibration-sweep` re-runs before
  flipping.
- **No outstanding anchor candidates ≥ 5** with consistent
  operator-corrected classification — that signals a class of
  decisions the calibrator hasn't internalised yet; flip after
  promoting the anchors via `cli-decisions exemplars promote-all`.
- **Promotion ladder satisfied** — see "Promotion ladder" below.

Whichever path satisfies the criteria first wins. Until the substrate
corpus accumulates enough data after Phases 5-10 ship for confident
math, the operator may use the override path (eyeball + judgment) so
the promotion isn't gated on calendar time.

The two paths produce the same end-state: the
`AI_SDLC_DECISION_CATALOG` default flips from `off` to `on` in
`pipeline-cli/src/decisions/feature-flag.ts#isDecisionCatalogEnabled`.
The only difference is which evidence justified the flip.

---

## Promotion ladder

RFC-0035 follows the standard AI-SDLC three-rung promotion ladder.
Each rung is a gate; advancing requires meeting the rung's
acceptance criteria.

| Rung | Flag value | What the framework does | Exit gate |
|---|---|---|---|
| **experimental** | `AI_SDLC_DECISION_CATALOG=experimental` (or `1`/`true`/`yes`/`on`) | Opt-in only; per-operator. `cli-decisions {list,show,add,score-a,score-c,answer,override,corpus,exemplars}` available. Stage C runs against `decision-recommendation` corpus; results write to the override window per OQ-3. No effect on operators who haven't opted in. | Phases 1-7 implementation complete + ≥10 dogfood decisions filed via `cli-decisions add`. |
| **shadow-mode** | `AI_SDLC_DECISION_CATALOG=shadow` (operator config-only; not a code branch — see below) | Same as `experimental` plus: DoR ingress (RFC-0011) **also** emits `Decision` records for every clarification round (Phase 4 surface), but the operator-facing TUI surface is still opt-in. Calibration corpus accumulates across all operators on the project. | Substrate corpus ≥ 30 entries across ≥ 3 task types; Stage C `decision-recommendation` accuracy ≥ 80% in `cli-decisions corpus aggregate`. |
| **default-on** | `AI_SDLC_DECISION_CATALOG` unset OR any non-falsy value | Default behaviour. All decision surfaces (TUI, digest, override window, calibration sweep) active by default. Opt out via `AI_SDLC_DECISION_CATALOG=off` (or `0`/`false`/`no`/`disabled`). | n/a — terminal state. |

> **Shadow-mode is a configuration convention, not a separate code
> path.** Internally the parser is binary (on / off). "Shadow-mode" is
> operator shorthand for the phase where the flag is on AND DoR
> ingress is wired to emit Decisions AND the TUI surface is still
> opt-in (because RFC-0023 Phase 1 hasn't shipped on the operator's
> deployment). Adopters running newer pipeline-cli versions where the
> TUI pane has shipped move from `experimental` directly to
> `default-on`.

The dogfood project promoted via:
**experimental** (AISDLC-285, 2026-05-11) →
**shadow-mode** (AISDLC-289, 2026-05-15, when Phase 4 DoR-bridge landed) →
**default-on** (AISDLC-392, 2026-05-22, after the override path was
exercised; corpus was insufficient-data at flip time).

---

## Corpus path (preferred when substrate corpus ≥ 30)

### 1. Run the aggregator

The substrate corpus lives at `<repoRoot>/.ai-sdlc/classifier-corpus/`
(one YAML per task type: `capture-triage`, `capture-severity`,
`pr-comment-is-capture`, `dor-answer-is-new-concern`,
`decision-recommendation`). The aggregator reads all five and emits
per-task + cross-task metrics + anchor candidates.

```bash
node pipeline-cli/bin/cli-decisions.mjs corpus aggregate --format text
```

Or for JSON output (useful when chaining with `jq` for the dispatch
decision):

```bash
node pipeline-cli/bin/cli-decisions.mjs corpus aggregate --format json
```

The aggregator does NOT consume external `.jsonl` artifacts the way
`cli-deps-corpus` does — the substrate is the source of truth and is
write-shared across all framework surfaces. There is no separate
`gh run download` step.

### 2. Read the metrics

The `decision-recommendation` row is the load-bearing signal for
this promotion:

```
per-task-type:
  decision-recommendation        total=42  pos=36  neg=5  pending=1  accuracy=0.878  coverage=0.976  avgConf=0.812
```

Promote when:

- `total ≥ 30` for `decision-recommendation` (rung-2 → rung-3 gate),
- `accuracy ≥ 0.80` for `decision-recommendation`,
- Cross-task `aggregate.coverage ≥ 0.90` (the override window has
  settled on most entries; un-settled entries make the accuracy
  number noisy).

`anchor candidates` should be **empty or already promoted** before
flipping — anchor candidates are clusters of consistent operator
overrides that the calibrator hasn't internalised yet. Promote them
first (see "Override path" §3 below for the promote-all command),
then re-run `corpus aggregate` and confirm the count drops.

### 3. Run the calibration sweep

After confirming the metrics, regenerate the pending-exemplars file
from the latest substrate state so the next promotion batch
incorporates everything that has settled since the last sweep:

```bash
node pipeline-cli/bin/cli-decisions.mjs exemplars sweep --format text
```

This mirrors substrate negative-polarity entries into
`.ai-sdlc/pending-exemplars.yaml`. The flag-flip PR should
include the post-sweep diff so reviewers see the calibration state
at flip time.

### 4. Dispatch the flag flip

Once accuracy + coverage gates land green, follow "The flag flip"
section below. Include the `cli-decisions corpus aggregate` JSON
envelope + the last `exemplars sweep` output in the PR body as the
audit trail.

---

## Override path (when corpus is sparse but signal is clearly fine)

Use this when:

- `cli-decisions corpus aggregate` returns sparse data
  (`decision-recommendation.total < 30`), AND
- The operator has separate evidence the catalog isn't surprising
  (e.g. they've spot-checked recent `cli-decisions list` output and
  the Stage C recommendations + operator overrides have been
  reasonable).

### Steps

1. **List decisions and eyeball routing/recommendations**:

   ```bash
   AI_SDLC_DECISION_CATALOG=experimental \
     node pipeline-cli/bin/cli-decisions.mjs list --format table
   ```

   - Are the open decisions assigned to plausible actors? (Good — the
     §6 routing rubric is matching pillar intent.)
   - For answered decisions, did the operator pick the framework's
     recommendation in most cases? Pick a few and run:

     ```bash
     node pipeline-cli/bin/cli-decisions.mjs show DEC-NNNN --format text
     ```

     Look at the `Stage A/B/C audit` section. Is the recommendation's
     rationale defensible in hindsight? (Good — Stage C is calibrated.)
   - Are there frequent operator overrides of the recommendation? Trace
     the rationale in the override event. If it's clear ("Stage C
     missed that this decision blocks a one-way migration"), that's a
     calibration signal — file it via `exemplars sweep` so the next
     promotion batch internalises it.

2. **Review the pending-exemplars digest** (the ground-truth signal):

   ```bash
   node pipeline-cli/bin/cli-decisions.mjs exemplars digest \
     --window-days 14 --format markdown
   ```

   The digest shows: count of new pending exemplars in the window,
   per-task-type breakdown, oldest unhandled exemplars. If the
   operator has been processing them (affirming / reclassifying /
   rejecting via `cli-decisions exemplars {affirm,reclassify,reject}
   <id>`), the calibration loop is healthy enough to flip even without
   corpus depth.

3. **Spot-check the override rate**:

   ```bash
   # Approximate from the corpus: negatives are operator overrides.
   node pipeline-cli/bin/cli-decisions.mjs corpus aggregate --format json \
     | jq '.perTaskType[] | select(.taskType == "decision-recommendation") | { neg, total, overrideRate: (.negative / .total) }'
   ```

   An override rate < 25% with ≥ 5 settled entries is enough operator
   judgment to advance from `shadow-mode` to `default-on`.

4. **Document the decision**: when dispatching the flag-flip PR,
   include a short note in the PR body explaining which path was used
   and the evidence the operator looked at. The override path is the
   operator's call to make, but the audit trail is mandatory — every
   override flip is logged as part of the post-flip `Decision`
   stream so future calibration runs can find the precedent.

5. **Dispatch the flag flip** the same way as the corpus path. The
   flip is identical — the only difference is which evidence
   justified it.

---

## The flag flip

The `AI_SDLC_DECISION_CATALOG` default is currently **ON** in the
dogfood project (AISDLC-392). For adopter projects on older
pipeline-cli versions, the flag parser lives in
`pipeline-cli/src/decisions/feature-flag.ts` (`isDecisionCatalogEnabled`)
and follows the canonical default-on opt-out semantics
(`off`/`0`/`false`/`no`/`disabled` case-insensitive falsy). To flip
the default to ON in a deployment where the default is still OFF,
choose the surface appropriate to your deployment:

### Option A — flip the default in the parser (single-PR flip)

Edit `pipeline-cli/src/decisions/feature-flag.ts#isDecisionCatalogEnabled`
so the flag defaults to ON when unset, and operators opt OUT via
`AI_SDLC_DECISION_CATALOG=off`. This is the cleanest "default-on"
flip but inverts the parser's polarity — every consumer that branches
on the flag value should be reviewed in the same PR.

A reference diff (this is the diff that landed in AISDLC-392; do NOT
apply blindly — review every caller first):

```diff
-const TRUTHY = new Set(['experimental', '1', 'true', 'yes', 'on']);
-export function isDecisionCatalogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
-  const raw = env[DECISION_CATALOG_FLAG];
-  if (!raw) return false;
-  return TRUTHY.has(raw.trim().toLowerCase());
-}
+const FALSY = new Set(['off', '0', 'false', 'no', 'disabled']);
+export function isDecisionCatalogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
+  const raw = env[DECISION_CATALOG_FLAG];
+  // Default-on: unset OR empty OR any non-falsy value → enabled.
+  if (!raw) return true;
+  return !FALSY.has(raw.trim().toLowerCase());
+}
```

### Option B — set the env in the orchestrator entrypoint

Add `AI_SDLC_DECISION_CATALOG=experimental` to the env block of
every workflow / systemd unit / Docker container that runs the
pipeline — leaves the parser's default OFF and lets local operators
opt out by running with the env unset. Less invasive but doesn't
propagate to operator shells.

The corpus-path PR should pick Option A (true default-on); the
override path may pick either depending on confidence. **Both produce
the same operator UX**: `cli-decisions` accepts mutating subcommands
(`add`, `answer`, `override`), DoR ingress writes Decision records,
the override window auto-applies reversible Stage C recommendations,
and the calibration sweep runs against the populated substrate.

After the flip lands, update:

- `CLAUDE.md` — change the "Off by default" line in the
  `AI_SDLC_DECISION_CATALOG` bullet to "On by default; set
  `AI_SDLC_DECISION_CATALOG=off` to disable." (the dogfood
  `CLAUDE.md` already reflects this since AISDLC-392).
- `pipeline-cli/docs/decisions.md` (if shipped) — flip the "Phase 1
  ships behind a feature flag" framing to "Phase 1+ are on by default;
  opt-out via `AI_SDLC_DECISION_CATALOG=off`".
- AISDLC-285 (parent) — close ACs related to "flag promoted",
  "framework default-on", "promotion runbook extended".

---

## Logging an override (operator workflow)

When the operator overrides a Stage C recommendation, the override is
captured automatically — both during the 24h override window (`override`
event emitted to the event log; substrate corpus gains a negative
polarity entry) and via explicit operator action:

```bash
# Explicit override after the override window has closed (issues a
# `superseded` event):
node pipeline-cli/bin/cli-decisions.mjs override DEC-NNNN opt-b \
  --rationale "Stage C missed that opt-a requires a one-way migration"
```

The CLI:

- Refuses if the decision is not in `answered` state.
- Refuses if `optionId` doesn't exist in the decision body.
- Writes a `overridden` event with the rationale to
  `.ai-sdlc/_decisions/events.jsonl` and (per OQ-11 / §15.1 Design
  Pattern 4) appends a negative-polarity corpus entry for the
  `decision-recommendation` task type.

The next `cli-decisions exemplars sweep` mirrors the negative entry
into `pending-exemplars.yaml`, where the operator handles it via
`affirm` / `reclassify` / `reject` (or `promote-all` after a batch
sweep).

---

## What happens after the flip

Once `AI_SDLC_DECISION_CATALOG` is ON by default:

- `cli-decisions add` accepts new Decision records without an env
  override. Set `AI_SDLC_DECISION_CATALOG=off` locally to revert and
  refuse mutating subcommands.
- DoR ingress (RFC-0011) writes `Decision` records for every
  clarification round; the catalog projection includes them in
  `cli-decisions list` automatically.
- Stage C reversible recommendations auto-apply with the 24h
  operator-override window per OQ-3 (the Linear AI / Datadog
  auto-grouping pattern). Override silently is acceptance signal;
  override explicitly is calibration signal.
- The pending-exemplars digest (`cli-decisions exemplars digest`)
  becomes a routine operator review surface. Plan ~5 minutes/week to
  triage the digest into affirm/reclassify/reject dispositions; the
  digest is designed to fit one operator-attention window.
- Future TUI surfaces (RFC-0023 Phase 9 calibration pane, RFC-0033
  governance reporting) consume the substrate corpus directly.

### Rollback procedure

The flag is designed to be a single-line revert. Rollback is the
mirror of the flip:

```bash
# Option A rollback — re-flip the parser default to OFF.
git revert <flag-flip-sha>
git push origin HEAD --force-with-lease  # only on a feature branch
```

```bash
# Option B rollback — remove the env from the workflow/unit file.
# (No code change; the workflow re-runs with the new env block.)
```

For a no-code-change emergency disable while the rollback PR is
in review, every operator can set `AI_SDLC_DECISION_CATALOG=off` in
their own shell — the parser respects the opt-out immediately. The
event log + substrate corpus keep accumulating regardless of mode
when an operator opts back in; nothing on-disk needs to be undone.

### What "rollback evidence" looks like

The dogfood project's promotion criteria (above) are also the
rollback triggers — observe them inverted:

- **Recommendation accuracy drops below 70%** sustained for ≥ 14
  days. Re-run `corpus aggregate`; if the slip is real (not a
  one-week outlier), revert and re-tune Stage C confidence
  thresholds via `calibration-sweep` before re-flipping.
- **Operator override rate climbs above 40%** in the rolling 30-day
  window. Same response — usually means the Stage C confidence
  threshold needs to move from 0.65 to 0.75 or the
  `decision-principles.md` file needs an anchor batch.
- **Anchor candidates pile up** without operator triage. Sometimes
  this indicates the digest cadence is wrong (operator can't keep
  up); sometimes it indicates the calibrator is mis-classifying.
  Investigate via `exemplars list --disposition pending --format
  table`.

---

## Monitoring after the flip

The dogfood project monitors decision-catalog health via three
periodic checks:

### Weekly: pending-exemplars digest

```bash
node pipeline-cli/bin/cli-decisions.mjs exemplars digest --window-days 7
```

Operator allocates ~5 minutes/week to triage. Goal: the
`oldestPendingDays` field stays below 14 — exemplars that age out
past 14 days are calibration signals the framework is missing.

### Bi-weekly: corpus aggregate

```bash
node pipeline-cli/bin/cli-decisions.mjs corpus aggregate --format text
```

Watch for:

- `decision-recommendation` accuracy drift below 80% (rollback
  trigger).
- Anchor candidate count rising — promote with
  `cli-decisions exemplars promote-all` after operator review.
- Coverage falling below 0.85 — substrate is generating decisions
  faster than the override window can settle; tune
  `overrideWindowHours` in `.ai-sdlc/decisions-config.yaml` if this
  persists.

### Quarterly: rubric calibration sweep

```bash
node pipeline-cli/bin/cli-decisions.mjs exemplars sweep
node pipeline-cli/bin/cli-decisions.mjs exemplars promote-all
```

The sweep refreshes pending-exemplars from substrate; `promote-all`
batches dispositions into `decision-exemplars.yaml`. Run this after
every batch of operator triage so the next Stage C call anchors on
the latest exemplar set.

---

## Adopter-facing example walkthrough

For an adopter project (e.g. a sibling repo using AI-SDLC where the
operator wants to enable the Decision Catalog without waiting for
their own dogfood corpus), the recommended walkthrough is the
override path:

### Day 0 — flip to `experimental`

```bash
# In every operator shell + CI workflow:
export AI_SDLC_DECISION_CATALOG=experimental

# Verify the CLI is live:
node node_modules/@ai-sdlc/pipeline-cli/bin/cli-decisions.mjs list
# → "(no decisions yet)" — empty event log, but the command works.
```

### Day 1-7 — accumulate a handful of decisions

Whenever the operator (or framework) hits a question that would
normally turn into "let me think about this and get back to you", file
it as a Decision:

```bash
node node_modules/@ai-sdlc/pipeline-cli/bin/cli-decisions.mjs add \
  --summary "Adopt Slack digest cadence: daily or weekly?" \
  --scope "operations" \
  --option "daily:every morning at 9am" \
  --option "weekly:Friday afternoon summary"
```

Run `cli-decisions list` to see the queue grow. The framework runs
Stage A (deterministic priority + routing) automatically; Stage B/C
fire when the operator runs `cli-decisions score-c <id>`.

### Day 7-14 — exercise the override window

For decisions where the operator agreed with the Stage C
recommendation, do nothing — silence within 24h is acceptance.
For decisions where the operator disagreed:

```bash
node node_modules/@ai-sdlc/pipeline-cli/bin/cli-decisions.mjs override \
  DEC-0003 daily \
  --rationale "Weekly digest loses signal on incident weeks"
```

Each override is a negative-polarity corpus entry. The sweep + digest
loop accumulates the signal.

### Day 14 — review the digest

```bash
node node_modules/@ai-sdlc/pipeline-cli/bin/cli-decisions.mjs exemplars digest \
  --window-days 14
```

Triage the pending exemplars:

```bash
node node_modules/@ai-sdlc/pipeline-cli/bin/cli-decisions.mjs exemplars affirm EX-0001
node node_modules/@ai-sdlc/pipeline-cli/bin/cli-decisions.mjs exemplars reclassify EX-0002 \
  --classification "weekly" --rationale "operator pattern is weekly"
node node_modules/@ai-sdlc/pipeline-cli/bin/cli-decisions.mjs exemplars reject EX-0003 \
  --rationale "one-off; not a calibration signal"
```

### Day 21 — promote to `shadow-mode` (or directly to `default-on`)

If your DoR ingress (RFC-0011) is wired and you want every
clarification round to also produce a Decision record, you're
effectively in shadow-mode already. If the corpus has settled enough
to satisfy the override path (≥ 5 settled `decision-recommendation`
entries, override rate < 25%), dispatch the flag flip:

```bash
# Option B (the simpler adopter path): set the env globally in your
# orchestrator entrypoint instead of editing the parser.
echo 'AI_SDLC_DECISION_CATALOG=experimental' >> .ai-sdlc/env
# Then ensure every CI workflow + operator shell sources that file.
```

Or follow Option A and submit a PR to flip the parser default in your
fork. Adopters using `@ai-sdlc/pipeline-cli` from npm should pin a
version where the flag is already default-on and remove their explicit
`AI_SDLC_DECISION_CATALOG=experimental` overrides.

### Day 30+ — monitor

Run the weekly digest + bi-weekly corpus aggregate cadence from the
"Monitoring after the flip" section above. Plan ~10 minutes/week of
operator attention; this is the steady-state cost of the catalog.

---

## Verification

After the flip lands, verify:

```bash
# Default-on: cli-decisions add works without an explicit env override.
node pipeline-cli/bin/cli-decisions.mjs add \
  --summary "Promotion-verification decision (delete after flip)" \
  --scope "ops" \
  --option "a:placeholder" \
  --option "b:placeholder"
# Should print the new DEC-NNNN id.

# List confirms the decision is in the event log.
node pipeline-cli/bin/cli-decisions.mjs list --format table

# Opt-out path still works.
AI_SDLC_DECISION_CATALOG=off node pipeline-cli/bin/cli-decisions.mjs add \
  --summary "Should refuse" --scope "ops" \
  --option "a:nope" --option "b:nope"
# Should fail with [cli-decisions] error and a message about the flag
# being set to a falsy value.

# Opt-out read path degrades open.
AI_SDLC_DECISION_CATALOG=off node pipeline-cli/bin/cli-decisions.mjs list
# Should print the disabled-message to stderr and "(decision catalog
# feature flag is off — no decisions)" to stdout.
```

Then file one real operator decision through the catalog and confirm
the Stage A → B → C ladder produces a sensible recommendation. Don't
forget to delete the placeholder decision created above (use
`cli-decisions answer DEC-NNNN <option>` to close it).

---

## References

- RFC-0035 §14 Phase 11 (this runbook is the Phase 11 deliverable)
- RFC-0035 §15 OQ-3 (auto-apply + override window — the post-flip UX)
- RFC-0035 §15 OQ-11 (override-driven exemplar promotion — the
  calibration substrate this runbook monitors)
- RFC-0035 §15.1 Design Pattern 3 (auto-apply with override window)
- RFC-0035 §15.1 Design Pattern 4 (single shared LLM classifier corpus)
- RFC-0035 §15.1 Design Pattern 8 (deterministic-first → LLM
  last-resort → operator with timebox)
- AISDLC-285 (Phase 1 — schema + cli-decisions Phase 1 router)
- AISDLC-289 (Phase 4-5 — DoR bridge + corpus aggregator)
- AISDLC-392 (the default-on flip in the dogfood project; 2026-05-22)
- AISDLC-295 (this runbook)
- [`docs/operations/deps-composition-promotion.md`](deps-composition-promotion.md) —
  sister promotion runbook for RFC-0014's
  `AI_SDLC_DEPS_COMPOSITION` flip; same hybrid-corpus-OR-override
  structure
- [`docs/operations/orchestrator-promotion.md`](orchestrator-promotion.md) —
  sister promotion runbook for RFC-0015's
  `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` flip; same hybrid structure
- [`docs/operations/dor-promotion.md`](dor-promotion.md) — sister
  promotion runbook for RFC-0011 DoR `evaluationMode: warn-only →
  enforce` flip; corpus-or-override pattern this RFC adopted
