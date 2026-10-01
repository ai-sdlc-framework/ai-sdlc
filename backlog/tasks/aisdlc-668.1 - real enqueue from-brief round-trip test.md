---
id: AISDLC-668.1
title: >-
  RFC-0051: real cli-dispatch enqueue --from-brief round-trip for dispatch briefs
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - dispatch
dependencies:
  - AISDLC-668
  - AISDLC-665
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - pipeline-cli/src/hierarchy/brief.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The brief block contract is only tested through the shared brief parser because the dispatch enqueue command was not available when briefs landed. Once it exists, make enqueue import the shared parser from the hierarchy barrel instead of re-parsing, add the real round-trip test (brief to enqueue to manifests carrying the same after, sequenceGroup, wave and priority), and cross-check that every after id in a block is in the block or already done.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] The enqueue command reads a brief through the shared parser, with no second parser.
- [ ] A generated brief enqueues into manifests with the same after, sequenceGroup, wave and integer priority values, in a test.
- [ ] An after id that is neither in the brief nor completed is reported.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
