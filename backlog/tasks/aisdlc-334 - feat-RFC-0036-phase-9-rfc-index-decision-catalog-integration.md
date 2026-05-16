---
id: AISDLC-334
title: 'feat: RFC-0036 Phase 9 — `ai-sdlc rfc index` integration with RFC-0035 Decision Catalog'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0036
  - spec-kit-bridge
  - phase-9
dependencies:
  - AISDLC-328
  - AISDLC-285
references:
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 9 of RFC-0036 §13. `ai-sdlc rfc index` lists adopter RFCs + cross-references them against the RFC-0035 Decision Catalog so adopters can see "which decisions does this RFC resolve."

## Scope

- `ai-sdlc rfc index` CLI scans `<adopter-repo>/<rfcDir>/*.md` + emits a table of (RFC, status, decisions-resolved, decisions-pending).
- Reads RFC-0035 Decision Catalog event log (`.ai-sdlc/_decisions/events.jsonl`) for the decisions-resolved column.
- Depends on RFC-0035 Phase 1 (AISDLC-285) — Decision schema + cli-decisions.
- Output format: human-readable table + `--json` for programmatic consumption.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `ai-sdlc rfc index` CLI scans `<rfcDir>/*.md`
- [ ] #2 Cross-references each RFC against RFC-0035 Decision Catalog event log
- [ ] #3 Output columns: RFC ID, title, lifecycle, decisions-resolved count, decisions-pending count
- [ ] #4 `--json` output for programmatic consumption
- [ ] #5 Composes with RFC-0035 Phase 1 (AISDLC-285) Decision schema
<!-- AC:END -->
