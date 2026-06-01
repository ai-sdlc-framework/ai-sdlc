---
id: AISDLC-489
title: 'feat: refactor existing 3 §13 rules into Tessellation13Registry (AISDLC-467 AC#3 follow-up)'
status: Done
assignee: []
created_date: '2026-05-31'
labels:
  - rfc-0018
  - rfc-0009
  - drift-detection
  - registry
  - follow-up
dependencies:
  - AISDLC-467
references:
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up to AISDLC-467 (RFC-0018 Phase 3). AISDLC-467 shipped `Tessellation13Registry` and `JourneyStateIdDriftRule` (the 4th §13 rule) but deferred AC#3: refactoring the 3 existing §13 rules from `tessellation-drift.ts` into real `TessellationRule` instances registered via the registry.

The defer was judged acceptable-incremental by the AISDLC-467 reconciler (see PR #803 code-reviewer verdict): the registry is the integration surface and the 3 existing rules are unchanged + still covered by their own test suite (`tessellation-drift.test.ts`). The AISDLC-467 AC#8 regression tests used stub `TessellationRule` instances rather than wiring the real rules.

This task completes the integration.

## Scope

### Refactor the 3 existing §13 rules

In `orchestrator/src/tessellation/tessellation-drift.ts` (or extract to dedicated rule files):

1. **`SoulSlugAstScanRule`** — Rule #1: AST scan for soul-slug string literals in substrate code.
2. **`InterSoulEmbeddingDistanceRule`** — Rule #2: embedding distance between souls (reserved / deferred per RFC-0019, but the interface stub should be registered).
3. **`CrossSoulProvenanceRule`** — Rule #3: cross-soul provenance audits (ships in `tessellation-drift.ts`).

Each rule MUST implement `TessellationRule` from `rule-registry.ts` and be registerable via `registry.register(rule)`.

### Replace stubs in AISDLC-467 regression tests

In `orchestrator/src/journey/state-id-drift-rule.test.ts`, the AC#8 describe block (lines 426-525) currently uses stub objects for rules #1-#3. Replace with real rule instances so the regression test exercises actual rule logic through the registry.

### Update the tessellation-drift entrypoint

The existing `detectTessellationDrift()` function in `tessellation-drift.ts` should be updated to route through the registry when all 3 rules are registered, or maintained as-is if extraction to dedicated rule files is cleaner. Prefer the approach that minimises churn to existing callers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 The 3 existing §13 rules (`soul-slug-ast-scan`, `inter-soul-embedding-distance`, `cross-soul-provenance`) are implemented as real `TessellationRule` instances registerable via `Tessellation13Registry.register()`
- [ ] #2 Stub instances in AISDLC-467 AC#8 regression test block replaced with real rule instances; regression test asserts real rule behaviour (not just empty stubs) when dispatched through the registry
- [ ] #3 Existing `tessellation-drift.test.ts` test suite still passes unchanged (no regression to pre-registry behaviour)
- [ ] #4 `detectTessellationDrift()` callers are unaffected (no public API break)
- [ ] #5 Coverage gate passes (≥80% lines for orchestrator package)
<!-- AC:END -->
