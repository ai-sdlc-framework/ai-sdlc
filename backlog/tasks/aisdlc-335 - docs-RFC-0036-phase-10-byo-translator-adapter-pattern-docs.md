---
id: AISDLC-335
title: 'docs: RFC-0036 Phase 10 — BYO translator pattern docs for non-spec-kit upstreams'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-10
  - docs
dependencies:
  - AISDLC-329
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 10 of RFC-0036 §13. Adapter-pattern documentation for non-spec-kit upstreams (Linear, Notion, plain markdown). Per OQ-6 resolution: single BYO translator pattern, not N first-party adapters.

## Scope (OQ-6)

- `docs/concepts/adopter-translators.md` — explains the BYO translator pattern: adopters with non-spec-kit upstreams write their own translator that emits the canonical task-import format.
- Canonical task-import format spec (the contract the translator must produce).
- Reference translator scaffold at `.ai-sdlc/translators/<adopter>.ts`.
- Worked example: a minimal Linear → ai-sdlc translator.
- Note: new first-party adapter requests become Decisions in the RFC-0035 catalog; this doc explains how adopters can vote with their voice on which adapters should graduate to first-party.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `docs/concepts/adopter-translators.md` ships
- [ ] #2 Canonical task-import format spec documented (translator output contract)
- [ ] #3 Reference translator scaffold at `.ai-sdlc/translators/<adopter>.ts`
- [ ] #4 Worked example: minimal Linear → ai-sdlc translator
- [ ] #5 Documents the path from BYO → first-party adapter promotion (via RFC-0035 Decision)
<!-- AC:END -->
