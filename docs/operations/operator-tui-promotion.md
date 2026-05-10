# Promoting `AI_SDLC_TUI` from default-OFF to default-ON

**Audience**: AI-SDLC operators (specifically: whoever is dispatching the
final flag-flip PR for RFC-0023). This is the runbook for the final step
of RFC-0023 Phase 7 — flipping the `AI_SDLC_TUI` env-var default from
`off` (experimental opt-in) to `on` so the operator TUI becomes the
standard monitoring interface.

**TL;DR**: there are two paths. Both produce the same default-on
end-state. Pick based on whether the TUI soak corpus is rich enough for
math.

| Path | When to use | Tooling | Authority |
|---|---|---|---|
| **Corpus path** | TUI usage corpus has ≥ 100 sessions across ≥ 7 distinct calendar days | `cli-tui-corpus aggregate` | Math-rigorous; recommendation drops out of the data |
| **Override path** | Corpus is sparse OR operator has separate evidence (spot-check of `$ARTIFACTS_DIR/_tui/events.jsonl`) the TUI is stable | Eyeball recent sessions + pane-open patterns manually | Operator judgment |

**Hard gate (both paths)**: `TuiCrashed` count MUST be 0. If ANY crash
event is present in the soak window, promotion is blocked regardless of
which path you use. Fix and re-soak before promoting.

---

## Background: why two paths?

Per maintainer directive 2026-05-01 (RFC-0023 §13 Phase 7): **calendar
duration is a side-effect, not a gate**. The promotion criteria are:

- **TuiCrashed = 0** — zero crash events in the entire soak corpus
  (hard gate; single-crash veto regardless of session count)
- **≥ 100 sessions over ≥ 7 calendar days** — sufficient operational
  exposure before defaulting on for every adopter
- **Pane-engagement rate ≥ 50%** — at least half of sessions opened
  a non-overview pane, confirming operators are actively navigating
  (not just glancing at the TUI once and closing it)

The `captures-filed-during-soak` count is captured as a telemetry
signal (via RFC-0024 emergent capture pattern) but does NOT gate
promotion — it is informational context for the PR body.

Whichever path satisfies the criteria first wins. Until the soak corpus
accumulates enough data after Phases 1-6 ship, the operator may use the
override path (eyeball + judgment) so promotion isn't gated on calendar
time.

The two paths produce the same end-state: the `AI_SDLC_TUI` default
flips from `off` to `on` in the appropriate surface (see "The flag
flip" below). The only difference is which evidence justified the flip.

---

## Corpus path (preferred when ≥ 100 sessions across ≥ 7 days)

### 1. Locate the TUI events artifact

The TUI writes usage events to `$ARTIFACTS_DIR/_tui/events.jsonl`
(one line per event, append-only). The canonical location is
`./artifacts/_tui/events.jsonl` when `ARTIFACTS_DIR` isn't set.

```bash
# Inspect recent events
tail -50 ./artifacts/_tui/events.jsonl | jq .
```

If you've been running the TUI over multiple days, all events accumulate
in the same file (unlike the orchestrator which date-rotates). Collect
it into a working directory for the aggregator:

```bash
mkdir -p ./tui-corpus
cp ./artifacts/_tui/events.jsonl ./tui-corpus/
```

### 2. Run the aggregator

```bash
node pipeline-cli/bin/cli-tui-corpus.mjs aggregate ./tui-corpus --format table
```

Or for JSON output (useful when chaining with `jq`):

```bash
node pipeline-cli/bin/cli-tui-corpus.mjs aggregate ./tui-corpus
```

Tunables (rarely needed; defaults match RFC-0023 §13 Phase 7):

- `--min-samples` — session-count floor (default 100)
- `--min-days` — distinct-calendar-day floor (default 7)
- `--pane-open-threshold` — pane-engagement rate floor (default 0.50)
- `--since` / `--until` — ISO date filters to scope the soak window
- `--format` — `json` (default) or `table`

### 3. Read the `recommendation` field

- **`safe-to-promote`** — all three gates passed:
  `TuiCrashed=0`, `sessionCount ≥ minSamples`, `distinctDays ≥ minDays`,
  AND `paneEngagementRate ≥ paneOpenThreshold`. Dispatch the flag flip
  (see "The flag flip" below). Include the JSON envelope from the
  aggregator in the PR body as the audit trail.
- **`continue-soak`** — corpus has enough data, but at least one gate
  failed. The `reason` field names the failing metric:
  - **`TuiCrashed > 0`** → investigate crashes before promoting. The
    `error` field on the crash event identifies the failure. Fix the
    underlying issue, clear the events log, and re-soak.
  - **`paneEngagementRate` too low** → operators aren't yet navigating
    beyond overview. Consider whether the TUI's pane discoverability
    needs improvement (keystroke hint visibility, onboarding banner),
    or whether soak simply needs more time.
- **`insufficient-data`** — `sessionCount < 100` OR `distinctDays < 7`.
  Either soak longer or use the override path below.

### 4. Dispatch the flag flip

Once `recommendation: safe-to-promote` lands, follow "The flag flip"
section below.

---

## Override path (when corpus is sparse but signal is clearly fine)

Use this when:

- `cli-tui-corpus` returns `insufficient-data`, AND
- The operator has separate evidence the TUI is stable (e.g. they've
  personally used it across multiple days and observed no crashes,
  pane transitions work as expected, and the UI is part of the daily
  monitoring cadence).

### Steps

1. **Check for crashes manually**:

   ```bash
   grep '"type":"TuiCrashed"' ./artifacts/_tui/events.jsonl | wc -l
   ```

   The output MUST be `0`. If any crashes are present, the override
   path is NOT available — fix the crash first.

2. **Spot-check session quality**:

   ```bash
   node pipeline-cli/bin/cli-tui-corpus.mjs aggregate ./artifacts/_tui \
     --format table
   ```

   Review the per-session table: are panes other than overview appearing?
   Do session durations look reasonable (not abnormally short — which
   could indicate the TUI crashed or was unusable)?

3. **Document the decision**: when dispatching the flag-flip PR,
   include a short note in the PR body explaining which path was used
   and the evidence the operator reviewed. The override path is the
   operator's call to make, but the audit trail is mandatory.

4. **Dispatch the flag flip** the same way as the corpus path (see
   "The flag flip" below).

---

## The flag flip

The `AI_SDLC_TUI` default is currently OFF. The flag parser lives in
`pipeline-cli/src/tui/feature-flag.ts` (`isTuiEnabled`) and follows
the canonical opt-in semantics (`experimental` plus the standard
`1`/`true`/`yes`/`on` case-insensitive). To flip the default to ON,
choose the surface appropriate to your deployment:

### Option A — flip the default in the parser (single-PR flip)

Edit `pipeline-cli/src/tui/feature-flag.ts#isTuiEnabled` so the flag
defaults to ON when unset, and operators opt OUT via `AI_SDLC_TUI=off`.
This is the cleanest "default-on" flip but inverts the parser's polarity
— every consumer that branches on the flag value should be reviewed in
the same PR.

A mechanical reference diff (do NOT apply blindly — review every caller
first):

```diff
+const FALSY = new Set(['off', '0', 'false', 'no']);
 export function isTuiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
   const raw = env[TUI_FLAG];
-  if (!raw) return false;
-  return TRUTHY.has(raw.trim().toLowerCase());
+  if (!raw) return true; // default-on after RFC-0023 §13 Phase 7 promotion
+  return !FALSY.has(raw.trim().toLowerCase());
 }
```

Also update `tuiDisabledMessage()` to reflect the new semantics:

```diff
 export function tuiDisabledMessage(): string {
   return (
-    `cli-tui is not enabled. Set ${TUI_FLAG}=experimental to opt in.\n` +
-    `See: docs/operations/operator-tui-promotion.md (once Phase 7 ships)`
+    `cli-tui is disabled. Set ${TUI_FLAG}=off to opt out, or unset it for the default-on behaviour.\n` +
+    `See: docs/operations/operator-tui-promotion.md`
   );
 }
```

### Option B — set the env in the operator entrypoint

Add `AI_SDLC_TUI=experimental` to the env block of every shell profile,
systemd unit, or Docker container that runs the operator CLI — leaves
the parser's default OFF and lets local operators opt out by unsetting
the env. Less invasive but doesn't propagate to new installs.

The corpus-path PR should pick Option A (true default-on); the override
path may pick either depending on confidence. **Both produce the same
operator UX**: `cli-tui` starts without an explicit env flag; the five
RFC-0023 §7 panes are available; the soak corpus accumulates in the
background; nothing on-disk needs to be undone.

After the flip lands, update:

- `CLAUDE.md` — change the `AI_SDLC_TUI` bullet description from
  "Off by default" to "On by default; set `AI_SDLC_TUI=off` to disable."
- `pipeline-cli/src/tui/feature-flag.ts` — update `tuiDisabledMessage`
  as shown above to reflect the new default.
- AISDLC-178 (parent RFC-0023 parent task) — close ACs #4, #5, #6:
  "soak complete, pain points captured, flag promoted."
- `spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md` — add a
  v0.3 revision history entry noting the Phase 7 promotion date and
  any aggregate corpus metrics that informed the decision.

---

## What happens after the flip

Once `AI_SDLC_TUI` is ON by default:

- Operators who run `node pipeline-cli/bin/cli-tui.mjs` (or the shell
  alias / systemd unit) get the full-screen dashboard without setting
  an env. Set `AI_SDLC_TUI=off` locally to revert to the old CLI-only
  workflow.
- The soak corpus (`$ARTIFACTS_DIR/_tui/events.jsonl`) continues to
  accumulate — nothing on-disk needs to be undone. Future `cli-tui-corpus
  aggregate` runs will reflect the post-promotion usage pattern.
- RFC-0024 emergent captures (pain points surfaced during soak) remain
  open in the backlog as normal tasks; they don't need to be resolved
  before or after promotion.
- The five panes (Blockers, PRs, CriticalPath, Analytics, Events) keep
  receiving data from their existing source hooks — no per-pane
  behaviour shift, just "the TUI now starts by default."

If the flip turns out to be premature (crashes surface post-promotion,
or the TUI causes terminal issues in unexpected environments), revert
the parser change (Option A) or remove the env override (Option B) in
a single-line PR. The events artifact keeps accumulating regardless of
mode; the next corpus aggregation will reflect the regression.

### Rollback procedure

The flag is designed to be a single-line revert:

```bash
# Option A rollback — re-flip the parser default to OFF.
git revert <flag-flip-sha>
git push origin HEAD --force-with-lease  # only on a feature branch
```

```bash
# Option B rollback — remove AI_SDLC_TUI=experimental from the env file/unit.
# (No code change; the environment re-reads the new config on next launch.)
```

The soak events file keeps flowing through the rollback — nothing is
lost, and the next corpus aggregation will show any regression that
justified the rollback.

---

## Corpus aggregation reference

Key metrics produced by `cli-tui-corpus aggregate`:

| Metric | Description | Promotion gate |
|---|---|---|
| `crashCount` | Total `TuiCrashed` events in corpus | Must be 0 (hard gate) |
| `sessionCount` | Distinct TUI sessions observed | ≥ 100 (default) |
| `distinctDays` | Calendar days with at least one session | ≥ 7 (default) |
| `paneEngagementRate` | Fraction of sessions that opened a non-overview pane | ≥ 50% (default) |
| `paneOpenDistribution` | Per-pane fraction of sessions that opened it | Informational |
| `avgSessionDurationMs` | Average session length (ended sessions only) | Informational |
| `capturesFiled` | Total `TuiCaptureFiled` events in corpus | Informational |
| `recommendation` | `safe-to-promote` / `continue-soak` / `insufficient-data` | The go/no-go signal |

---

## References

- RFC-0023 §13 Phase 7 (soak + corpus-driven exit criteria)
- AISDLC-178.7 (this PR — corpus aggregator + this runbook)
- AISDLC-178.6 (Phase 6 — analytics writer, source hooks,
  `$ARTIFACTS_DIR/_tui/events.jsonl` writer)
- RFC-0024 (emergent issue capture pattern — captures filed during soak)
- [`docs/operations/orchestrator-promotion.md`](orchestrator-promotion.md) — sister
  promotion runbook for RFC-0015's `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` flip;
  same hybrid-corpus-OR-override structure
- [`docs/operations/deps-composition-promotion.md`](deps-composition-promotion.md) — sister
  promotion runbook for RFC-0014's `AI_SDLC_DEPS_COMPOSITION` flip
- [`docs/operations/operator-runbook.md`](operator-runbook.md) — daily/weekly/monthly
  cadence; TUI usage section (see "TUI usage" below)
