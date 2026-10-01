---
id: AISDLC-668.3
title: >-
  RFC-0051: supervised check that brief notify reaches a live dispatch session
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
The notify command types a one-line message into the dispatch session pane with tmux send-keys. This has not been tried against a live Claude Code session; if the session is mid-turn the line may queue or interleave. Check it in the first supervised run and record the result.

Design source: `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Do not edit that RFC's Open Questions.

## Acceptance Criteria
- [ ] A notify to a live idle dispatch session is received as one prompt.
- [ ] Behaviour when the session is mid-turn is recorded, with a change to the delivery if it interleaves.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
