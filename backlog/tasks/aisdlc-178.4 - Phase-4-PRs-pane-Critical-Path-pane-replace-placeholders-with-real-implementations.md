---
id: AISDLC-178.4
title: >-
  Phase 4: PRs pane + Critical Path pane — replace placeholders with real
  implementations
status: To Do
assignee: []
created_date: '2026-05-04 02:03'
labels:
  - rfc-0023
  - phase-4
  - prs
  - critical-path
dependencies:
  - AISDLC-178.2
references:
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - pipeline-cli/src/deps/effective-priority.ts
parent_task_id: AISDLC-178
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0023 implementation (RFC §13 Phase 4, ~1 week).

Two panes shipped together since they share concerns (sort by urgency/priority, drill-down for detail).

**PRs pane** (RFC §7.2): Compact summary of every open PR with PR number, branch, title, CI status (✓/⏳/✗), review state (approved/changes/pending), merge state (clean/behind/dirty/blocked), "next step" annotation. Color-coded by urgency. Sorted by "operator-attention required" descending.

**Critical Path pane** (RFC §7.3): Renders RFC-0014 dependency snapshot's frontier sorted by effectivePriority + criticalPathLength. Shows next ~5–10 tasks the orchestrator would dispatch. Each row: ID, title, effPri, CPL, blast-radius (downstream count from RFC-0014 Phase 3 / AISDLC-167.3). Enter opens detail with full dependency tree as ASCII.

Parallelizable with Phases 3 + 5.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipeline-cli/src/tui/prs/pane.tsx renders PRs pane per RFC §7.2 layout
- [ ] #2 PR row shows: number, branch (truncated), title (truncated), CI glyph, review state, merge state, next-step annotation
- [ ] #3 Color coding: green (ready-to-merge), yellow (in-progress), red (blocked), grey (no-attention-needed)
- [ ] #4 Sort order: blocked-on-human > changes-requested > awaiting-rebase > in-progress > ready-to-merge
- [ ] #5 Enter opens PR detail (full-screen): full title/body, review history, file change summary; `o` opens in browser via gh browse
- [ ] #6 pipeline-cli/src/tui/critical-path/pane.tsx renders Critical Path pane per RFC §7.3 layout
- [ ] #7 Critical Path consumes useDepSnapshot hook from Phase 2; sorts by effectivePriority DESC → criticalPathLength DESC → recency DESC → id ASC (matches cli-deps frontier)
- [ ] #8 Critical Path row shows: task ID, title (truncated), effPri, CPL, blast-radius count
- [ ] #9 Enter on Critical Path row opens detail with full dep tree rendered as ASCII (parents above, children below the focused task)
- [ ] #10 Unit tests cover: PR sort order, CI glyph mapping, dep tree ASCII rendering, color/state encoding
- [ ] #11 New code reaches 80%+ patch coverage
<!-- AC:END -->
