---
id: AISDLC-678
title: >-
  RFC-0052 docs: operator runbook for the staged reviewer set, its config, the comparison and the switches
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0052
  - docs
  - adopter
dependencies:
  - AISDLC-676
references:
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - spec/rfcs/RFC-0052-staged-review-pipeline.md
  - docs/operations/cross-harness-review.md
  - docs/operations/reviewer-dispatch-defaults.md
  - docs/operations/README.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
User-facing documentation for RFC-0052. The RFC declares
`requiresDocs: [operator-runbook]` with `deferredDocs: true`; this task satisfies the
requirement and removes the deferral.

## Scope
1. **`docs/operations/staged-review.md`:** the six stages and what each may and may
   not do; the baseline checklist; the plan and evidence schemas; the executor command
   allowlist and other `staged.*` config keys; the routing cells and default models;
   how to enable shadow, read `cli-reviews compare`, interpret flagged cases, and run
   the replay; the two switches (code and test reviewers, then security) and their
   bars; attestation leaves per stage; a troubleshooting table. It cites RFC-0052 by
   id.
2. **Existing docs:** add a staged-set paragraph to
   `docs/operations/reviewer-dispatch-defaults.md` and a pointer in
   `docs/operations/cross-harness-review.md` for probes on Codex.
3. **Index:** link the new document from `docs/operations/README.md`.
4. **RFC frontmatter:** remove `deferredDocs` and `deferredDocsDeadline` from
   `spec/rfcs/RFC-0052-staged-review-pipeline.md`. Change nothing else.

## Acceptance Criteria
- [ ] `docs/operations/staged-review.md` exists, cites `RFC-0052`, and covers every item in scope 1.
- [ ] Every command shown runs as written against the shipped CLIs.
- [ ] The two existing documents carry their additions and `README.md` links the new document.
- [ ] `deferredDocs` and `deferredDocsDeadline` are removed from the RFC frontmatter and `node scripts/check-rfc-docs.mjs` passes.
- [ ] The document contains no internal task ids.
- [ ] `pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
