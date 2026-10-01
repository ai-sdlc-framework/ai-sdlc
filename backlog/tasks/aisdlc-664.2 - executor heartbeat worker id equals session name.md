---
id: AISDLC-664.2
title: >-
  RFC-0051: executor and dispatch loops set the heartbeat worker id to their session name
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
cli-hierarchy status and down join the inflight board to roster entries by matching the heartbeat worker id to the roster name. The executor loop and the operator-dispatch and planner skills do not exist yet; when they land they must write the heartbeat worker id equal to their session name, with a test that pins the contract end to end.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] An executor session writes a heartbeat whose worker id equals its session name.
- [ ] cli-hierarchy status shows that executor's inflight task and down returns its manifest to the queue, in one end-to-end test.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
