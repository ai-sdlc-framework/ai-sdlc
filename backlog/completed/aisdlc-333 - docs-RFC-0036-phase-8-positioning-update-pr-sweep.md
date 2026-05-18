---
id: AISDLC-333
title: 'docs: RFC-0036 Phase 8 — positioning update PR sweep (README + concepts + ai-sdlc-io)'
status: Done
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
- [x] #1 RFC-0036 v0.2+ carries Product Authority (Alex) sign-off on the OQ-9 positioning resolution
- [x] #2 README.md updated to lead "Decision Engine" framing
- [x] #3 `content/docs/concepts/` revision in `../ai-sdlc-io/` matches new positioning
- [x] #4 Cross-references updated for consistency
- [x] #5 Spec-driven framing maintained as secondary (not deleted; just demoted from primary)
<!-- AC:END -->

## Final Summary

## Summary
Phase 8 of RFC-0036 positioning sweep shipped: "Decision Engine" is now the primary framing across all top-level surfaces; "for spec-driven AI workflows" is the consistent secondary descriptor. Product Authority (Alex) sign-off on OQ-9 is captured in the RFC.

## Changes
- `spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md` (modified): Product owner sign-off checkbox checked for OQ-9 positioning resolution; updated date
- `README.md` (modified): tagline updated to "The Decision Engine for spec-driven AI workflows"; "What this is" section leads with Decision Engine framing and adds spec-driven as secondary with funnel context and RFC-0036 cross-link
- `../ai-sdlc-io/content/docs/concepts/index.mdx` (modified): intro leads with Decision Engine / spec-driven framing; DoR gate promoted to first row in pillar table; "How these fit together" narrative updated to name DoR gate as the spec-driven seam entry point
- `../ai-sdlc-io/content/docs/concepts/meta.json` (modified): dor-gate moved to first position in pages array (after index) to front the Decision Engine pillar in navigation
- `../ai-sdlc-io/content/docs/index.mdx` (modified): concepts section description updated to lead with "Decision Engine" framing
- `../ai-sdlc-io/src/components/landing/hero.tsx` (modified): tagline updated to "for spec-driven AI workflows"; hero paragraph updated to "execution-and-governance half of a spec-driven development stack"
- `../ai-sdlc-io/content/docs/getting-started/index.mdx` (modified): "What is AI-SDLC?" intro updated to lead with Decision Engine + spec-driven positioning

## Design decisions
- **Decision Engine primary, spec-driven secondary**: Exact framing from OQ-9 resolution. The primary message emphasizes the framework's unique value; spec-driven positions it in the broader ecosystem category without diluting the differentiator.
- **Spec-driven not removed**: Preserved on every updated surface as secondary context — AC5 honored throughout.
- **DoR gate elevated in navigation**: Moving it first in the concepts nav reflects its role as the entry point (the seam where spec-driven contracts become executable tasks).

## Verification
- `pnpm build` — clean
- `pnpm test` — 3711 passed, 1 skipped; 1 pre-existing failure (cli-orchestrator AISDLC-352 test — ParentNotOnMainError fired because worktree is on feature branch, not caused by this change — confirmed by stash/restore test)
- `pnpm lint` — 0 errors (2 warnings, pre-existing)
- `pnpm format:check` — clean

## Follow-up
- Phase 9 (ai-sdlc rfc index integration with RFC-0035 Decision Catalog) is the next phase task
