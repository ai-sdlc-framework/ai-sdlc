---
id: AISDLC-668.4
title: >-
  RFC-0051: cli-hierarchy brief-status subcommand
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
The planner command computes brief progress with a shell loop over done verdict files. Add a brief-status subcommand that prints each open brief with its progress and use it in the planner command instead.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] brief-status prints each open brief with done and total task counts.
- [ ] The planner command calls brief-status instead of the shell loop.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
