---
id: AISDLC-330
title: 'feat: RFC-0036 Phase 5 — DoR Gate at import time (strict default; analyze auto-resolve)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-5
dependencies:
  - AISDLC-329
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - spec/rfcs/RFC-0011-definition-of-ready-gate.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0036 §13. Wires DoR Gate (RFC-0011) into the import path with strict default + analyze-metadata-aware auto-resolution.

## Scope (OQ-3 + OQ-7 + OQ-10)

- DoR Gate runs at import time (strict default per OQ-3).
- `--rubric warn` opt-out flag for adopters who explicitly want warnings instead of refuse.
- **Analyze-metadata auto-resolution (OQ-7):** when `.specify/analyze.json` is present, each DoR gate decision auto-resolves via the catalog if analyze covered it. Only NEW gaps reach the operator.
- **OQ-10 rejection routing:** failed DoR → `Decision: import-blocked-on-dor` → emit clarification task back to spec-kit project (refuse import; don't create placeholder).
- Failure surfacing with structured upstream-clarification hints (so adopter can fix in spec-kit + re-import).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 DoR Gate runs at import time; strict default
- [ ] #2 `--rubric warn` opt-out flag respected
- [ ] #3 Analyze metadata at `.specify/analyze.json` auto-resolves matching DoR gates via catalog
- [ ] #4 Falls back to full DoR rubric when analyze metadata absent
- [ ] #5 Failed DoR refuses import (no placeholder); emits upstream clarification task
- [ ] #6 Structured clarification hints in the emitted upstream task (which gates failed + why)
- [ ] #7 Composes with RFC-0035 Stage A/B/C for Decision routing
<!-- AC:END -->
