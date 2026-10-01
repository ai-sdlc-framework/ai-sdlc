---
id: AISDLC-659
title: >-
  RFC-0050 Part A: model price feed (price sources, daily refresh, dated price history, validation)
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - usage-ledger
  - pricing
  - cost
dependencies:
  - AISDLC-648
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - orchestrator/src/defaults.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/orchestrator/events.ts
  - spec/schemas/orchestrator-events.v1.schema.json
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Per-token prices for input, output and cache differ by model and change over time, and
new models arrive with their own. The repo's hand-maintained table had drifted by
2026-09-30: one listed price was out of date and the three models carrying most of
this repo's usage had no row. This task keeps prices current by pulling them from
published sources into the price history from AISDLC-648. RFC-0050 section A6.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- HTTP goes through an injectable `fetch`; tests never touch the network and never read
  the real home directory.
- Fetched price data is untrusted input. It is validated before use and never
  evaluated or interpolated into a command.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **`PriceSource` interface** in `reference/src/usage/`: `name`, and `fetchPrices()`
   returning rows of model id and per-million-token prices for input, output, cache
   read, 5-minute cache write and 1-hour cache write, each with the source URL and
   fetch time. A class a source does not publish is left undefined, not zero.
2. **Two adapters**, each with recorded synthetic fixtures of its response shape:
   - the OpenRouter models endpoint, whose entries carry a `pricing` object with
     per-token string values for `prompt`, `completion`, `input_cache_read`,
     `input_cache_write` and `input_cache_write_1h`;
   - the LiteLLM price file, whose entries carry `input_cost_per_token`,
     `output_cost_per_token`, `cache_read_input_token_cost`,
     `cache_creation_input_token_cost` and `cache_creation_input_token_cost_above_1hr`.
   Both convert to per-million-token numbers and map provider-prefixed ids to the
   exact model ids that appear in the usage ledger through an explicit alias map.
3. **Provider-native sources:** for each provider whose models appear in the usage
   ledger, check whether it offers a machine-readable price endpoint. Where one
   exists, add an adapter and give it precedence over the aggregators. Record the
   result of that check, per provider, in the module's header comment.
4. **Refresh** `cli-usage prices refresh [--source <name>] [--json]`: fetches from every
   configured source, validates, and appends changed prices to the price history with
   `effectiveFrom` set to the fetch date. Unchanged prices write nothing. The
   orchestrator tick runs it at most once per calendar day. It sends no repository
   data in any request.
5. **Validation and `held` rows:** reject a row with a zero, negative or non-numeric
   price. Record a row as `held` when sources disagree on a price by more than the
   configured tolerance (default 5 percent), or when a price differs from the last
   active row by more than the configured factor (default 3 times). `cli-usage prices
   confirm <model>` promotes a held row to active; `cli-usage prices set` writes a
   `manual` row.
6. **`cli-usage prices list`** shows, per model, the active prices, their source and
   age, and any held row.
7. **Staleness and capability:** when every source fails, keep the last prices and mark
   them stale after the configured number of days (default 14); reports that use stale
   prices say so. Report the `pricing.feed` capability as `live` after a successful
   refresh and `degraded` with a reason otherwise, when the capability registry is
   present.
8. **Event:** emit `ModelPriceChanged` with model, token class, old and new price when
   an active price changes. Add it to the event type union and the events schema.

## Acceptance Criteria
- [x] Each adapter turns its recorded fixture into rows with all five token classes in per-million-token units, leaving an unpublished class undefined.
- [x] A refresh with unchanged prices appends nothing; a changed price appends one row with the fetch date as `effectiveFrom` and emits `ModelPriceChanged`.
- [x] A call made before a price change is priced with the old row and a call made after it with the new one.
- [x] A zero, negative or non-numeric price is rejected and does not reach the history.
- [x] Two sources disagreeing beyond the tolerance, and a price moving beyond the change factor, each produce a `held` row that `priceCall` ignores until `prices confirm` is run.
- [x] A `manual` row takes precedence over a fetched active row for the same model and date.
- [x] With every source failing, the last prices remain in force, the refresh exits without throwing, and prices older than the staleness limit are labelled stale in `prices list`.
- [x] No request made by any adapter contains a repository name, path, task id or token count (asserted on the recorded request in a test).
- [x] The module header records, per provider, whether a provider-native price endpoint was found.
- [x] `ModelPriceChanged` validates against the updated events schema.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
