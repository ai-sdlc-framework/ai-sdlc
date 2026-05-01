---
id: AISDLC-115.6
title: 'Phase 5: Metrics + observability (calibration log + Slack digest)'
status: To Do
assignee: []
created_date: '2026-05-01 16:25'
labels:
  - rfc-0011
  - phase-5
  - observability
  - metrics
milestone: m-3
dependencies:
  - AISDLC-115.5
references:
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#8-metrics-and-observability
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md#55-calibration-log
parent_task_id: AISDLC-115
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Observability surface for DoR. The calibration log is what Phase 7 soak measures false-positive rate against. Without this, Phase 7 can't decide when to promote `warn-only` → `enforce`. Per RFC §12 Phase 5 + §8 + §5.5.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Calibration log writer writes JSONL to `$ARTIFACTS_DIR/_dor/calibration.jsonl` (per-issue verdict + per-gate breakdown + confidence + author + timestamp)
- [ ] #2 Per-author and per-gate aggregation queryable (e.g., `cli-dor-stats --by-author --by-gate`)
- [ ] #3 Weekly Slack digest entry summarising: pass rate, top failing gates, override rate, false-positive trend
- [ ] #4 Override events log to the same calibration log so Phase 7 soak can compute false-positive rate
- [ ] #5 Metrics dashboard renders the first weekly digest end-to-end
- [ ] #6 New code reaches 80%+ patch coverage
<!-- AC:END -->
