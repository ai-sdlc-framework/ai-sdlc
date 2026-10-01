---
id: AISDLC-631.2
title: >-
  RFC-0049 follow-up: cli-judgment view of shadow outcomes against the incumbent decision
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - judgment-layer
  - cli
dependencies:
  - AISDLC-631
  - AISDLC-632
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
priority: low
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Reviewer minor on AISDLC-631: the judgment log records the incumbent decision beside
each `shadow` outcome, but nothing summarises agreement, so an operator reading for a
promotion has to compute it by hand.

## Scope
Add `cli-judgment shadow <judgment-id> [--since]`: per judgment, the count of shadow
records with an incumbent, the agreement rate between what `compose` would have
decided and the incumbent, and the confusion table where decisions are enumerable.
Reuse the `replay` machinery; no provider calls.

## Acceptance Criteria
- [ ] For a fixture log with known agreements, the command prints the hand-computed agreement rate and counts.
- [ ] Records without an incumbent are counted separately and excluded from the rate.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
