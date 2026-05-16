---
id: AISDLC-332
title: 'docs: RFC-0036 Phase 7 — spec-kit bridge tutorial + getting-started revision'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-7
  - docs
dependencies:
  - AISDLC-330
  - AISDLC-331
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 7 of RFC-0036 §13. Adopter-facing tutorial for the spec-kit bridge + revision of getting-started flow.

## Scope

- `docs/tutorials/N-spec-kit-bridge.md` — end-to-end walkthrough: install spec-kit → author spec → import to ai-sdlc → dispatch → ship.
- Getting-started revision: prominently mention spec-kit bridge as the recommended adopter authoring path.
- Covers: import command, drift handling, DoR-at-import, upstream-clarification feedback loop.
- Includes troubleshooting section for common adoption blockers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `docs/tutorials/N-spec-kit-bridge.md` ships end-to-end walkthrough
- [ ] #2 Getting-started revision mentions spec-kit bridge as recommended authoring path
- [ ] #3 Covers import / drift / DoR-at-import / upstream-clarification feedback loop
- [ ] #4 Troubleshooting section for common adoption blockers
- [ ] #5 Cross-references RFC-0036 OQ resolutions for design rationale
<!-- AC:END -->
