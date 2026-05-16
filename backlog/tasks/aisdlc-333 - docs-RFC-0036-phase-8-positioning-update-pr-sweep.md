---
id: AISDLC-333
title: 'docs: RFC-0036 Phase 8 — positioning update PR sweep (README + concepts + ai-sdlc-io)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-8
  - docs
  - positioning
dependencies: []
permittedExternalPaths:
  - '../ai-sdlc-io/'
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 8 of RFC-0036 §13. Positioning PR sweep applying the OQ-9 resolution ("Decision Engine" primary; spec-driven secondary) to top-level surfaces.

## Scope (OQ-9 positioning)

- README.md update: lead with "Decision Engine" framing; spec-driven secondary.
- `content/docs/concepts/` revision in `../ai-sdlc-io/` repo (requires `permittedExternalPaths`).
- Cross-references updated to match the new positioning hierarchy.

## Pre-work blocker

**Product Authority (Alex) sign-off on RFC-0036 OQ-9 positioning resolution** is required before merging this PR sweep. Without explicit Product sign-off, positioning changes risk shipping without strategic alignment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 RFC-0036 v0.2+ carries Product Authority (Alex) sign-off on the OQ-9 positioning resolution
- [ ] #2 README.md updated to lead "Decision Engine" framing
- [ ] #3 `content/docs/concepts/` revision in `../ai-sdlc-io/` matches new positioning
- [ ] #4 Cross-references updated for consistency
- [ ] #5 Spec-driven framing maintained as secondary (not deleted; just demoted from primary)
<!-- AC:END -->
