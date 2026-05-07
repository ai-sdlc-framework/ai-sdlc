---
id: AISDLC-178.3
title: >-
  Phase 3: Blockers pane — decision-pending detection, sort by urgency,
  drill-down detail view
status: Done
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
- [x] #1 pipeline-cli/src/tui/blockers/detector.ts implements all 7 heuristic detection rules from RFC §8
- [x] #2 Override marker support: `<!-- ai-sdlc:not-a-decision -->` suppresses; `<!-- ai-sdlc:urgent-decision -->` escalates to top of pane
- [x] #3 Sort order: urgent-marker > critical PR finding > Needs Clarification > tbd capture > stale (>7d) item; ties broken by most-recent-first
- [x] #4 Each row renders: type icon, ID, one-line summary, age, urgency badge
- [x] #5 Enter on a row opens detail view (full-screen modal); Esc returns to Overview Mode
- [x] #6 Detail view shows: full text, source context (PR URL, file path, capture evidence), action shortcuts (open in browser, mark not-a-decision, dismiss)
- [x] #7 Empty-state copy '✓ No decisions pending — pipeline self-driving' renders when zero blockers detected
- [x] #8 Unit tests cover: each detection rule, marker suppression, urgency sorting, detail-view navigation
- [x] #9 New code reaches 80%+ patch coverage (blockers module: 98.57% lines; package overall: 94.24%)

## Final Summary

## Summary
Phase 3 of RFC-0023 shipped: the Blockers pane now surfaces live decision-pending items using 7 heuristic detection rules (Needs Clarification, DoR comment marker, triage:tbd, CHANGES_REQUESTED PR review, open PR question, external dependency). Items are sorted by urgency (urgent-marker > changes-requested > needs-clarification > triage-tbd > external-dep > open-pr-question), with staleness (>7d) secondary and recency tie-breaking. Enter on a row opens a full-screen detail view; Esc returns to the list. Empty-state renders the RFC §15 OQ-9 affirming copy.

## Changes
- `pipeline-cli/src/tui/blockers/detector.ts` (new): Pure detection engine implementing all 7 RFC §8 rules + marker suppression/escalation + sort logic.
- `pipeline-cli/src/tui/blockers/use-blockers.ts` (new): React hook consuming Phase 2 sources (useBacklogTasks + useGhPrs) and running the detector on every poll.
- `pipeline-cli/src/tui/blockers/index.ts` (new): Public exports.
- `pipeline-cli/src/tui/panes/blockers.tsx` (modified): Full Phase 3 implementation replacing Phase 1 placeholder — row rendering with icons/badges, detail modal, empty state.
- `pipeline-cli/src/tui/blockers/detector.test.ts` (new): 48 unit tests covering all detection rules, suppression, urgency sort, readTaskBody.
- `pipeline-cli/src/tui/blockers/use-blockers.test.tsx` (new): 5 hook integration tests.

## Design decisions
- **Dependency injection for testability**: Both `detector.ts` and `use-blockers.ts` accept injected walkers/fetchers/detectors so tests don't need a real filesystem or gh CLI.
- **Separate `blockers/` subdirectory**: Keeps the detector + hook separate from the pane component, mirroring the `sources/` pattern from Phase 2.
- **Real hook + dummy fallback pattern**: `useBlockers` always mounts both `useBacklogTasks` and `useGhPrs` (Rules of Hooks), passing a no-op walker/fetcher when the test injection is active.

## Verification
- `pnpm build` — clean
- `pnpm test` — 1962 tests passed (115 files)
- `pnpm lint` — clean
- `pnpm format:check` — clean
- blockers module coverage: 98.57% lines, package overall: 94.24%

## Follow-up
- Phase 4 (PRs pane) can now consume `useGhPrs` and add `reviewDecision` + `reviews` to `GhPR_JSON_FIELDS` to make Rule 4 more robust.
- Phase 5 (mode switching) wires the `b` key to expand the Blockers pane full-screen.
<!-- AC:END -->
