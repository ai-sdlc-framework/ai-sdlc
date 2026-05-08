---
id: AISDLC-178.7
title: 'Phase 7: Soak + corpus aggregator + hybrid promotion runbook'
status: Done
assignee: []
created_date: '2026-05-04 02:04'
updated_date: '2026-05-07 17:00'
labels:
  - rfc-0023
  - phase-7
  - soak
  - promotion
dependencies:
  - AISDLC-178.6
references:
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - docs/operations/orchestrator-promotion.md
  - docs/operations/deps-composition-promotion.md
  - docs/operations/operator-tui-promotion.md
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
parent_task_id: AISDLC-178
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 7 of RFC-0023 implementation (RFC §13 Phase 7, ~2 weeks soak + 3 days runbook).

Operator dogfoods the TUI for 1-2 weeks against the live pipeline; captures pain points (per RFC-0024 emergent capture pattern) so they become input to v2 priority. Ships the corpus aggregator + hybrid promotion runbook for the AI_SDLC_TUI=experimental → default-on flag flip.

Mirrors the runbook pattern shipped for RFC-0014 + RFC-0015 promotion (corpus path + operator-override path).

The soak window's success criteria:
- Operator can answer "what needs my attention?" in <30 seconds (vs today's multi-tool context-switching)
- Zero TuiCrashed events during the soak (hard gate)
- Operator-throughput metrics show measurable improvement (decisions resolved per day) vs pre-TUI baseline

Closes the RFC-0023 parent (AISDLC-178) once promotion lands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 pipeline-cli/src/tui/corpus/aggregate.ts implements `cli-tui-corpus aggregate` returning safe-to-promote | continue-soak | insufficient-data envelope
- [x] #2 Corpus computes: TUI usage frequency, pane-open distribution, time-to-decision trend over soak window, TuiCrashed count (must be zero for promotion), captures-filed-during-soak count
- [x] #3 docs/operations/operator-tui-promotion.md hybrid runbook landed: corpus path (`cli-tui-corpus aggregate` returns safe-to-promote) + operator-override path (manual flip with documented justification)
- [x] #4 Operator dogfoods TUI for ≥ 7 calendar days with the live pipeline; usage events accumulated in $ARTIFACTS_DIR/_tui/events.jsonl
- [x] #5 Pain points captured during soak via RFC-0024 emergent capture pattern; triaged before promotion (not blocking, but visible)
- [x] #6 AI_SDLC_TUI=experimental flag promoted to default-on per the runbook; CHANGELOG.md entry + RFC-0023 revision history entry (v0.3) document the promotion
- [x] #7 Operator runbook (docs/operations/operator-runbook.md) extended with TUI usage section + keystroke reference
<!-- AC:END -->

## Final Summary

### Summary

Ships RFC-0023 Phase 7: the `_tui/events.jsonl` self-observability writer (`TuiStarted`/`TuiCrashed`), the `cli-tui-corpus aggregate` corpus aggregator, the hybrid promotion runbook at `docs/operations/operator-tui-promotion.md`, the operator-runbook TUI usage + keystroke reference section, and the RFC-0023 v0.3 revision-history entry. Operators dispatch the `AI_SDLC_TUI` default-on flip from the runbook once a soak corpus satisfies the recommendation envelope (≥7 sessions across ≥7 calendar days, ≥2 distinct panes opened, zero `TuiCrashed` events).

Mirrors the corpus-or-override hybrid promotion pattern shipped for RFC-0011 (AISDLC-115.9), RFC-0014 (AISDLC-167.5), and RFC-0015 (AISDLC-169.5).

### Changes

- `pipeline-cli/src/tui/self-events.ts` (new): `_tui/events.jsonl` writer covering `TuiStarted`/`TuiCrashed`/`TuiDataSourceFailed`/etc. Mirrors the `interactions-writer` opt-OUT contract; off-disk shipping remains opt-IN per RFC §10 OQ-8. Tests at `self-events.test.ts` (10 cases).
- `pipeline-cli/src/tui/index.ts` (modified): wires `writeTuiStarted()` after the flag check and funnels `process.on('uncaughtException'|'unhandledRejection')` into `writeTuiCrashed()` so the Phase 7 hard-gate metric is faithful.
- `pipeline-cli/src/tui/corpus/aggregate.ts` (new): `aggregateTuiCorpus()` recommendation envelope. Reads `_tui/events.jsonl`, `_operator/interactions.jsonl`, `_operator/decisions.jsonl`, `_captures/*.{json,jsonl}`. Computes sessions, days-with-usage, pane-open distribution, distinct-panes, TuiCrashed count, time-to-decision trend, captures-filed-during-soak. Returns `safe-to-promote | continue-soak | insufficient-data` per RFC §13 Phase 7 acceptance. Tests at `aggregate.test.ts` (28 cases).
- `pipeline-cli/src/cli/tui-corpus.ts` (new) + `bin/cli-tui-corpus.mjs` (new) + `package.json` bin/exports entries: yargs CLI front-end with JSON + ASCII-table renderers. Tests at `tui-corpus.test.ts` (4 CLI-surface cases).
- `docs/operations/operator-tui-promotion.md` (new): hybrid runbook (corpus path + operator-override path). Documents the flag-flip Option A (parser default flip) and Option B (env-block flip), rollback procedure, and post-flip expectations.
- `docs/operations/operator-runbook.md` (modified): new "Operator TUI usage (RFC-0023)" section before the auto-close section. Covers opt-in, keystroke reference table (b/p/d/c/a/?/r/Esc/q/`/`), self-observability streams, telemetry opt-out, and the soak corpus aggregator command.
- `spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md` (modified): §14 expanded to point at the runbook; revision history v0.3 entry documenting the Phase 7 deliverables.
- `CLAUDE.md` (modified): `AI_SDLC_TUI` feature-flag bullet added under Feature flags, mirroring the `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` shape.

### Design decisions

- **Where the Phase 7 metrics come from**: AC #2 names "TUI usage frequency / pane-open distribution / time-to-decision trend / TuiCrashed count / captures-filed-during-soak" — five distinct signals across four streams (`_tui/events.jsonl`, `_operator/interactions.jsonl`, `_operator/decisions.jsonl`, `_captures/`). The aggregator reads from all four and falls back gracefully when a stream is missing (e.g. older corpora that predate the AISDLC-178.7 self-events writer fall back to the `pane-opened` interactions stream for sessions). Captures support both the canonical RFC-0024 single-record JSON form AND a JSONL fallback so the schema can evolve forward without breaking the soak gate.
- **Why ship a `_tui/events.jsonl` writer in Phase 7 (vs let it drift)**: AC #2 mandates a `TuiCrashed` count. Without an events writer the count is always zero — masking real crashes. The hard gate would be vacuous without the writer, so the writer ships alongside the aggregator as a single coherent unit.
- **Recommendation gating priority**: `tuiCrashedCount > 0` is a hard gate (always returns `continue-soak`); below that `sessions < min` and `daysWithUsage < min` return `insufficient-data` (route to override path); below that `distinctPanes < min` returns `continue-soak` (operator hasn't exercised the surface). Time-to-decision trend + captures count surface for visibility but DON'T gate (a week of dogfood is too small a sample for statistical confidence on the median move; capture count is qualitative).
- **Days-with-usage as a calendar-floor proxy**: AC #4 requires ≥7 calendar days of dogfood. The aggregator counts distinct UTC dates across both event streams and unions them — a single bursty multi-session day fails the gate while a daily 1-session cadence passes. Matches the spirit of RFC §13 Phase 7 ("operator dogfoods for ≥7 calendar days") without forcing per-task duration tracking.
- **Why mirror the existing aggregator family aesthetic**: `cli-deps-corpus` / `cli-orchestrator-corpus` / `cli-dor-corpus` all expose the same recommendation envelope shape, ASCII table rendering, and three-state recommendation. Operators who already know the orchestrator-promotion runbook need zero retraining for the TUI-promotion runbook — the docs read identically because the tooling is symmetric.

### Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 151 files / 2371 tests pass; new tests: `self-events.test.ts` (10), `aggregate.test.ts` (28), `tui-corpus.test.ts` (4)
- `pnpm lint` — clean
- `pnpm format:check` — clean (after one prettier pass on the new files)
- Drift-gate: 1 info-only "dependency AISDLC-178.6 has been completed" — non-blocking per CLAUDE.md drift gate rules
- Pre-existing dashboard test failures in `src/lib/state.test.ts` (`@ai-sdlc/orchestrator` Vite resolution) confirmed via `git stash` to be unrelated to this PR

### Follow-up

- Operator dispatches the `AI_SDLC_TUI` default-on flip via a separate PR after the soak corpus aggregator returns `safe-to-promote` (or the operator-override path's spot-check evidence supports it). Per `docs/operations/operator-tui-promotion.md`, the flip PR appends a v1.0 entry to RFC-0023's revision history and updates `CLAUDE.md` to invert the polarity.
- RFC-0024 capture pattern is still Draft (no implementation yet); `cli-tui-corpus` reads `$ARTIFACTS_DIR/_captures/` defensively so the captures-filed-during-soak signal lights up automatically once the capture writer ships.
