---
id: AISDLC-455
title: 'docs: RFC-0028 Phase 4 — RFC-0009 cross-reference edits (§5.2 + §7.2 see-also pointers)'
status: Done
assignee:
  - '@Dominique'
created_date: '2026-05-27'
completed_date: '2026-05-27'
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
- [x] #1 RFC-0009 §5.2 "See also: RFC-0028 (authoring-time companion)" pointer verified to exist after `substrateInvariants` schema declaration
- [x] #2 RFC-0009 §7.2 "See also: RFC-0028 (authoring-time companion — fourth detection mechanism)" pointer verified to exist after the staggered-rollout description
- [x] #3 Both pointers are light cross-refs (no inline content; just pointer + one-sentence summary)
- [x] #4 Pointers cross-link RFC-0028's normative composition rules (OQ-7.2 hard-gate / G0 surface)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Verification-only task. The two see-also pointers prescribed by RFC-0028 §7.4 v0.2 were shipped in the RFC-0028 OQ walkthrough PR (commit `c21344a9`, merged as #743). Both pointers are present, correctly placed, and accurately summarise RFC-0028's normative composition rules — all four acceptance criteria are satisfied by content already on `main`.

## Verification — pointer audit

### AC #1 — §5.2 pointer (after `substrateInvariants` schema declaration)

Location: `spec/rfcs/RFC-0009-tessellated-design-intent-documents.md` line 352, immediately after the `tessellation.substrateInvariants` schema fragment closes at line 350.

Text reads:

> See also: [RFC-0028](RFC-0028-engineering-axis-substrate-enforcement.md) (authoring-time companion). RFC-0028 specifies the Substrate Contract pattern — typed per-Soul-DID configuration that shared substrate code reads from — and the type-registry CI integrity gate that enforces the §5.1 `substrateInvariants` declarations at authoring time. Where this section defines the schema invariants, RFC-0028 operationalizes how those invariants are enforced before code reaches runtime.

Placement and summary both pass — pointer follows the schema, summary names RFC-0028's two normative surfaces (Substrate Contract pattern + CI integrity gate).

### AC #2 — §7.2 pointer (after staggered-rollout description)

Location: `spec/rfcs/RFC-0009-tessellated-design-intent-documents.md` line 456, immediately after the three-rule staggered-rollout paragraph at line 454.

Text reads:

> See also: [RFC-0028](RFC-0028-engineering-axis-substrate-enforcement.md) (authoring-time companion — fourth detection mechanism at the type-registry layer). RFC-0028 §4 specifies CI integrity gate assertions that complement these three orchestrator-side rules: type-registry-layer detection catches *declared* drift before it ships (cross-file invariants the AST scan cannot see), runs at CI time rather than orchestration time, and pairs with the runtime statistical detection in PPA's `SoulDriftDetected` event per RFC-0028 OQ-7.2's canonical composition rules (structural BLOCKS deployment; statistical SURFACES via RFC-0035 G0 non-blocking).

Placement and summary both pass — pointer follows the rollout table, summary explicitly names the OQ-7.2 canonical composition rules (structural hard-gate vs statistical G0 surface).

### AC #3 — both are light cross-refs

Both pointers are single blockquote paragraphs that name RFC-0028 + one-sentence summary of what it adds. No inline schema fragments, code samples, or migration notes are copied in. Composes with the "RFCs shouldn't accumulate" rationale.

### AC #4 — both cross-link RFC-0028's normative composition rules

- §5.2 pointer names the Substrate Contract pattern + type-registry CI integrity gate (RFC-0028's two core normative surfaces).
- §7.2 pointer explicitly names "OQ-7.2's canonical composition rules (structural BLOCKS deployment; statistical SURFACES via RFC-0035 G0 non-blocking)" — the exact normative composition the task body required.

## Changes

This PR contains no source edits — only the lifecycle move of the task file from `backlog/tasks/` to `backlog/completed/`. AC verification audit is captured in this final summary; the cross-ref edits themselves shipped in PR #743 (commit `c21344a9`).

## Verification

- `pnpm format:check` — not run (only file move, no formatting impact)
- Pointer audit — all 4 ACs pass against `main` HEAD content

## Follow-up

(none) — RFC-0028 Phase 4 cross-reference work is complete.
<!-- SECTION:FINAL_SUMMARY:END -->
