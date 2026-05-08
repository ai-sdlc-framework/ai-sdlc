# Promoting `AI_SDLC_TUI` from default-OFF to default-ON

**Audience**: AI-SDLC operators (specifically: whoever is dispatching the
final flag-flip PR for RFC-0023). This is the runbook for the final
step of RFC-0023 Phase 7 — flipping the `AI_SDLC_TUI` env-var default
from `off` to `on` so the operator TUI becomes the standard surface
for monitoring + steering the autonomous pipeline.

**TL;DR**: there are two paths. Both produce the same default-on
end-state. Pick based on whether the soak corpus is rich enough for
math.

| Path | When to use | Tooling | Authority |
|---|---|---|---|
| **Corpus path** | `_tui/events.jsonl` + `_operator/interactions.jsonl` corpora satisfy ≥7 sessions across ≥7 calendar days with ≥2 distinct panes opened and zero `TuiCrashed` events | `cli-tui-corpus aggregate` | Math-rigorous; recommendation drops out of the data |
| **Override path** | Corpus is sparse OR the operator has separate evidence (Phase 6 analytics pane spot-check, manual review of `_tui/events.jsonl`, qualitative dogfood notes) the surface is healthy | Eyeball `_tui/events.jsonl` + analytics pane in the live TUI | Operator judgment |

---

## Background: why two paths?

Per maintainer directive 2026-05-01 (mirrored in
`docs/operations/orchestrator-promotion.md`,
`docs/operations/deps-composition-promotion.md`,
`docs/operations/dor-promotion.md`): **calendar duration is a
side-effect, not a gate**. The promotion criteria for RFC-0023 Phase 7
are:

- **Sessions ≥ 7** — operator launched the TUI on at least seven
  occasions across the soak window. The signal is `TuiStarted` event
  count on `_tui/events.jsonl`; older corpora that predate the Phase 7
  self-events writer fall back to the `pane-opened` count on
  `_operator/interactions.jsonl`.
- **Days-with-usage ≥ 7** — RFC-0023 §13 acceptance criterion #4 ("≥7
  calendar days of dogfood"). Computed from distinct UTC dates across
  both the self-events stream and the interactions stream — a single
  multi-session burst on day 1 does NOT satisfy this gate.
- **Distinct panes opened ≥ 2** — operator exercised the surface
  beyond the overview screen. A single-pane corpus implies the operator
  never mode-switched, which signals the surface isn't being used as
  designed and is worth investigating before promotion.
- **`TuiCrashed` count == 0** — RFC §13 hard gate. Any uncaught
  exception that propagated out of the Ink render loop is a
  promotion-blocking quality regression. Investigate the crash payload
  in `_tui/events.jsonl` (`errorMessage`, `stack`) before re-running
  the aggregator.

Whichever path satisfies the criteria first wins. Until the corpus
accumulates enough data after Phase 1-6 ship for confident math, the
operator may use the override path (eyeball + judgment) so the
promotion isn't gated on calendar time.

The two paths produce the same end-state: the `AI_SDLC_TUI` default
flips from `off` to `on` in the appropriate config file (see "The flag
flip" below). The only difference is which evidence justified the flip.

### Soft signals (surfaced but not gated)

The aggregator computes two additional metrics for operator visibility
that do NOT block the recommendation:

- **Time-to-decision trend** — splits the `decisions.jsonl` corpus in
  half by chronological order, compares median `durationMs` of each
  half, reports the delta. A negative delta (faster decisions in the
  newer half) is the qualitative success signal RFC-0023 §1 names
  ("operator throughput improvement"); a positive delta is worth
  investigating but does not block promotion (a week's data is too
  small for statistical confidence on the move).
- **Captures filed during the soak** — count of RFC-0024 capture
  records under `<corpus>/_captures/` whose `timestamp` falls in the
  soak window. A high count is a healthy sign (operator is using the
  capture pattern to record pain points instead of forgetting them);
  zero captures over a 7-day soak is worth a quick "why?" before
  promoting.

Both surface in the JSON envelope for inclusion in the promotion-PR
audit trail; neither alters the recommendation field.

---

## Corpus path (preferred when ≥7 sessions across ≥7 days)

### 1. Collect corpus artifacts

The Phase 6 + Phase 7 writers emit append-only JSONL artifacts under
`$ARTIFACTS_DIR/`:

- `$ARTIFACTS_DIR/_tui/events.jsonl` — `TuiStarted`, `TuiCrashed`
  events written by the cli-tui process itself (Phase 7).
- `$ARTIFACTS_DIR/_operator/interactions.jsonl` — pane-opened,
  drill-down, refresh, search events written by the mode router
  (Phase 6).
- `$ARTIFACTS_DIR/_operator/decisions.jsonl` — `Needs Clarification →
  resolved` transitions written by the decisions tracker (Phase 6).
- `$ARTIFACTS_DIR/_captures/<id>.{json,jsonl}` — RFC-0024 capture
  records (when the `cli-capture` workflow is in use).

The aggregator walks the input root and discovers each subdir
automatically. The conventional path is `./artifacts/` when
`$ARTIFACTS_DIR` isn't set. To collect a single-operator local corpus:

```bash
mkdir -p ./tui-corpus
cp -r ./artifacts/_tui      ./tui-corpus/ 2>/dev/null || true
cp -r ./artifacts/_operator ./tui-corpus/ 2>/dev/null || true
cp -r ./artifacts/_captures ./tui-corpus/ 2>/dev/null || true
```

Multi-operator corpora (e.g. when adopters share dogfood data with
maintainers) follow the `gh run download` layout — each operator's
artifact bundle lands in its own subdirectory and the aggregator
recurses into the root and globs every relevant file automatically.

### 2. Run the aggregator

```bash
node pipeline-cli/bin/cli-tui-corpus.mjs aggregate ./tui-corpus --format table
```

Or for JSON output (useful when chaining with `jq` for the dispatch
decision):

```bash
node pipeline-cli/bin/cli-tui-corpus.mjs aggregate ./tui-corpus
```

### 3. Read the `recommendation` field

- **`safe-to-promote`** — `sessions ≥ minSessions`, `daysWithUsage ≥
  minDaysWithUsage`, `distinctPanes ≥ minDistinctPanes`, AND
  `tuiCrashedCount === 0`. Dispatch the flag flip (see "The flag flip"
  below).
- **`continue-soak`** — corpus has enough data, but at least one of
  the gates above failed. The `reason` field names the failing
  metric — that's the next thing to tune (or wait on more data).
  - **TuiCrashed count > 0** → investigate the crash payload in
    `_tui/events.jsonl`. Open a fix-PR (or a Phase-7-equivalent
    follow-on task) before re-running the aggregator. Crashes are the
    promotion's hard gate; they MUST be addressed.
  - **distinctPanes too low** → the operator hasn't exercised enough
    of the surface. Continue dogfooding with intentional mode
    coverage (Blockers, PRs, Deps, Config, Analytics) for another
    week, then re-run.
- **`insufficient-data`** — `sessions < minSessions` OR
  `daysWithUsage < minDaysWithUsage`. Either keep the soak running for
  more days/sessions or use the override path below.

Tunables (rarely needed; defaults match RFC-0023 §13 Phase 7):

- `--min-sessions` — session count floor (default 7)
- `--min-days-with-usage` — distinct-UTC-date floor (default 7)
- `--min-distinct-panes` — distinct-panes-opened floor (default 2)

### 4. Dispatch the flag flip

Once `recommendation: safe-to-promote` lands, follow "The flag flip"
section below. Include the `cli-tui-corpus aggregate` JSON envelope in
the PR body as the audit trail.

---

## Override path (when corpus is sparse but signal is clearly fine)

Use this when:

- `cli-tui-corpus` returns `insufficient-data`, AND
- The operator has separate evidence the TUI is healthy (e.g. they've
  spot-checked the Analytics pane for the last week's decisions, the
  Blockers pane surfaces what they expect, mode-switching feels
  responsive, no crashes observed during the dogfood).

### Steps

1. **Spot-check `_tui/events.jsonl`** for crashes:

   ```bash
   grep '"TuiCrashed"' artifacts/_tui/events.jsonl || echo 'no crashes — good'
   ```

   Any matches are promotion blockers — investigate the `errorMessage`
   and `stack` fields, fix the underlying issue, and re-run the soak
   before considering the flip. The override path does NOT bypass the
   zero-crash gate.

2. **Spot-check the analytics pane** in the live TUI:

   ```bash
   AI_SDLC_TUI=experimental pnpm tui
   # Press 'a' to open the Analytics pane full-screen.
   ```

   - Are operator decisions resolving in reasonable wall-clock time?
   - Is the time-to-decision trend stable or improving over the soak
     window?
   - Are the pane-open counts roughly balanced across the surfaces
     you've actually used? (A pane you intended to use but show 0 opens
     for is a signal the keystroke or surface isn't discoverable.)

3. **Spot-check mode-switching latency** by hand:

   ```bash
   AI_SDLC_TUI=experimental pnpm tui
   # Cycle b → p → d → c → a → Esc → q. Each transition should feel instant.
   ```

   Visible lag (>500ms) on any transition warrants investigation
   before promotion — the surface's responsiveness is the operator
   experience contract.

4. **Document the decision**: when dispatching the flag-flip PR,
   include a short note in the PR body explaining which path was used
   and the evidence the operator looked at. The override path is the
   operator's call to make, but the audit trail is mandatory.

5. **Dispatch the flag flip** the same way as the corpus path. The
   flip is identical — the only difference is which evidence justified
   it.

---

## The flag flip

The `AI_SDLC_TUI` default is currently OFF. The flag parser lives in
`pipeline-cli/src/tui/feature-flag.ts` (`isTuiEnabled`) and follows the
canonical opt-in semantics (`experimental` plus the standard
`1`/`true`/`yes`/`on` case-insensitive). To flip the default to ON,
choose the surface appropriate to your deployment:

### Option A — flip the default in the parser (single-PR flip)

Edit `pipeline-cli/src/tui/feature-flag.ts#isTuiEnabled` so the flag
defaults to ON when unset, and operators opt OUT via `AI_SDLC_TUI=off`.
This is the cleanest "default-on" flip but inverts the parser's
polarity — every consumer that branches on the flag value (currently
`pipeline-cli/src/tui/index.ts#runTui`) should be reviewed in the same
PR.

A mechanical reference diff (do NOT apply blindly — review every
caller first):

```diff
-const TRUTHY = new Set(['experimental', '1', 'true', 'yes', 'on']);
-
-export function isTuiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
-  const raw = env[TUI_FLAG];
-  if (!raw) return false;
-  return TRUTHY.has(raw.trim().toLowerCase());
-}
+const FALSY = new Set(['off', '0', 'false', 'no']);
+
+export function isTuiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
+  const raw = env[TUI_FLAG];
+  if (!raw) return true; // default-on after RFC-0023 §13 Phase 7 promotion
+  return !FALSY.has(raw.trim().toLowerCase());
+}
```

After flipping the parser, also update the `tuiDisabledMessage()`
return string — the "Set AI_SDLC_TUI=experimental to opt in" hint no
longer applies; the message should explain the opt-out path instead.

### Option B — set the env in the launcher

Add `AI_SDLC_TUI=experimental` to the env block of every script /
shell-rc / containerised launcher that opens the TUI — leaves the
parser's default OFF and lets local operators opt out by running with
the env unset. Less invasive but doesn't propagate to operator shells
unless every launcher cooperates. The `pnpm tui` shortcut in
`package.json` is the obvious surface to bake the env into; other
operator workflows may wrap `cli-tui` in their own scripts and need
parallel updates.

The corpus-path PR should pick Option A (true default-on); the
override path may pick either depending on confidence. **Both produce
the same operator UX**: launching `cli-tui` (or `pnpm tui`) drops the
operator into Overview Mode; the events.jsonl + interactions.jsonl
streams continue to accumulate; nothing changes in the read-mostly
contract.

After the flip lands, update:

- `CLAUDE.md` — change the "Off by default" line for `AI_SDLC_TUI`
  (when added) to reflect the new default.
- `pipeline-cli/src/tui/feature-flag.ts` — update the JSDoc comment to
  note the post-promotion polarity.
- `spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md` — append a
  v1.0 entry to the revision history documenting the promotion date,
  the corpus-or-override path used, and the recommendation envelope.
- `docs/operations/operator-runbook.md` — change "Set
  `AI_SDLC_TUI=experimental` to opt in" to "Set `AI_SDLC_TUI=off` to
  disable" in the TUI usage section.
- AISDLC-178 (parent RFC-0023 task) — close on the umbrella once the
  flip lands.

---

## What happens after the flip

Once `AI_SDLC_TUI` is ON by default:

- Operators who run `cli-tui` (or `pnpm tui`) get the full surface
  without setting an env. Set `AI_SDLC_TUI=off` locally to revert.
- The orchestrator + DoR + dep composition behaviours are unchanged —
  the TUI is a pure observability surface that consumes their output
  (per RFC-0023 §16 Product Authority review). No per-event
  behaviour shift.
- The `_tui/events.jsonl` + `_operator/interactions.jsonl` +
  `_operator/decisions.jsonl` streams continue to accumulate; nothing
  on-disk needs to be undone.
- The opt-OUT for telemetry (`AI_SDLC_TUI_TELEMETRY=off`, RFC §10
  OQ-8) keeps working unchanged. The TUI default-on flip does NOT
  change the telemetry hard line.

If the flip turns out to be premature (operator usage drops, a
regression in mode-switching surfaces, a delayed `TuiCrashed` lands),
revert the parser change (Option A) or remove the env override
(Option B) in a single-line PR. The events.jsonl + interactions.jsonl
artifacts keep accumulating regardless of mode; the next corpus
aggregation will reflect the regression.

### Rollback procedure

The flag is designed to be a single-line revert. Rollback is the
mirror of the flip:

```bash
# Option A rollback — re-flip the parser default to OFF.
git revert <flag-flip-sha>
git push origin HEAD --force-with-lease  # only on a feature branch
```

```bash
# Option B rollback — remove the env from the launcher / pnpm script.
# (No code change beyond removing the env block; the next launch picks
# up the new default OFF.)
```

The events stream + interactions stream + decisions stream keep
flowing through the rollback — nothing is lost, and the next corpus
aggregation will show the regression that justified the rollback.

---

## References

- RFC-0023 §13 Phase 7 (corpus-driven exit criteria + acceptance
  criteria #1-#6)
- RFC-0023 §12 (`_tui/events.jsonl` self-observability stream;
  `TuiCrashed` is the hard gate)
- RFC-0023 §10 + OQ-8 (`_operator/interactions.jsonl` writer + opt-OUT
  contract)
- RFC-0024 (emergent issue capture — captures-during-soak signal)
- AISDLC-178.7 (this PR — corpus aggregator + chaos-test parity +
  this runbook)
- AISDLC-178.6 (Phase 6 — analytics pane + interactions writer)
- [`pipeline-cli/src/cli/tui-corpus.ts`](../../pipeline-cli/src/cli/tui-corpus.ts) — aggregator CLI surface
- [`pipeline-cli/src/tui/corpus/aggregate.ts`](../../pipeline-cli/src/tui/corpus/aggregate.ts) — recommendation logic
- [`docs/operations/orchestrator-promotion.md`](orchestrator-promotion.md) — sister
  promotion runbook for RFC-0015's `AI_SDLC_AUTONOMOUS_ORCHESTRATOR`
  flip; same hybrid-corpus-OR-override structure
- [`docs/operations/deps-composition-promotion.md`](deps-composition-promotion.md) — sister
  promotion runbook for RFC-0014's `AI_SDLC_DEPS_COMPOSITION` flip
- [`docs/operations/dor-promotion.md`](dor-promotion.md) — sister
  promotion runbook for RFC-0011 DoR `enforce` flip
