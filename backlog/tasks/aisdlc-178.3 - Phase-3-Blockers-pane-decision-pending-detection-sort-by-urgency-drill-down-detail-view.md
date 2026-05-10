---
id: AISDLC-178.3
title: >-
  Phase 3: Blockers pane — decision-pending detection, sort by urgency,
  drill-down detail view
status: To Do
assignee: []
created_date: '2026-05-04 02:02'
labels:
  - rfc-0023
  - phase-3
  - blockers
dependencies:
  - AISDLC-178.2
references:
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
  - pipeline-cli/src/dor/
parent_task_id: AISDLC-178
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0023 implementation (RFC §13 Phase 3, ~1 week).

The Blockers pane is the centerpiece of the TUI per RFC §8 — surfaces "decisions-pending" as the highest-priority signal. Per OQ-4 resolution: heuristic detection with override markers (`<!-- ai-sdlc:not-a-decision -->` to suppress; `<!-- ai-sdlc:urgent-decision -->` to escalate).

Detection rules per RFC §8:
- Backlog task with `status: Needs Clarification`
- Backlog task with `<!-- ai-sdlc:dor-comment -->` marker, no operator response since
- Capture record with `triage: tbd` (RFC-0024)
- Open PR with review state CHANGES_REQUESTED, not dismissed, no follow-up commit since
- Open PR with conversation comment unresolved, mentions operator OR includes "?"
- Task with externalDependencies status != resolved
- Any item with `<!-- ai-sdlc:urgent-decision -->` marker (escalator)
- Items with `<!-- ai-sdlc:not-a-decision -->` are hidden

Each row clickable (Enter) → opens detail view with question/finding + context + action shortcuts.

Parallelizable with Phases 4 + 5.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipeline-cli/src/tui/blockers/detector.ts implements all 7 heuristic detection rules from RFC §8
- [ ] #2 Override marker support: `<!-- ai-sdlc:not-a-decision -->` suppresses; `<!-- ai-sdlc:urgent-decision -->` escalates to top of pane
- [ ] #3 Sort order: urgent-marker > critical PR finding > Needs Clarification > tbd capture > stale (>7d) item; ties broken by most-recent-first
- [ ] #4 Each row renders: type icon, ID, one-line summary, age, urgency badge
- [ ] #5 Enter on a row opens detail view (full-screen modal); Esc returns to Overview Mode
- [ ] #6 Detail view shows: full text, source context (PR URL, file path, capture evidence), action shortcuts (open in browser, mark not-a-decision, dismiss)
- [ ] #7 Empty-state copy '✓ No decisions pending — pipeline self-driving' renders when zero blockers detected
- [ ] #8 Unit tests cover: each detection rule, marker suppression, urgency sorting, detail-view navigation
- [ ] #9 New code reaches 80%+ patch coverage
<!-- AC:END -->
