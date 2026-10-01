---
id: AISDLC-657
title: >-
  RFC-0050 docs: operator runbook for the usage ledger, allotment tracking and model routing
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - docs
  - adopter
dependencies:
  - AISDLC-651
  - AISDLC-654
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - docs/operations/billing-and-cost-optimization.md
  - docs/operations/README.md
  - docs/operations/doctor.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-facing documentation for RFC-0050. The RFC declares
`requiresDocs: [operator-runbook]` with `deferredDocs: true`; this task satisfies the
requirement and removes the deferral.

## Scope
1. **`docs/operations/usage-ledger.md`:** what is recorded and what is never recorded;
   where the ledger lives; the two scopes and what `other` omits; how to restrict
   ingestion to framework repositories; ingestion triggers and the backfill command;
   every `cli-usage` report and view with an example; weighted units and why they are
   a proxy; taking snapshots and reading the allotment series; limit events; a
   troubleshooting table. It cites RFC-0050 by id.
2. **`docs/operations/model-routing.md`:** the table format; the resolver order; what
   exploration does, who is eligible and who never is; the assignment log; scorecards
   and what `insufficient` means; reviewer replay with its budget flags; the weekly
   proposal, how to approve it and what silence does; automatic reverts and the
   strength-only rule; how to turn exploration off (remove `candidates`).
3. **Existing doc:** in `docs/operations/billing-and-cost-optimization.md`, replace the
   "Track your burn" pattern's content with a pointer to the usage ledger commands.
   Edit that section in place.
4. **Index:** link both new documents from `docs/operations/README.md`.
5. **RFC frontmatter:** remove `deferredDocs` and `deferredDocsDeadline` from
   `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Change nothing else in the
   RFC.

## Acceptance Criteria
- [x] `docs/operations/usage-ledger.md` exists, cites `RFC-0050`, states plainly that no content is stored, and documents every `cli-usage` subcommand that exists at the time of writing.
- [x] `docs/operations/model-routing.md` exists and states the eligibility rules, the 30-task and 5-point defaults, that silence leaves the table unchanged, and that overrides can only select a stronger model. (Met for what ships. The weekly proposal, approval, silence and automatic revert behaviour is written as a labelled "not yet available" section with no runnable command, because that feature has not shipped; the 30-task and 5-point defaults and the rules are stated there.)
- [x] Every command shown runs as written against the shipped CLI. (Met, with one limit: placeholders such as task ids are shown as arguments, and a real `replay` run that spends model usage is described in prose with no output.)
- [x] Both documents are linked from `docs/operations/README.md`, and the burn-tracking section of the billing document points to them.
- [x] `deferredDocs` and `deferredDocsDeadline` are removed from the RFC frontmatter and `node scripts/check-rfc-docs.mjs` passes.
- [x] Neither document contains internal task ids.
- [x] `pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added the operator runbooks for the usage ledger and model routing, pointed the burn-tracking pattern at them, linked both from the operations index, and removed the documentation deferral from RFC-0050. Every command and output shown was run against the shipped CLI in a scratch environment with synthetic data.

## Changes
- `docs/operations/usage-ledger.md` (new): what is and is not recorded, where the ledger lives, the two scopes, ingestion triggers and backfill, every `cli-usage` subcommand with examples, weighted units, snapshots and the allotment series, limit events, the price feed, the usage config, the TUI pane and a troubleshooting table.
- `docs/operations/model-routing.md` (new): the table format, resolver order, exploration and eligibility, the assignment log, scorecards, reviewer replay with its budget and spend flags and sandbox limits, and a labelled "not yet available" section.
- `docs/operations/billing-and-cost-optimization.md`: the "Track your burn" pattern now points at the usage commands.
- `docs/operations/README.md`: links to both documents.
- `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`: removed `deferredDocs` and `deferredDocsDeadline` only.

## Design decisions
- The weekly proposal, its approval, silence leaving the table unchanged, automatic reverts and the strength-only override file belong to a feature that has not shipped, so they are documented as planned behaviour with the rules stated and no runnable command. Nothing writes the overrides file today, and the document says so.
- The resolver and the scorecard use different default artifact directories today; the documents tell operators to set `ARTIFACTS_DIR` so they agree, and a follow-up aligns the defaults in code.
- The documents state the real limits of the replay sandbox: it is the CLI's permission layer plus a throwaway clone, not an operating-system sandbox, and user-level settings still load.

## Verification
- `node scripts/check-rfc-docs.mjs`, `pnpm docs:test`, `pnpm rfc:test`, `pnpm rfc:check`, `pnpm test:adopter-facing-strings` — passed
- `pnpm lint` and prettier on the touched files — passed
- Not verified by running: a real replay with spend confirmed, the hook triggers, and the confirm path for a held price row
- 3 parallel reviews approved after two rounds (Claude-native reviewers); reviewer leaves carry no transcript binding because the session produced no subagent start markers

## Follow-up
- AISDLC-657.1: replace the "not yet available" section in `docs/operations/model-routing.md` with real commands once the proposal feature ships.
- AISDLC-657.2: align the default artifacts directory between the resolver and the scorecard and replay commands.
<!-- SECTION:FINAL_SUMMARY:END -->
