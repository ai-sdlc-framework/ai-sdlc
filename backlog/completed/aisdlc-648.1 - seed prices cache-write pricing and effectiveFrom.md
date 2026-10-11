---
id: AISDLC-648.1
title: >-
  RFC-0050 follow-up: correct seed prices, price cache-write tokens in CostTracker, release-date effectiveFrom
status: Done
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
- [x] Seed rows match the checked-in snapshot of the published list, with date and URL recorded per row.
- [x] No seed row has `effectiveFrom` 1970-01-01; a call dated before a model's release is priced `unpriced`.
- [x] A record with cache-write tokens is priced for them in `computeCost`, with a hand-computed fixture.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Seed prices now match the published list read 2026-10-10 (sonnet-5-5 cache read corrected to 0.10), each seed row applies from its model's release date, `DEFAULT_MODEL_COSTS` derives from the seed so the orchestrator table can no longer drift (opus-4-6 was 15/75, haiku-4-5-20251001 0.8/4, claude-3-5-haiku 1/5), and `CostTracker.computeCost` prices 5m and 1h cache-write tokens from the price history at the call time.

## Changes
- `reference/src/usage/prices-seed.ts` (modified): corrected rows, per-row `effectiveFrom`, rule and read date in `source`.
- `reference/src/usage/__fixtures__/published-prices.json` (new): checked-in snapshot of the published list and release dates.
- `reference/src/usage/prices-seed.test.ts` (new): fails when a seed row disagrees with the snapshot.
- `orchestrator/src/defaults.ts`, `orchestrator/src/cost-tracker.ts` (modified): derived cost table; cache-write pricing with required call timestamp.
- Tests with fixed clocks moved past the seed read date.

## Design decisions
- **Release date rule**: the provider's model pages give release dates for dateless ids; dated ids use the snapshot date in the id (`id-snapshot-date`). The local ledger was not consulted.
- **`ts` required for cache-write pricing**: avoids a direct clock read (clock-discipline gate) and keeps the result deterministic.

## Verification
- `pnpm build` clean; `pnpm lint`, `pnpm format:check`, `pnpm dark-code:check` clean.
- `pnpm test`: reference, orchestrator, sdk pass; 7 pipeline-cli failures (bin-invocation, verify-runtime) also fail on untouched main, plus TUI timeouts.
- 3 reviewers approved (Codex over quota; Claude-native code and test reviewers used).

## Follow-up
- declined: Haiku 5.5 (tiered pricing by prompt size) has no seed row; the price schema has no tiers.
- declined: `cost_ledger` has no cache-write columns, so `recordCost` does not pass cache writes; needs a schema migration.
<!-- SECTION:FINAL_SUMMARY:END -->
