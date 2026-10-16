---
id: AISDLC-670
title: >-
  RFC-0051 docs: operator runbook for the session hierarchy; execute-parallel
  marked superseded
status: Done
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
  - docs/operations/README.md
  - docs/operations/dispatched-session-decisions.md
priority: medium
dispatchable: true
drift_log:
  - date: '2026-10-16'
    type: ref-deleted
    detail: 'Referenced file no longer exists: docs/operations/parallel-dispatch.md'
    resolution: flagged
drift_checked: '2026-10-16'
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
- [x] `docs/operations/session-hierarchy.md` exists, cites `RFC-0051`, and covers every item in scope 1.
- [x] Every command shown runs as written against the shipped CLI.
- [x] `parallel-dispatch.md` carries the superseded note and the link; `README.md` links the new document.
- [x] `deferredDocs` and `deferredDocsDeadline` are removed from the RFC frontmatter and `node scripts/check-rfc-docs.mjs` passes.
- [x] The document contains no internal task ids.
- [x] `pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
Added the operator runbook for the RFC-0051 session hierarchy, marked execute-parallel as superseded for sustained runs, linked the runbook from the operations index, and removed the RFC's deferred-docs fields.

## Changes
- `docs/operations/session-hierarchy.md` (new): tiers, cli-hierarchy commands, roster, board, loops, escalation, clearing, permission modes, governance values, troubleshooting.
- `docs/operations/parallel-dispatch.md` (modified): superseded note linking the runbook.
- `docs/operations/README.md` (modified): index link.
- `spec/rfcs/RFC-0051-session-hierarchy-parallel-dispatch.md` (modified): removed deferredDocs and deferredDocsDeadline.

## Design decisions
- **Permission modes**: the runbook documents the shipped behaviour (every session starts in bypassPermissions, planner overridable), which differs from RFC wording; the RFC is untouched.

## Verification
- `pnpm build` and `pnpm test` — not run (docs-only change)
- `node scripts/check-rfc-docs.mjs` — passes
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
(none)
