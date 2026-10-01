---
id: AISDLC-664.5
title: >-
  RFC-0051: harden the hierarchy preflight and roster name handling
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
Three small gaps from the review of the bootstrap change. (1) The settings preflight reads user, project and local settings but not managed settings; decide whether to read them, and whether to pass a per-session settings override so the planner keeps its held-message gate. (2) Roster entries stuck in the starting state are never reconciled with the harness session registry on later up or status runs. (3) The roster name field is only length-checked while it drives the inflight join and is echoed to the terminal; constrain it to the session-name pattern with an optional numeric suffix in code and schema.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] A decision on managed settings and per-session settings is recorded and implemented or declined with a reason.
- [ ] A starting entry is reconciled to its registry name on the next up or status.
- [ ] A roster name outside the pattern is rejected on read and in the schema, with tests.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
