---
id: AISDLC-653.1
title: >-
  RFC-0050 follow-up: record a stable repoId at ingest and match scorecards on it
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - usage-ledger
  - model-routing
  - security
dependencies:
  - AISDLC-649
  - AISDLC-653
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Security finding on AISDLC-653: a repository is matched by directory name only, so a
same-named checkout elsewhere on the machine can add task ids and units to this
repository's scorecard and to committed evidence files. Medium now; becomes blocking
before AISDLC-656 applies evidence to routing automatically.

## Scope
1. Additive ledger field `repoId`: the normalized `origin` remote URL (scheme and
   `.git` suffix stripped, lower-cased host) joined with the repository's root commit
   hash; computed once per working directory at ingest and cached.
2. Scorecards and evidence files select records by `repoId`, falling back to the
   directory name only for records that predate the field and saying so in the
   output.
3. `cli-usage report --repo` accepts either form and prints the `repoId` it resolved.

## Acceptance Criteria
- [ ] Two checkouts with the same directory name and different root commits produce records with different `repoId` values, and a scorecard for one contains nothing from the other.
- [ ] Records without `repoId` are included only under the legacy fallback and the report labels them.
- [ ] The ledger record schema accepts the new field and `pnpm validate-schemas` passes.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
