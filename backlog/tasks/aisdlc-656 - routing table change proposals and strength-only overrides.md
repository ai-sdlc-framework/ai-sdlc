---
id: AISDLC-656
title: >-
  RFC-0050 OQ-3: weekly downshift proposals as one Decision, approval to pull request, automatic revert to a stronger model
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - model-routing
  - decisions
  - orchestrator
dependencies:
  - AISDLC-653
  - AISDLC-654
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/bin/cli-decisions.mjs
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/orchestrator/events.ts
  - spec/schemas/orchestrator-events.v1.schema.json
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Closes the loop from evidence to routing under the asymmetric rule the operator chose:
a cheaper model needs approval, a return to a stronger model after measured
inferiority is automatic. RFC-0050 section B5 and the OQ-3 resolution.

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
1. **Bar evaluation** `evaluateCell(cell, scorecard, config)`: a candidate qualifies
   for a developer role when it has at least `minTasks` compared tasks (default 30)
   and its first-pass approval rate is no more than `marginPoints` (default 5) below
   the cell's current model over the same period. For a reviewer role the inputs are
   replay results: recall no more than `marginPoints` lower and false-block rate no
   more than `marginPoints` higher, on at least `minTasks` items. A candidate that is
   not cheaper than the current model at current prices (the price history's active
   rows, through the unit weights) never qualifies as a downshift. The proposal also
   lists, as information only, any cell whose previously applied change is no longer
   cheaper at current prices.
2. **Weekly proposal:** `cli-usage route propose` evaluates every cell. When at least
   one candidate qualifies it files a single Decision through the Decision Catalog
   library listing every qualifying change with its counts, rates and the evidence
   files written by the scorecard. At most one open proposal Decision exists at a time.
   With nothing qualifying it files nothing and says so. The orchestrator tick
   (`pipeline-cli/src/orchestrator/loop.ts`) runs it once per calendar week.
3. **Approval:** `cli-usage route apply --decision <id>` reads an answered Decision
   and, for each approved change, edits `.ai-sdlc/model-routing.yaml` on a new branch
   (cell model, the evidence reference, and the previous model recorded for revert),
   commits the evidence files, and opens a pull request. It refuses when the Decision
   is unanswered or declined. It never edits the table on the base branch directly.
4. **Automatic revert:** `evaluateReverts` runs each tick. For a cell changed by an
   applied proposal, when its current model's first-pass approval rate over at least
   `minTasks` tasks since the change is more than `marginPoints` below the rate
   recorded in the evidence that justified the change, write an override for that cell
   to its previous model in `overrides.json` under the artifacts directory, emit
   `ModelRoutingOverrideApplied`, and file an informational Decision. Add the event to
   the event type union and the events schema.
5. **Strength-only:** the override writer refuses any override whose model is not
   stronger than the cell's table model in the table's `strength` order, and the
   resolver from AISDLC-654 ignores a non-conforming entry. An override stays until the
   table cell changes.
6. **Silence means no change:** an unanswered proposal Decision changes nothing, and a
   new proposal is not filed while it is open.

## Acceptance Criteria
- [ ] A candidate with 30 compared tasks and an approval rate 4 points below the current model qualifies; one with 29 tasks, or 6 points below, does not.
- [ ] A reviewer candidate is judged on replay recall and false-block rate with the same margin and minimum count.
- [ ] A candidate that is not cheaper than the current model is never proposed.
- [ ] `route propose` files exactly one Decision listing all qualifying cells, files none when nothing qualifies, and files none while a proposal Decision is open.
- [ ] `route apply` on an approved Decision produces a branch whose only changes are the table cells, their evidence references and the evidence files; on an unanswered or declined Decision it changes nothing and exits non-zero.
- [ ] A cell whose approval rate falls more than 5 points below its evidence rate over 30 tasks gets an override to its previous model, a `ModelRoutingOverrideApplied` event and an informational Decision.
- [ ] Writing an override to a weaker or equal model is refused, and a hand-edited weaker override is ignored by the resolver.
- [ ] An override is dropped once the table cell it covers changes.
- [ ] The new event validates against the updated events schema.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
