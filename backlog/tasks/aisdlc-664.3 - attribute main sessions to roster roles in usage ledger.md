---
id: AISDLC-664.3
title: >-
  RFC-0051: attribute main-session usage to hierarchy roster roles
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - dispatch
dependencies:
  - AISDLC-664
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - pipeline-cli/src/hierarchy/
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Use the usage ingester to attribute each main session to its roster role (planner, operator-dispatch, executor) by reading the roster, as RFC-0051 section 2 describes, so usage reports can be grouped by tier.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] A main session whose name appears in the roster is recorded with that role as its agent role.
- [ ] A session not in the roster keeps its current attribution.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
