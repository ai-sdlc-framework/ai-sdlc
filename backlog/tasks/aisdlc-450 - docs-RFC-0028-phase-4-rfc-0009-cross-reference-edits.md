---
id: AISDLC-450
title: 'docs: RFC-0028 Phase 4 — RFC-0009 cross-reference edits (§5.2 + §7.2 see-also pointers)'
status: To Do
assignee: []
created_date: '2026-05-27'
labels:
  - rfc-0028
  - substrate-enforcement
  - phase-4
  - docs
dependencies: []
references:
  - spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 of RFC-0028 §7.4 v0.2 resolution. Light cross-references added in both RFC-0009 §5.2 (where `substrateInvariants` schema lives — the §3-self-reference location per RFC-0028) AND §7.2 (drift detection rules) pointing at RFC-0028.

**The cross-ref edits are shipped in the RFC-0028 OQ walkthrough PR itself** (part of the walkthrough diff). This task is filed as a tracking entry for AC verification + future-discoverability audit. The dev's job is to verify each pointer exists, resolves, and accurately summarizes RFC-0028's normative composition rules.

## Scope (RFC-0028 §7.4 v0.2 resolution)

- RFC-0009 §5.2 (tessellation object — where `substrateInvariants` schema field is declared) gains a "See also: RFC-0028 (authoring-time companion — Substrate Contract pattern + type-registry CI integrity gate)" pointer block.
- RFC-0009 §7.2 (Eτ_tessellation_drift orchestrator-side detection) gains a "See also: RFC-0028 (authoring-time companion — fourth detection mechanism at the type-registry layer)" pointer block referencing the OQ-7.2 canonical composition rules.

Pointers only; no inline content added — composes with "RFCs shouldn't accumulate" principle that motivated splitting RFC-0028 out in the first place.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 RFC-0009 §5.2 "See also: RFC-0028 (authoring-time companion)" pointer verified to exist after `substrateInvariants` schema declaration
- [ ] #2 RFC-0009 §7.2 "See also: RFC-0028 (authoring-time companion — fourth detection mechanism)" pointer verified to exist after the staggered-rollout description
- [ ] #3 Both pointers are light cross-refs (no inline content; just pointer + one-sentence summary)
- [ ] #4 Pointers cross-link RFC-0028's normative composition rules (OQ-7.2 hard-gate / G0 surface)
<!-- AC:END -->
