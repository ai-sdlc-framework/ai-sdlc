---
id: AISDLC-178
title: 'RFC-0023: Operator TUI — Pipeline Monitoring + Steering Surface'
status: To Do
assignee: []
created_date: '2026-05-04 02:01'
labels:
  - rfc-0023
  - operator-tui
  - architecture
dependencies: []
references:
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - VISION.md
  - docs/operations/operator-runbook.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Parent task for the RFC-0023 implementation. Splits the 7-phase implementation plan from RFC §13 into trackable sub-tasks (AISDLC-178.1 through 178.7).

Phases 3 + 4 + 5 are parallelizable from Phase 2; Phase 6 sequences after Phase 5; Phase 7 (soak + promotion) sequences after Phase 6. Critical path: 178.1 → 178.2 → 178.5 → 178.6 → 178.7 (~5–6 weeks). Total wall-clock ~6–8 weeks.

The TUI is the operator's canonical surface for monitoring + unblocking the autonomous pipeline (post-RFC-0015). Anchors on the Decision Engine framing (VISION.md §3): the operator's bottleneck is decisions, not commits — TUI must foreground decisions-pending above implementation status.

All 10 RFC open questions resolved via operator walkthrough on 2026-05-03 (RFC-0023 §15). Resolutions are normative — implementation MUST follow.

Sub-task structure mirrors RFC-0010's pattern (AISDLC-70 parent + decimal sub-tasks per phase).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All 7 phase sub-tasks (AISDLC-178.1 through 178.7) reach Done status
- [ ] #2 Feature flag AI_SDLC_TUI=experimental promoted to default-on after Phase 7 hardening completes (RFC §14)
- [ ] #3 Operator TUI usable end-to-end on dogfood pipeline (operator can monitor blockers, PRs, dep graph, analytics from one terminal pane)
- [ ] #4 Hybrid promotion runbook landed at docs/operations/operator-tui-promotion.md (RFC §13 Phase 7)
- [ ] #5 Operator runbook (docs/operations/operator-runbook.md) extended with TUI usage section + keystroke reference
<!-- AC:END -->
