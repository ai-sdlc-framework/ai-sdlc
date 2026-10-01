---
id: AISDLC-670
title: >-
  RFC-0051 docs: operator runbook for the session hierarchy; execute-parallel marked superseded
status: To Do
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0051
  - docs
  - adopter
dependencies:
  - AISDLC-666
  - AISDLC-667
references:
  - spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md
  - docs/operations/parallel-dispatch.md
  - docs/operations/README.md
  - docs/operations/dispatched-session-decisions.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-facing documentation for RFC-0051. The RFC declares
`requiresDocs: [operator-runbook]` with `deferredDocs: true`; this task satisfies the
requirement and removes the deferral.

## Scope
1. **`docs/operations/session-hierarchy.md`:** the three tiers and their authority;
   `cli-hierarchy up/status/down/clear/brief` with examples; the roster; the board
   fields and how sequence groups work; the executor and dispatch loops; the
   escalation chain, timeboxes and where the operator is asked; context clearing and
   why executors stay interactive; the permission modes per tier and the
   `crossSessionInbound` setting; the governance values (`allowForcePush:
   leaseOnOwnBranch`, `operational`); a troubleshooting table (held messages, name
   collisions, stale parent checkout, stuck clear). It cites RFC-0051 by id.
2. **`docs/operations/parallel-dispatch.md`:** add a note at the top that
   `execute-parallel` is superseded by the hierarchy for sustained runs and remains
   for one-off bursts; link the new document.
3. **Index:** link the new document from `docs/operations/README.md`.
4. **RFC frontmatter:** remove `deferredDocs` and `deferredDocsDeadline` from
   `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md`. Change nothing else.

## Acceptance Criteria
- [ ] `docs/operations/session-hierarchy.md` exists, cites `RFC-0051`, and covers every item in scope 1.
- [ ] Every command shown runs as written against the shipped CLI.
- [ ] `parallel-dispatch.md` carries the superseded note and the link; `README.md` links the new document.
- [ ] `deferredDocs` and `deferredDocsDeadline` are removed from the RFC frontmatter and `node scripts/check-rfc-docs.mjs` passes.
- [ ] The document contains no internal task ids.
- [ ] `pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
