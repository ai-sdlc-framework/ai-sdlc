---
id: AISDLC-392
title: 'chore: promote Decision Catalog feature flag to default-on (RFC-0035 Phase 5)'
status: Done
labels:
  - decision-catalog
  - feature-flag
  - promotion
references:
  - pipeline-cli/src/decisions/feature-flag.ts
  - pipeline-cli/src/decisions/feature-flag.test.ts
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - CLAUDE.md
---

## Description

Per RFC-0035 §14, the `AI_SDLC_DECISION_CATALOG` feature flag was off-by-default with `experimental` as the canonical opt-in value. Operator decision 2026-05-22: flip default to ON.

Mirrors the AI_SDLC_DEPS_COMPOSITION (RFC-0014) and AI_SDLC_AUTONOMOUS_ORCHESTRATOR (RFC-0015) promotion pattern.

## Acceptance criteria

- [ ] AC-1: `isDecisionCatalogEnabled()` defaults to TRUE when flag is unset (was: false)
- [ ] AC-2: Explicit opt-out via `off`, `0`, `false`, `no`, `disabled` (case-insensitive)
- [ ] AC-3: Backwards-compat: previously truthy values (`experimental`, `1`, `true`, `yes`, `on`) still resolve to ON
- [ ] AC-4: Tests updated + green
- [ ] AC-5: `decisionCatalogDisabledMessage()` updated to reflect opt-out semantics
- [ ] AC-6: CLAUDE.md section updated to document default-on + opt-out instructions
- [ ] AC-7: No regression in dor-bridge or cli-decisions

## References

- RFC-0035 §14 promotion pattern
- AISDLC-285 (Phase 1 — flag introduced)
- Operator request 2026-05-22
