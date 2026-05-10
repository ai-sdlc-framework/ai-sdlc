---
id: AISDLC-178.6
title: >-
  Phase 6: Analytics pane + operator throughput metrics —
  _operator/decisions.jsonl + analytics rendering
status: To Do
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
- [ ] #1 pipeline-cli/src/tui/analytics/decisions-writer.ts hooks into mcp__backlog__task_edit transitions and writes to $ARTIFACTS_DIR/_operator/decisions.jsonl
- [ ] #2 pipeline-cli/src/tui/analytics/pr-decisions-writer.ts captures operator PR actions (merge, dismiss, comment) via gh hooks
- [ ] #3 pipeline-cli/src/tui/analytics/interactions-writer.ts logs TUI pane opens / drill-downs (default-on, opt-OUT via AI_SDLC_TUI_TELEMETRY=off)
- [ ] #4 TUI startup banner discloses telemetry path + opt-out env var per OQ-8 resolution
- [ ] #5 Analytics pane (overview + full-screen) renders OPERATOR THROUGHPUT section first: decisions resolved (24h), avg time-to-decision, % WIP blocked on operator, stale captures count
- [ ] #6 Analytics pane renders PIPELINE THROUGHPUT section second: dispatched, merged, failed, quarantined, reliability trend (week-over-week)
- [ ] #7 Visual divider clearly separates the two sections
- [ ] #8 Reliability trend metric reads from RFC-0025's framework-quality data when available; degrades gracefully to 'no data' when not
- [ ] #9 Time-to-decision computed from decisions.jsonl: timestamp of clarification-posted → timestamp of operator-status-flip
- [ ] #10 Unit tests cover: decisions writer hook behavior, opt-out behavior, metric computation, graceful degradation when source data missing
- [ ] #11 New code reaches 80%+ patch coverage
<!-- AC:END -->
