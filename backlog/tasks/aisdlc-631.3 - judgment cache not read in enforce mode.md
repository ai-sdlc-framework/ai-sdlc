---
id: AISDLC-631.3
title: >-
  RFC-0049 follow-up (security medium): enforce-mode evaluations never read the content-addressed judgment cache
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0049
  - judgment-layer
  - security
dependencies:
  - AISDLC-631
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up filed from executor and reviewer reports on the parent task, approved by the
operator on 2026-10-01. The parent's conventions apply (strict TypeScript, ESM,
hermetic tests, no writes under `.ai-sdlc/` by the developer agent, no edits to RFC
Open Questions; stop with `prUrl: null` on a conflict with the RFC).

Security medium on AISDLC-631 (#1129): a cache entry under the artifacts directory can
be planted by any same-user process, and its key is derivable, so a planted entry
could decide an `enforce` outcome. Must land before any judgment is promoted to
`enforce` (AISDLC-641 step 6). Not blocking the parent's merge.

## Scope
In `evaluateJudgment`, skip cache reads whenever the effective mode is `enforce`; the
cache continues to serve `shadow` evaluations and `cli-judgment replay`. Writes may
continue in every mode. Record `cacheHit: false` with reason `enforce` on such records.
An HMAC-keyed cache is out of scope; note it as the escalation path if a later need
appears.

## Acceptance Criteria
- [ ] A planted cache entry with the derived key for a given state and question set does not change an `enforce` outcome (the provider is called and its answer used).
- [ ] The same entry is served on a `shadow` evaluation and on `replay`.
- [ ] The judgment-log record for an `enforce` evaluation shows `cacheHit` false with the reason.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
