---
id: AISDLC-668.2
title: >-
  RFC-0051: planner command lists only decisions routed to the planner
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - dispatch
dependencies:
  - AISDLC-668
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - pipeline-cli/src/hierarchy/brief.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The planner command lists every pending decision because the decision CLI has no route filter. When it gains one, list only design-routed decisions and leave operational ones to the dispatch session.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] The planner command lists only decisions routed to the planner.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
