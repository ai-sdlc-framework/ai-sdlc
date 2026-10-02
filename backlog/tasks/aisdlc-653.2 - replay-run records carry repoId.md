---
id: AISDLC-653.2
title: >-
  RFC-0050 follow-up: replay-run usage records carry repoId instead of a name-only record
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - rfc-0050
  - usage-ledger
  - model-routing
dependencies:
  - AISDLC-653.1
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/usage/replay-run.ts
  - pipeline-cli/src/usage/repo-id.ts
  - pipeline-cli/src/usage/scorecard-sources.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Known gap left open by AISDLC-653.1 (PR #1150): `recordModelCall` in
`pipeline-cli/src/usage/replay-run.ts` still writes name-only records, which the
ledger treats as legacy and labels. The scorecard skips replay task ids today, but
AISDLC-656.1 judges reviewer candidates on replay results bound to `repoId`, so
replay records need the same stable identity before AISDLC-656.2 applies evidence to
routing. Operator-approved filing, 2026-10-02.

## Conventions
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Do not edit
  its Open Questions.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- The ledger stores counts, ids and attribution only. Fixtures are synthetic. Tests
  never read the real home directory (`AI_SDLC_USAGE_DIR` on a `mkdtemp` directory).

## Scope
1. Replay runs compute `repoId` once per working directory through the same
   `repo-id.ts` path the ingesters use and stamp it on every record they write; when
   it cannot be computed they stamp `repoIdUnavailable: true`, never a bare record.
2. The replay results file carries the `repoId` the run was bound to.
3. `cli-usage report` and the scorecard sources select replay records by `repoId` like
   every other record; the name-only fallback no longer applies to replay task ids.

## Acceptance Criteria
- [ ] A replay run in a repository with an origin writes records carrying that repository's `repoId`; a run where the id cannot be computed writes `repoIdUnavailable: true`.
- [ ] The results file names the `repoId`; a results file from another `repoId` is ignored by the scorecard sources.
- [ ] No replay record written by the new code is counted as legacy by `cli-usage report`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
