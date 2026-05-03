---
id: AISDLC-167.4
title: 'Phase 4: Slack + dashboard digest'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - rfc-0014
  - phase-4
  - observability
  - slack-digest
  - dashboard
milestone: m-3
dependencies:
  - AISDLC-167.2
parent_task_id: AISDLC-167
references:
  - spec/rfcs/RFC-0014-dependency-graph-composition.md
  - pipeline-cli/src/deps/
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0014. Surface the critical path on the existing Slack weekly digest + render an interactive graph view in the operator dashboard. Per RFC §7.

This phase is parallelizable with Phase 3 (both depend only on Phase 2's `effectivePriority` + the snapshot artifact from Phase 1). Estimated 1 week.

## Components

- **Slack weekly digest** (RFC §7.1): new "🛤️ Critical Path This Week" section listing top 3-5 items by `effectivePriority` with their downstream-blocked count. Composes with the existing weekly digest from RFC-0011 §8 + RFC-0010 cli-status.
- **Operator dashboard** (RFC §7.2): interactive graph view — click a task → see blockers + downstream + PPA score + DoR verdict. Mermaid-style rendering with color-coding by status (To Do = blue, In Progress = yellow, Needs Clarification = red, Done = green).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Weekly digest gains a "🛤️ Critical Path This Week" section listing top 3-5 items sorted by `effectivePriority` (Phase 2 output) with each item's downstream-blocked count per RFC §7.1
- [ ] #2 Digest format degrades gracefully when no items qualify (e.g., flat graph, all leaves) — section is omitted entirely rather than rendering an empty header
- [ ] #3 Dashboard graph view renders the dependency snapshot interactively: click a task → see blockers + downstream + PPA score + DoR verdict per RFC §7.2
- [ ] #4 Dashboard color-coding by status: To Do = blue, In Progress = yellow, Needs Clarification = red, Done = green per RFC §7.2
- [ ] #5 Dashboard reads the latest `$ARTIFACTS_DIR/_deps/snapshot.<timestamp>.jsonl` (Phase 1 artifact); honors the Q6 "best-effort consistency" contract — surfaces dangling-edge warnings rather than crashing
- [ ] #6 Behind feature flag `AI_SDLC_DEPS_COMPOSITION` (default off); when off, weekly digest + dashboard render the pre-RFC-0014 baseline (no critical-path section, no graph view)
- [ ] #7 Hermetic snapshot test for the digest section (top-3-5 sort, downstream-count rendering, empty-graph degradation)
- [ ] #8 New code reaches 80%+ patch coverage; full workspace `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->
