---
id: AISDLC-648
title: >-
  RFC-0050 Part A: usage ledger core (record schema, JSONL store, deduplication, direct reporter, price table)
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - usage-ledger
  - reference
  - schema
  - cost
dependencies: []
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - orchestrator/src/cost-tracker.ts
  - orchestrator/src/defaults.ts
  - reference/src/index.ts
  - reference/src/core/generated-schemas.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The framework's cost ledger is empty on the operator's machine because the framework
does not make the model calls on the dogfood path; the harness does (evidence in
RFC-0050 Motivation). This task builds the store that every source of usage will write
to: one normalized record per model call. RFC-0050 sections A1 and A5 (price table).

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- The ledger stores counts, ids and attribution only. No prompt, response, file content
  or tool output is ever written, logged or put in a fixture.
- Fixtures are synthetic. Never commit a real transcript or a real ledger file.
- Tests never read the real home directory: every path is injected or taken from
  `AI_SDLC_USAGE_DIR` pointing at a temporary directory created with `mkdtemp`.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **Record type and schema:** `ModelCallRecord` exactly as RFC-0050 section A1, in a
   new directory `reference/src/usage/`, re-exported from `reference/src/index.ts`, with
   `spec/schemas/model-call-record.v1.schema.json`. Register the schema with the AJV
   instance in `reference/src/core/validation.ts`, regenerate and commit
   `reference/src/core/generated-schemas.ts`, and run the full `reference` test suite.
2. **Store:** append-only JSONL, one file per calendar month of the call timestamp
   (`ledger-YYYY-MM.jsonl`), under a directory resolved as: explicit option, then env
   `AI_SDLC_USAGE_DIR`, then `.ai-sdlc/usage` under the user's home directory. Appends
   are line-atomic and safe under concurrent writers from several processes.
3. **Deduplication:** `appendModelCalls(records)` skips any record whose `callId` is
   already in the ledger and returns counts of written and skipped records. The
   known-id set is built from an index file kept beside the ledger and is rebuilt from
   the ledger files when missing or inconsistent.
4. **Cursors:** `readCursor(file)` and `writeCursor(file, offset)` backed by
   `cursors.json` in the usage directory, for incremental ingesters.
5. **Direct reporter:** `recordModelCall(partial)` for framework code that calls a
   model itself. It fills `harness: 'direct'`, generates a `callId` when the provider
   gives none, never throws, and swallows write failures.
6. **Reader:** `readModelCalls(filter)` streaming records by date range, with filters
   for model, agent role, scope, repo, task and billing pool.
7. **Price history:** an append-only `prices.jsonl` in the usage directory. Each row
   holds a model id, per-million-token prices for input, output, cache read, 5-minute
   cache write and 1-hour cache write, a `source`, a `url`, a `fetchedAt` time, an
   `effectiveFrom` date and a `status` (`active`, `held` or `manual`).
   `priceCall(record)` uses the row in effect at the call's timestamp, preferring
   `manual`, ignoring `held`, and returns a cost or the literal status `unpriced`; it
   never substitutes another model's price. Seed rows ship in code for every model id
   in the RFC-0050 Motivation tables and in `DEFAULT_MODEL_COSTS`, taken from the
   provider's published price list on the day of implementation with that date
   recorded. The feed that keeps the history current is AISDLC-659.
8. **`CostTracker.computeCost`** in `orchestrator/src/cost-tracker.ts`: remove the
   silent Sonnet fallback. An unknown model yields a zero cost and an explicit
   `unpriced` marker that callers and reports can see.

## Acceptance Criteria
- [x] `ModelCallRecord`, the store, the reader, `recordModelCall` and the price table exist under `reference/src/usage/` and are re-exported from `reference/src/index.ts`.
- [x] The record schema is registered with AJV, `generated-schemas.ts` is regenerated and committed, and `pnpm validate-schemas` passes.
- [x] Appending the same record twice writes it once; the second call reports one skipped.
- [x] Records land in the month file of their own timestamp, including a batch that spans a month boundary.
- [x] Deleting the index file and appending an already-present record still skips it.
- [x] Ten concurrent processes appending distinct records leave a ledger in which every line parses and no record is lost.
- [x] `recordModelCall` returns normally when the usage directory is unwritable.
- [x] `priceCall` returns `unpriced` for an unknown model and prices each token class separately for a known one, choosing the row in effect at the call's timestamp, preferring a `manual` row and ignoring a `held` one.
- [x] `CostTracker.computeCost` no longer prices an unknown model as Sonnet, and its existing tests for known models pass unchanged.
- [x] No test reads or writes under the real home directory.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
Added the RFC-0050 usage ledger core: the `ModelCallRecord` schema (registered with AJV, `generated-schemas.ts` regenerated), a monthly JSONL store with a cross-process claim-file lock and a rebuildable dedup index, cursors, a never-throwing direct reporter, a streaming reader, and a price history with seed rows and `priceCall`. `CostTracker.computeCost` no longer prices unknown models as Sonnet.

## Changes
- `reference/src/usage/*` (new): types, paths, fs-lock, store, reader, reporter, prices, prices-seed, barrel, tests
- `spec/schemas/model-call-record.v1.schema.json` (new), `reference/src/core/{validation,index,generated-schemas}.ts` (modified)
- `reference/src/index.ts` (modified): re-exports
- `orchestrator/src/cost-tracker.ts` (+test), `orchestrator/src/execute.ts` (modified): explicit unpriced marker

## Design decisions
- **Lock**: directory lock whose removal only happens under an O_EXCL claim file; no rename-back (third review round).
- **Prices**: fetched vs manual entry points split; all five prices must be finite and > 0.
- **Seed rows** apply from the epoch; later `prices.jsonl` rows supersede from their `effectiveFrom`.

## Verification
- `pnpm build` — clean
- reference suite 1486 passed; orchestrator suite 4794 passed
- `pnpm lint`, `format:check`, `validate-schemas`, `dark-code:check` — clean
- AC 11 (root `pnpm test`): not fully confirmed locally; 4 pipeline-cli `bin-invocation` tests also fail on clean origin/main and 3 `verify-runtime` tests fail only inside `.worktrees/`; CI to confirm
- 3 parallel reviews approved after 3 rounds

## Follow-up
- `DEFAULT_MODEL_COSTS` disagrees with the published list for opus-4-6, haiku-4-5, claude-3-5-haiku
- `CostTracker` does not price cache-write tokens
