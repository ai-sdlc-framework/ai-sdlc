---
id: AISDLC-467
title: 'feat: RFC-0018 Phase 3 — RFC-0009 §13 fourth rule (JourneyStateIdDriftRule via AST scan + Tessellation§13RuleRegistry)'
status: To Do
assignee: []
created_date: '2026-05-28'
labels:
  - rfc-0018
  - journey-pattern
  - phase-3
  - drift-detection
dependencies:
  - AISDLC-465
references:
  - spec/rfcs/RFC-0018-in-soul-journey-pattern.md
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
  - spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of RFC-0018 §10.1 OQ-8 + OQ-10 resolutions. Adds the 4th rule to RFC-0009 §13 Tessellation Drift Detection engine + spec'd registration mechanism. Composes with RFC-0028 OQ-7.2 unified-drift-detection direction.

## Scope (RFC-0018 §10.1 OQ-8 + OQ-10)

### Tessellation§13RuleRegistry

New module `orchestrator/src/tessellation/rule-registry.ts`:

- Standard rule interface: `{ name, description, scan(target): DriftEvent[], severity }`
- `register(rule)` API for adding rules to the §13 dispatcher
- `getRegisteredRules(): Rule[]` for enumeration
- §13 dispatcher fans out all registered rules in parallel; aggregates Decisions for catalog routing

### Existing §13 rules registration

Refactor the 3 existing §13 rules (AST scan for soul-slug leakage, embedding distance between souls, cross-soul provenance audits) to use the new registry:

- `SoulSlugAstScanRule` (existing Rule #1 — reuses its AST scan engine)
- `InterSoulEmbeddingDistanceRule` (existing Rule #2)
- `CrossSoulProvenanceRule` (existing Rule #3)

### JourneyStateIdDriftRule (the new 4th rule)

`orchestrator/src/journey/state-id-drift-rule.ts`:

- Scans substrate code for references to journey-state-id strings using AST scan (REUSES SoulSlugAstScanRule's AST engine; OQ-8 resolution explicitly rejects string-match path)
- Emits `Decision: journey-state-id-drift` when:
  - Referenced state ID is not declared in any active journey, OR
  - The journey itself has been removed (cross-references journey lifecycle / deprecation tooling)
- Per-org configurable severity threshold (default `medium`)

### Composes with RFC-0028 OQ-7.2

Per RFC-0028's just-resolved structural-vs-statistical pairing:
- Structural drift (this rule at CI authoring time) → BLOCKS PR via Decision severity HIGH (when configured)
- Statistical drift (runtime PPA `SoulDriftDetected` event) → SURFACES via RFC-0035 G0 non-blocking

This rule slots into the structural side of that composition.

### Hermetic tests

- Registry round-trip (register, enumerate, dispatch)
- All 3 existing rules continue to work after registry refactor (regression coverage)
- JourneyStateIdDriftRule detects:
  - Reference to state-ID in declared journey (no Decision)
  - Reference to state-ID NOT in any active journey (Decision emitted)
  - Reference to state-ID in removed journey (Decision emitted)
- AST scan reuses existing engine (no new parser introduced)
- Composes with RFC-0028 OQ-7.2: structural-blocking vs statistical-surfacing semantics preserved
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `Tessellation§13RuleRegistry` module ships with `register(rule)` + `getRegisteredRules()` API
- [ ] #2 Standard rule interface defined: `{ name, description, scan(target): DriftEvent[], severity }`
- [ ] #3 Existing 3 §13 rules refactored to use registry (regression tests pass)
- [ ] #4 `JourneyStateIdDriftRule` ships using AST scan technology (reuses existing engine; NOT string match)
- [ ] #5 Emits `Decision: journey-state-id-drift` when state-ID reference is to non-existent state OR removed journey
- [ ] #6 §13 dispatcher fans out all registered rules in parallel; aggregates Decisions for catalog routing
- [ ] #7 Composes with RFC-0028 OQ-7.2: structural drift blocks PR (when severity HIGH); statistical drift surfaces non-blocking
- [ ] #8 Hermetic tests cover registry, all 3 existing rules (regression), new JourneyStateIdDriftRule (positive + negative cases), composition with RFC-0028 drift framework
<!-- AC:END -->
