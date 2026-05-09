---
id: AISDLC-178.7
title: 'Phase 7: Soak + corpus aggregator + hybrid promotion runbook'
status: To Do
assignee: []
created_date: '2026-05-04 02:04'
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
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
parent_task_id: AISDLC-178
priority: medium
dispatchable: false
dispatchableReason: >-
  Operator soak phase — operator monitors TUI stability for ~1 week before
  promoting. No code work; this phase is driven by telemetry + human judgment,
  not a developer subagent.
blocked:
  reason: >-
    Operator soak phase — implementation deferred until soak telemetry is in
    place (operator monitors stability for ~1 week with the 178.x TUI in real
    use, then promotes). NOT a dispatchable code task. Orchestrator's
    BlockedFilter should skip this.
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
- [ ] #1 pipeline-cli/src/tui/corpus/aggregate.ts implements `cli-tui-corpus aggregate` returning safe-to-promote | continue-soak | insufficient-data envelope
- [ ] #2 Corpus computes: TUI usage frequency, pane-open distribution, time-to-decision trend over soak window, TuiCrashed count (must be zero for promotion), captures-filed-during-soak count
- [ ] #3 docs/operations/operator-tui-promotion.md hybrid runbook landed: corpus path (`cli-tui-corpus aggregate` returns safe-to-promote) + operator-override path (manual flip with documented justification)
- [ ] #4 Operator dogfoods TUI for ≥ 7 calendar days with the live pipeline; usage events accumulated in $ARTIFACTS_DIR/_tui/events.jsonl
- [ ] #5 Pain points captured during soak via RFC-0024 emergent capture pattern; triaged before promotion (not blocking, but visible)
- [ ] #6 AI_SDLC_TUI=experimental flag promoted to default-on per the runbook; CHANGELOG.md entry + RFC-0023 revision history entry (v0.3) document the promotion
- [ ] #7 Operator runbook (docs/operations/operator-runbook.md) extended with TUI usage section + keystroke reference
<!-- AC:END -->
