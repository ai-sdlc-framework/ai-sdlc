---
id: AISDLC-651.1
title: >-
  RFC-0050 follow-up: doctor reads capability state from artifacts only, CSV formula escaping, README event list
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - usage-ledger
  - cli
dependencies:
  - AISDLC-651
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - orchestrator/src/cli/commands/doctor-checks.ts
priority: low
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Three reviewer minors on AISDLC-651.

## Scope
1. The doctor usage-ingest line reads `_capabilities/state.json` from the resolved
   artifacts directory only, never from a path that could be committed in the repo.
2. CSV output escapes cells that start with `=`, `+`, `-` or `@` so a spreadsheet
   does not evaluate them.
3. The README names exactly the limit events that emit `AllotmentChangeSuspected`.

## Acceptance Criteria
- [ ] A committed copy of `state.json` under the repository is ignored by the doctor line (test with both present).
- [ ] CSV cells beginning with any of the four characters are prefixed so they are inert, and round-trip through a CSV parser unchanged otherwise.
- [ ] The README's event list matches the emitting code (asserted by a test that greps both).
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
