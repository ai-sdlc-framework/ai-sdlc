---
id: AISDLC-659.1
title: >-
  RFC-0050 follow-up: hold a fetched price that drifts from the seed/manual row or the 30-day median, not only the last row
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - usage-ledger
  - pricing
  - security
dependencies:
  - AISDLC-659
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
priority: low
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Security finding on AISDLC-659: a compromised single source can cut a price a little
under the change factor every day with no hold, because each fetch is compared only
with the previous row. Low until budget enforcement reads prices.

## Scope
Hold a fetched row when it differs by more than the configured factor from any of:
the previous active row, the last `manual` or seed row for that model, or the trailing
30-day median of active rows. Report which comparison triggered the hold.

## Acceptance Criteria
- [ ] A series of daily fetches each 2.5x below the previous row is held at the fetch that crosses the factor against the seed row or the median, with the triggering comparison named.
- [ ] A single legitimate change within the factor against all three references is accepted.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
