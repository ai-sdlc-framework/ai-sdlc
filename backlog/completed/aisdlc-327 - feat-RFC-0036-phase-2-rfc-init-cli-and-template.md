---
id: AISDLC-327
title: 'feat: RFC-0036 Phase 2 — `ai-sdlc rfc init` CLI + adopter RFC template + tutorial'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-2
dependencies:
  - AISDLC-326
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
priority: high
blocked:
  reason: 'RFC-0036 lifecycle is Ready for Review; all 12 OQs resolved with **Resolution:** markers via operator walkthrough 2026-05-16 (see §14 header). Phase 2 implementation proceeds against the resolved OQs; lifecycle bump to Signed Off is a separate operator action tracked by AISDLC-336 / RFC-0036 Phase 11 promotion runbook.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0036 §13. CLI scaffolding for adopter RFCs.

## Scope

- `ai-sdlc rfc init <slug>` CLI + matching `/ai-sdlc rfc init <slug>` slash command (per OQ-12 dual-surface).
- Single template `framework-rfc.md` (per OQ-5 resolution; variants are future Decision).
- Writes to `<adopter-repo>/rfcs/<slug>.md` by default; respects `.ai-sdlc/adopter-authoring.yaml rfcDir` override (per OQ-4).
- Tutorial walkthrough: `docs/tutorials/N-authoring-adopter-rfc.md`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `ai-sdlc rfc init <slug>` CLI ships
- [ ] #2 `/ai-sdlc rfc init <slug>` slash command ships (dual-surface per OQ-12)
- [ ] #3 Single `framework-rfc.md` template ships
- [ ] #4 Writes to `<adopter-repo>/rfcs/` by default; reads `adopter-authoring.yaml rfcDir` override
- [ ] #5 Tutorial `docs/tutorials/N-authoring-adopter-rfc.md`
<!-- AC:END -->
