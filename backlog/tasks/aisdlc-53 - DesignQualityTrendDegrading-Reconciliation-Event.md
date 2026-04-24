---
id: AISDLC-53
title: DesignQualityTrendDegrading Reconciliation Event
status: Done
assignee: []
created_date: '2026-04-24 17:24'
updated_date: '2026-04-24 18:53'
labels:
  - trend-monitor
  - reconciler
  - M4
milestone: m-1
dependencies:
  - AISDLC-40
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Addendum A §A.8. New `orchestrator/src/design-quality-trend.ts` running over rolling-window `code_area_metrics` + `design_review_events` history.

Trigger conditions (OR between metrics, AND for consecutive-window requirement):
- `designCIPassRate` declined ≥15% over 10 PRs or 30d
- `designReviewRejectionRate` increased ≥20% over window
- `tokenComplianceTrend` negative ≥5 consecutive measurements

Action per §A.8:
- Emit `DesignQualityTrendDegrading` event
- Create GitHub issue with body template populated from state (current, baseline, trend values)
- Notify design + engineering authority principals

Hysteresis via `last_trigger_at` — fire once per code area until recovery.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Rolling window of 10 PRs or 30 days (whichever fills first) — configurable default
- [x] #2 Event fires only once per code area until recovery (hysteresis via last_trigger_at)
- [x] #3 Synthetic 10-PR fixture with monotonic decline fires; noisy data around baseline does not
- [x] #4 Notification uses designAuthority + engineeringAuthority principals from linked DSB
- [x] #5 Unit tests + fixtures for 3 trigger conditions
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`DesignQualityTrendDegrading` detector landed. Analyzes rolling windows over `code_area_metrics` and `token_compliance_history`, evaluates three independent trigger conditions, and emits at most one event per code area within the hysteresis recovery window.

## Changes
- `orchestrator/src/design-quality-trend.ts` (new): exports `DEFAULT_TREND_CONFIG` (AC #1), pure-function evaluators (`splitHistoryByWindow`, `evaluateCiPassRate`, `evaluateReviewRejectionRate`, `evaluateTokenComplianceTrend`), aggregate `analyzeTrend()`, and the stateful detector `detectDesignQualityTrendDegrading(codeArea, deps)` that reads history from `StateStore`, resolves the code area's DSB, and emits a `DesignQualityTrendDegradingEvent` with the triggered conditions, baseline/current values, notified principals, and a rendered issue body.
- `orchestrator/src/design-quality-trend.test.ts` (new): 19 tests — window-split semantics (windowPrs vs windowDays bound), per-condition evaluator tables, monotonic-decline fixture fires (AC #3), noisy baseline does NOT fire (AC #3), hysteresis within-window skip (AC #2), hysteresis post-recovery re-fire (AC #2), notified principals = design + engineering union (AC #4), empty history returns undefined, issue body includes code area + condition names, default config matches RFC-0008 thresholds (AC #1).

## Design decisions
- **Window split walks newest→oldest** and stops at either `windowPrs` rows OR the first row older than `windowDays`, whichever comes first. This keeps the recent window consistent whether activity is sparse (days dominate) or bursty (PR count dominates).
- **Baseline is "everything older than recent"**, not a separate fixed window: simpler semantics, and lets comparisons stabilize as more history accumulates. Tests ensure baseline is populated with old-enough data.
- **Three conditions evaluated independently, OR-combined**: any one triggering fires the event. The returned `conditions` map surfaces which conditions triggered so reviewers can focus remediation.
- **Hysteresis via caller-supplied `getLastTriggerAt` + `hysteresisRecoveryMs` (default 7d)**: the detector is otherwise stateless — it doesn't persist anything. Caller (scheduler) reads/writes the `last_trigger_at` alongside the `design_lookahead_notifications` table or a similar store. Quiet window default is 7d per §A.8.
- **Token compliance trend uses declining-streak counting**, not a t-test or regression: RFC-0008 §A.8 says "≥5 consecutive measurements". Streak counting matches verbatim and avoids spurious noise-triggered fires from short zigzags.
- **Notified principals are the union of designAuthority + engineeringAuthority** — both parties need to see trend degradation, and deduplicating via `Set` handles the edge case where one principal serves both roles.
- **Detector emits but does not persist**: matches the AISDLC-51/52 pattern. Callers file the GitHub issue, write to `design_lookahead_notifications` for hysteresis, and forward the event to Slack/email integrations.

## Verification
- `pnpm build` — clean (all 9 packages)
- `pnpm vitest run src/design-quality-trend.test.ts` — 19/19 pass
- `pnpm vitest run` (full orchestrator) — 2019/2019 pass (+19)
- `pnpm lint` — clean

## Follow-up
AISDLC-54 (C7 design lookahead) is the last M4 task — same stateless-detector + caller-owned-state pattern, but trigger is "top-10 backlog item pending ≥48h with design-system impact" rather than a quality trend window.
<!-- SECTION:FINAL_SUMMARY:END -->
