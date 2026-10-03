---
id: AISDLC-656.2
title: >-
  RFC-0050 OQ-3 part 2: cli-usage route apply turns an approved proposal Decision into a routing-table pull request
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - rfc-0050
  - model-routing
  - decisions
  - orchestrator
  - trust-sensitive
dependencies:
  - AISDLC-656.1
  - AISDLC-653.2
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/bin/cli-decisions.mjs
  - pipeline-cli/src/usage/scorecard-commands.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Second of three parts of AISDLC-656 (operator-approved split, 2026-10-02). Part 1
(AISDLC-656.1) files the proposal; this part applies an approved one. A cheaper model
needs approval, so this is the only path that changes the routing table, and it is
trust-sensitive: the security reviewer runs on Opus.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`, section B5
  and the OQ-3 resolution. Do not edit the RFC's Open Questions. If the RFC and this
  task disagree, stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- No prompt, response, file content or tool output is written, logged or put in a
  fixture. Fixtures are synthetic. Tests never read the real home directory.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Security requirements (from the part 1 review)
- Never trust the Decision body, `source` or `by`: they are plain files anyone with
  write access can edit. The command re-derives the evidence at apply time for the
  resolved `repoId` and refuses when the re-derived result no longer qualifies.
- Evidence files named in the Decision are hash-bound: the Decision carries their
  digests and apply refuses on mismatch.
- `runId` and model names are validated against the same grammar the ledger uses
  before they are written into YAML, branch names, commit messages or the PR body.
- Only answers recorded locally by the operator through the Decision Catalog answer
  path count as approval; an answer field merely present in the file does not.
- Nothing under `.ai-sdlc/` is written on the base branch.

## Scope
1. **Apply:** `cli-usage route apply --decision <id>` reads an answered proposal
   Decision and, for each approved change, edits `.ai-sdlc/model-routing.yaml` on a
   new branch: the cell model, the evidence reference, and the previous model
   recorded for revert. It commits the evidence files and opens a pull request whose
   body lists each change with its counts and rates.
2. **Refusals:** unanswered or declined Decision; a Decision that is not a proposal;
   evidence hash mismatch; evidence that no longer qualifies on re-derivation; a dirty
   working tree. Each refusal exits non-zero with a one-line reason and changes nothing.
3. **Partial approval:** a Decision whose answer approves a subset applies only that
   subset and records the declined cells as information in the PR body.
4. **Aliases by default (operator ruling, 2026-10-03).** Routing cells name a model
   family alias (`sonnet`, `opus`, `haiku`) so a role follows new releases; a versioned
   id is written only on request. When the table's cell or `strength` uses aliases,
   `apply` writes the family alias of the approved model, derived from the versioned id
   in the evidence, and refuses with a one-line reason when the id maps to no known
   family. `--pin` writes the versioned id as given and adds it to `strength` next to
   its family alias. Evidence rows recorded under a versioned id and rows recorded
   under the alias of the same family are treated as the same model when the cell is an
   alias, and the PR body says which ids were merged.

## Acceptance Criteria
- [ ] With an alias table, an approved change whose evidence names a versioned id writes the family alias into the cell and leaves `strength` unchanged; with `--pin` it writes the versioned id and adds it to `strength`.
- [ ] A versioned id that maps to no known family is refused with a one-line reason and nothing is changed.
- [ ] `route apply` on an approved Decision produces a branch whose only changes are the table cells, their evidence references and the evidence files.
- [ ] On an unanswered or declined Decision it changes nothing and exits non-zero.
- [ ] A Decision whose evidence file digest does not match, or whose evidence no longer qualifies when re-derived, is refused with nothing written.
- [ ] A Decision with a hand-edited `by`, `source` or answer field that was not recorded through the catalog answer path is refused.
- [ ] A `runId` or model name outside the ledger grammar is refused before any write.
- [ ] A subset approval applies only the approved cells.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
