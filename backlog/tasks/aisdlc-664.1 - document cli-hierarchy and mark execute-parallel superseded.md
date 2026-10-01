---
id: AISDLC-664.1
title: >-
  RFC-0051: document cli-hierarchy in operations docs and mark execute-parallel as superseded
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
Add a cli-hierarchy section to the parallel dispatch operations docs (up, status, down, the roster file, the settings preflight) and mark the execute-parallel command as superseded by it, as the RFC specifies. Docs were left out of the bootstrap change to keep that change small.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] The operations docs describe cli-hierarchy up, status and down, the roster file location and the settings preflight.
- [ ] execute-parallel is marked superseded and points to cli-hierarchy.
- [ ] pnpm docs:check passes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
