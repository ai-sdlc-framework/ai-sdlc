---
id: AISDLC-657
title: >-
  RFC-0050 docs: operator runbook for the usage ledger, allotment tracking and model routing
status: To Do
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
- [ ] `docs/operations/usage-ledger.md` exists, cites `RFC-0050`, states plainly that no content is stored, and documents every `cli-usage` subcommand that exists at the time of writing.
- [ ] `docs/operations/model-routing.md` exists and states the eligibility rules, the 30-task and 5-point defaults, that silence leaves the table unchanged, and that overrides can only select a stronger model.
- [ ] Every command shown runs as written against the shipped CLI.
- [ ] Both documents are linked from `docs/operations/README.md`, and the burn-tracking section of the billing document points to them.
- [ ] `deferredDocs` and `deferredDocsDeadline` are removed from the RFC frontmatter and `node scripts/check-rfc-docs.mjs` passes.
- [ ] Neither document contains internal task ids.
- [ ] `pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
