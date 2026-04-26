---
id: AISDLC-69
title: 'RFC documentation drift detection: enforce docs published per RFC'
status: To Do
assignee: []
created_date: '2026-04-26 19:21'
labels:
  - docs
  - infrastructure
  - rfc-process
dependencies: []
references:
  - /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/spec/rfcs/
  - >-
    /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/spec/rfcs/RFC-0006-design-system-governance-v5-final.md
  - /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/spec/rfcs/README.md
  - /Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/docs/
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0006 (Design System Governance) was published as a normative spec without corresponding user-facing documentation. This is a recurring failure mode — RFCs land in `spec/rfcs/` and are considered "done" before consumer-facing docs exist, leaving operators and integrators without guidance.

The drift surfaces in two directions:

1. **Spec-without-docs:** RFC published; no entry in `ai-sdlc/docs/` or `ai-sdlc-io/content/`. Consumers find the spec but have no implementation guide, no examples, no troubleshooting.
2. **Docs-without-spec:** Doc references behavior not normatively specified anywhere. Less common but harder to diagnose.

Need automated drift detection at the spec/docs boundary, surfaced at PR review time so RFCs cannot merge without their docs landing in the same change (or with explicit sign-off that docs will follow within a tracked deadline).

Detection mechanism:

- For each `spec/rfcs/RFC-NNNN-*.md` with status Approved or Implemented, verify at least one corresponding doc page exists matching a documented naming convention (e.g., `docs/rfcs/RFC-NNNN.md`, `docs/operations/<feature>.md`, or a tutorial referencing the RFC by number).
- Convention: each RFC declares its required doc surfaces in front-matter (e.g., `requiresDocs: [tutorial, operator-runbook, api-reference]`); CI verifies each named surface contains an RFC-NNNN reference.
- For RFC-0006 specifically, retroactively author the missing docs OR mark explicit deferred-docs status so the new check doesn't immediately fail on RFC-0006.

Scope includes: defining the front-matter convention, the CI check, retroactive RFC-0006 docs (or deferred-docs marker), and the operator process for "an RFC is approved — what docs must I write before merge."

Out of scope: solving the broader documentation consolidation problem (separate task: docs consolidation ai-sdlc/docs ↔ ai-sdlc-io/content).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 RFC front-matter convention defined for declaring required doc surfaces (`requiresDocs:` field with enum of surface types)
- [ ] #2 RFC-0001-template.md updated to include the new front-matter field with explanation
- [ ] #3 CI check implemented that fails the build when an Approved/Implemented RFC's required doc surfaces are missing or contain no reference to the RFC number
- [ ] #4 Existing RFCs (0002–0010) audited for required docs; gaps captured as follow-up tasks
- [ ] #5 RFC-0006 either receives retroactive docs OR is marked with explicit deferred-docs status with deadline
- [ ] #6 Operator process documented: how to plan doc work alongside RFC authoring (probably in spec/rfcs/README.md)
- [ ] #7 First new RFC after this lands successfully exercises the check (drives docs to completion before merge)
<!-- AC:END -->
