---
id: AISDLC-326
title: 'feat: RFC-0036 Phase 1 — spec-driven concepts doc + three-tier authoring model'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-1
  - docs
dependencies: []
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0036 §13. Docs-only foundation; no code. Establishes the three-tier authoring model (RFC → Spec → Task) + altitude rubric that the rest of the implementation phases compose on.

## Scope

- `docs/concepts/spec-driven.md` — explainer covering: spec-driven development as a category, the two-stage funnel (spec-kit + ai-sdlc), the three-tier authoring model (RFC for decisions / Spec for executable contracts / Task for single deliverables).
- Altitude rubric: when each artifact altitude is correct (RFC for cross-cutting design; Spec for feature contracts; Task for atomic deliverables).
- Positioning note: framework leads with "Decision Engine" framing; spec-driven is the broader category we participate in (per OQ-9 resolution).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `docs/concepts/spec-driven.md` ships with three-tier authoring model + altitude rubric
- [ ] #2 Positioning leads with "Decision Engine"; spec-driven framed as the broader category
- [ ] #3 Cross-references to RFC-0011 (DoR), RFC-0035 (Decision Catalog), spec-kit upstream
- [ ] #4 No code touched; pure docs phase
<!-- AC:END -->
