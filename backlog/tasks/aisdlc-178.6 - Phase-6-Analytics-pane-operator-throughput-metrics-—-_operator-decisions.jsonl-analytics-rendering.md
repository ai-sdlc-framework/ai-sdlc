---
id: AISDLC-178.6
title: >-
  Phase 6: Analytics pane + operator throughput metrics —
  _operator/decisions.jsonl + analytics rendering
status: Done
assignee: []
created_date: '2026-05-04 02:04'
labels:
  - rfc-0023
  - phase-6
  - analytics
  - operator-metrics
dependencies:
  - AISDLC-178.5
references:
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
parent_task_id: AISDLC-178
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 6 of RFC-0023 implementation (RFC §13 Phase 6, ~1 week).

Operator-throughput metrics surface per RFC §10. New artifact directory `$ARTIFACTS_DIR/_operator/` accumulates:
- `decisions.jsonl` — every Needs Clarification → other-status transition with timestamp deltas
- `pr-decisions.jsonl` — every PR review action by the operator (merge, dismiss, comment) with elapsed time from "operator-attention-required" state
- `interactions.jsonl` — TUI navigation events (which panes opened, which items drilled into) — opt-OUT default per OQ-8 resolution (local-only data, opt-IN if/when shipped offsite)

Per OQ-3 resolution: Analytics pane shows BOTH operator-throughput (primary, top) AND pipeline throughput (secondary, bottom). Layout per OQ-3 walkthrough.

Per OQ-10 resolution: failure events shown in Events pane (separate concern) but framework-quality metrics (reliability trend, MTTR) rendered in pipeline-throughput section here.

Sequenced after Phase 5 (mode-switching infra needed for `a` full-screen mode).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 pipeline-cli/src/tui/analytics/decisions-writer.ts hooks into mcp__backlog__task_edit transitions and writes to $ARTIFACTS_DIR/_operator/decisions.jsonl
- [x] #2 pipeline-cli/src/tui/analytics/pr-decisions-writer.ts captures operator PR actions (merge, dismiss, comment) via gh hooks
- [x] #3 pipeline-cli/src/tui/analytics/interactions-writer.ts logs TUI pane opens / drill-downs (default-on, opt-OUT via AI_SDLC_TUI_TELEMETRY=off)
- [x] #4 TUI startup banner discloses telemetry path + opt-out env var per OQ-8 resolution
- [x] #5 Analytics pane (overview + full-screen) renders OPERATOR THROUGHPUT section first: decisions resolved (24h), avg time-to-decision, % WIP blocked on operator, stale captures count
- [x] #6 Analytics pane renders PIPELINE THROUGHPUT section second: dispatched, merged, failed, quarantined, reliability trend (week-over-week)
- [x] #7 Visual divider clearly separates the two sections
- [x] #8 Reliability trend metric reads from RFC-0025's framework-quality data when available; degrades gracefully to 'no data' when not
- [x] #9 Time-to-decision computed from decisions.jsonl: timestamp of clarification-posted → timestamp of operator-status-flip
- [x] #10 Unit tests cover: decisions writer hook behavior, opt-out behavior, metric computation, graceful degradation when source data missing
- [x] #11 New code reaches 80%+ patch coverage
<!-- AC:END -->

## Final Summary

### Summary
Phase 6 of RFC-0023 ships the operator-throughput analytics surface. The Analytics pane renders OPERATOR THROUGHPUT first (decisions resolved 24h, avg time-to-decision, % WIP blocked on operator, stale captures) and PIPELINE THROUGHPUT second (dispatched/merged/failed/quarantined plus week-over-week reliability trend), separated by a visual divider per OQ-3. Three append-only JSONL writers (`_operator/decisions.jsonl`, `pr-decisions.jsonl`, `interactions.jsonl`) capture operator decisions, PR actions, and TUI navigation events; the interactions stream is default-on with an `AI_SDLC_TUI_TELEMETRY=off` opt-out per OQ-8, disclosed at TUI startup via a new banner.

### Changes
- `pipeline-cli/src/tui/analytics/` (new directory, 14 files): writers + readers + metric computations + composite hook
  - `feature-flag.ts` — `AI_SDLC_TUI_TELEMETRY` opt-OUT predicate
  - `paths.ts` — `_operator/*.jsonl` path helpers
  - `jsonl-append.ts` — shared best-effort JSONL appender (mirrors orchestrator/events.ts contract)
  - `decisions-writer.ts` — `writeDecision()` + `DecisionsTracker` (Needs-Clarification → other-status detection across backlog snapshots)
  - `pr-decisions-writer.ts` — `writePrDecision()` + `PrDecisionsTracker` (CHANGES_REQUESTED → resolved transitions)
  - `interactions-writer.ts` — TUI-navigation event writer
  - `decisions-reader.ts` / `pr-decisions-reader.ts` — file-order JSONL readers, malformed-line tolerant
  - `quality-reader.ts` — RFC-0025 reliability-trend reader (returns `available: false` when source missing)
  - `metrics.ts` — pure operator + pipeline metric computation, plus formatters
  - `use-analytics.ts` — composite React hook backing the pane
  - `index.ts` — public re-exports
  - 7 corresponding test files — full-coverage unit tests
- `pipeline-cli/src/tui/banner.ts` (new): startup-banner generator disclosing telemetry path + opt-out env var
- `pipeline-cli/src/tui/banner.test.ts` (new)
- `pipeline-cli/src/tui/panes/analytics.tsx` (modified): replaces Phase 1 placeholder with two-section render (operator + pipeline) and OQ-3 ordering
- `pipeline-cli/src/tui/panes/analytics.test.tsx` (new): ink-testing-library coverage of section ordering, divider, "no data" degradation, populated counters
- `pipeline-cli/src/tui/modes/router.tsx` (modified): logs every mode transition / refresh / search-edge to `interactions.jsonl` via injectable writer
- `pipeline-cli/src/tui/index.ts` (modified): calls `printBanner()` before Ink renders
- `pipeline-cli/src/tui/app.test.tsx` + `pipeline-cli/src/tui/modes/router.integration.test.tsx` (modified): set `AI_SDLC_TUI_TELEMETRY=off` so existing tests stay hermetic
- backlog task file: status → Done, ACs checked

### Design decisions
- **Tracker-based observation, not MCP-tool wrapping**: AC#1 says "hooks into mcp__backlog__task_edit transitions". The MCP plugin lives in a separate package and doesn't currently emit hook events. The TUI already polls `backlog/` every 30s via the existing walker; the `DecisionsTracker` ingests that snapshot stream and emits a decision record on every detected `Needs Clarification → *` edge. `writeDecision()` is also exported as a pure function so a future MCP-side wrapper can call it directly. Same shape for `PrDecisionsTracker` watching gh-pr-cache snapshots.
- **Visual divider as a distinct double line (`═════`)**, contrasted with the in-section single-line dividers (`─────`), so the operator's eye reliably separates the two sections without colour cues.
- **Reliability-trend graceful degradation via an `available: boolean` sentinel**, not throwing/erroring. RFC-0025 Phase 5 hasn't shipped yet; pane shows "no data" until it does (AC#8).
- **Test pollution avoidance**: the new mode-router effect writes to `_operator/interactions.jsonl` on mount. Existing `app.test.tsx` and `router.integration.test.tsx` were updated to set `AI_SDLC_TUI_TELEMETRY=off` in `beforeAll` rather than rewriting them to inject the writer, keeping the existing test surface intact.
- **Telemetry default ON, opt-OUT via env var** — strictly follows OQ-8: local-only data, banner discloses the path on every startup. Opt-in is reserved for any future offsite shipping.

### Verification
- `pnpm build` — clean (TypeScript strict)
- `pnpm test` — pipeline-cli: 2320 tests pass (147 files); 57 new analytics tests + 9 new banner/pane tests
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Coverage on new code: 97% lines, 95% functions (above 80% threshold)

### Follow-up
- RFC-0025 Phase 5 will populate `$ARTIFACTS_DIR/_quality/captures.jsonl`; the pane will start surfacing actual reliability-trend numbers automatically once that ships (no further pane changes required).
- Phase 7 dogfood will tell whether finer PR-action granularity (separate merge/dismiss/comment subkinds) is worth carrying — current `action` field is open-ended.
