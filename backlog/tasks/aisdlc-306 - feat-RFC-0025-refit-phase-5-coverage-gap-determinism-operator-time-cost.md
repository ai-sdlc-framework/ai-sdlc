---
id: AISDLC-306
title: 'feat: RFC-0025 Refit Phase 5 — Coverage-gap capture + composite determinism + instrumented operator-time-cost (OQ-6 + OQ-7 + OQ-9)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0025
  - refit
  - phase-5
  - critical-path-rfc-0035
dependencies:
  - AISDLC-302
  - AISDLC-273
references:
  - spec/rfcs/RFC-0025-framework-quality-monitoring.md
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - spec/rfcs/RFC-0014-dependency-graph-and-effective-priority.md
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0025 Refit Phase 5. Three composition-heavy implementations: coverage-gap response via RFC-0024 captures (OQ-6), composite determinism detection via RFC-0014 blast-radius (OQ-7), and instrumented operator-time-cost via RFC-0015 events.jsonl (OQ-9).

## Scope (OQ-6 coverage-gap)

- `framework-coverage-gap` produces a capture with `source: framework-coverage-gap` + `triage: tbd` (composes with RFC-0024 capture substrate).
- Operator triages via existing RFC-0024 rubric.
- Auto-quarantine the affected dispatch.
- Rate-ceiling + stale-ladder from RFC-0024 §15.1 handle flood control.

## Scope (OQ-7 composite determinism)

- Salvage `determinism-detector.ts` sampling skeleton from AISDLC-302 cherry-pick.
- Add composite gates: default sample rate 1-in-50 + always-on for `requires-determinism: true` + always-on for top-decile blast-radius (composes with RFC-0014 dep-graph snapshot).
- Per-org rate override in `quality-monitoring.yaml` (`quality.determinism-detection.defaultSampleRate`).

## Scope (OQ-9 instrumented operator-time-cost)

- Compute elapsed-time from `OrchestratorBlockedByX` events to `OperatorActionTaken` events using RFC-0015 `events.jsonl` substrate.
- Surface in §7 severity rubric output.
- Feed RFC-0035 §7 operator-fatigue signal (composition opportunity; gated until RFC-0035 Phase 7 / AISDLC-291 ships).
- Per-org AFK noise filter (`quality.operator-time-cost.afkInactivityMinutes` default 30).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `framework-coverage-gap` files an RFC-0024 capture with correct source + triage
- [ ] #2 Affected dispatch auto-quarantined on coverage-gap detection
- [ ] #3 Composite determinism gates ship: sampling + requires-determinism + top-decile blast-radius
- [ ] #4 Blast-radius source reads RFC-0014 dep-graph snapshot
- [ ] #5 Operator-time-cost computed from RFC-0015 events.jsonl with AFK filter
- [ ] #6 Surface in §7 severity rubric output
- [ ] #7 RFC-0035 §7 fatigue-signal feed wired (gated until RFC-0035 P7 ships)
- [ ] #8 Per-org configurability via quality-monitoring.yaml for all three OQs
<!-- AC:END -->
