---
id: AISDLC-664.4
title: >-
  RFC-0051: emit a HierarchySessionStarted event when cli-hierarchy starts a session
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
Emit the HierarchySessionStarted event named in the RFC schema-changes list each time up starts a session, and register its schema.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] up emits one event per started session with role, name, model and permission mode.
- [ ] The event schema is registered and pnpm validate-schemas passes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
