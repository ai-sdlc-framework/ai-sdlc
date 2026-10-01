---
id: AISDLC-648.1
title: >-
  RFC-0050 follow-up: correct seed prices, price cache-write tokens in CostTracker, release-date effectiveFrom
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - usage-ledger
  - cost
dependencies:
  - AISDLC-648
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - orchestrator/src/cost-tracker.ts
  - orchestrator/src/defaults.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Reviewer findings on AISDLC-648: the seed rows disagree with the provider's published
list (opus-4-6 15/75 vs 5/25; haiku-4-5 0.8/4 vs 1/5; claude-3-5-haiku 1/5 vs 0.8/4);
`CostTracker` prices no cache-write tokens; seed rows carry `effectiveFrom`
1970-01-01, so every pre-seed call is priced at the current list. Must land before
AISDLC-653 scorecards are relied on.

## Scope
1. Correct every seed row against the provider's published price list on the day of
   the change, recording that date and the list URL in the row's `source`.
2. Set each seed row's `effectiveFrom` to the model's release date from the
   provider's model listing; where no date is available, the earliest timestamp of
   that model in the local ledger, and record which rule was used.
3. `CostTracker.computeCost` prices 5-minute and 1-hour cache-write tokens from the
   price history when the record carries them.
4. A test that fails when a seed row disagrees with a checked-in snapshot of the
   published list, so drift is visible in review.

## Acceptance Criteria
- [ ] Seed rows match the checked-in snapshot of the published list, with date and URL recorded per row.
- [ ] No seed row has `effectiveFrom` 1970-01-01; a call dated before a model's release is priced `unpriced`.
- [ ] A record with cache-write tokens is priced for them in `computeCost`, with a hand-computed fixture.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
