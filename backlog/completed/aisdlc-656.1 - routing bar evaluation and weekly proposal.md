---
id: AISDLC-656.1
title: >-
  RFC-0050 OQ-3 part 1: routing bar evaluation, cli-usage route propose, additive table fields and the weekly tick hook
status: Done
assignee:
  - dispatch-executor-alpha
created_date: '2026-10-02'
labels:
  - rfc-0050
  - model-routing
  - decisions
  - orchestrator
dependencies:
  - AISDLC-653.1
  - AISDLC-654
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/bin/cli-decisions.mjs
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/usage/scorecard-commands.ts
  - pipeline-cli/src/usage/replay-run.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
First of three parts of AISDLC-656 (operator-approved split, 2026-10-02). This part
is the evidence-to-proposal half: it decides which cells qualify for a cheaper model
and files the weekly proposal Decision. Applying an approved proposal is AISDLC-656.2;
automatic revert and strength-only overrides are AISDLC-656.3.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`, section B5
  and the OQ-3 resolution. Do not edit the RFC's Open Questions. If the RFC and this
  task disagree, stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- The ledger stores counts, ids and attribution only. No prompt, response, file content
  or tool output is ever written, logged or put in a fixture. Fixtures are synthetic.
- Tests never read the real home directory: every path is injected or taken from
  `AI_SDLC_USAGE_DIR` pointing at a `mkdtemp` directory.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.
- Evidence records that carry `legacyRecords > 0` or `repoIdUnavailable` counts above
  zero, or that lack the counts, never qualify a candidate. Replay results are bound to
  the resolved `repoId`.

## Scope
1. **Bar evaluation** `evaluateCell(cell, scorecard, config)`: a candidate qualifies
   for a developer role when it has at least `minTasks` compared tasks (default 30)
   and its first-pass approval rate is no more than `marginPoints` (default 5) below
   the cell's current model over the same period. For a reviewer role the inputs are
   replay results: recall no more than `marginPoints` lower and false-block rate no
   more than `marginPoints` higher, on at least `minTasks` items. A candidate that is
   not cheaper than the current model at current prices (the price history's active
   rows, through the unit weights) never qualifies. Malformed scores fail closed.
2. **Weekly proposal:** `cli-usage route propose` evaluates every cell. When at least
   one candidate qualifies it files a single Decision through the Decision Catalog
   library listing every qualifying change with its counts, rates and the evidence
   files written by the scorecard. The proposal also lists, as information only, any
   cell whose previously applied change is no longer cheaper at current prices. At
   most one open proposal Decision exists at a time; with nothing qualifying it files
   nothing and says so.
3. **Additive table fields:** `.ai-sdlc/model-routing.yaml` cells accept the fields
   part 2 will write (evidence reference, previous model) without changing the
   resolver's behaviour when they are absent.
4. **Weekly tick hook:** the orchestrator tick (`pipeline-cli/src/orchestrator/loop.ts`)
   runs the proposal once per calendar week.
5. **Silence means no change:** an unanswered proposal Decision changes nothing, and a
   new proposal is not filed while it is open.

## Acceptance Criteria
- [x] A candidate with 30 compared tasks and an approval rate 4 points below the current model qualifies; one with 29 tasks, or 6 points below, does not.
- [x] A reviewer candidate is judged on replay recall and false-block rate with the same margin and minimum count.
- [x] A candidate that is not cheaper than the current model at current prices is never proposed.
- [x] Evidence with legacy or repoId-unavailable records, or without those counts, never qualifies a candidate; replay evidence from another repoId is ignored.
- [x] `route propose` files exactly one Decision listing all qualifying cells, files none when nothing qualifies, and files none while a proposal Decision is open.
- [x] The tick runs the proposal once per calendar week and not again in the same week.
- [x] The additive table fields parse and are ignored by the resolver when absent.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
