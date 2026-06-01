---
id: AISDLC-456
title: 'docs: RFC-0028 Phase 5 — operator runbook + glossary + conformance test suite'
status: Done
assignee: []
created_date: '2026-05-27'
labels:
  - rfc-0028
  - substrate-enforcement
  - phase-5
  - docs
dependencies:
  - AISDLC-452
  - AISDLC-453
  - AISDLC-454
references:
  - spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 5 of RFC-0028. Adopter-facing docs + conformance tests roll-up.

## Scope

### Operator runbook (`docs/operations/substrate-contract.md`)

Sections:
- **Authoring a Substrate Contract**: 4 required sub-contracts (Council / Cadence / Compliance / Cross-Soul Policy) with field-level `identityClass` examples
- **Choosing identityClass values**: when to mark a field `core` vs `evolving` per canonical taxonomy (AISDLC-452)
- **Reading the CI integrity gate output**: how to interpret each of the 5 assertion failures + remediation steps for each (AISDLC-453)
- **Reconciling statistical drift Decisions**: three reconciliation paths and when each applies (AISDLC-454)
- **Cold-start period**: what happens during the first 30 days of operation (no statistical drift detection; structural alone defends)
- **Promotion runbook**: when to promote a field from `core` to `evolving` (corpus-driven evidence + Design + Engineering sign-off)

### Glossary additions

- `Substrate Contract` — typed per-Soul-DID configuration object that shared substrate code reads from
- `identityClass` (field-level) — `core` (pivot rescoring) vs `evolving` (admission re-score) per canonical taxonomy
- `Structural drift` — authoring-time CI-detected substrate violation (hard PR merge gate)
- `Statistical drift` — runtime PPA `SoulDriftDetected` event (non-blocking operator surface)
- `Type-registry layer detection` — RFC-0028's fourth drift-detection mechanism

### Conformance test suite

Comprehensive test suite verifying:
- Canonical identityClass taxonomy is enforced (AISDLC-452)
- All 5 type-registry CI assertions pass on valid contracts AND fail correctly on each violation class (AISDLC-453)
- Drift composition rules: structural blocks PR; statistical surfaces non-blocking; both composable in catalog (AISDLC-454)
- Cold-start handling: structural detection alone during baseline-accumulation window
- Tightening-only enforcement: child Soul DIDs that loosen `core` fields fail type check
- RFC-0009 cross-ref pointers exist and resolve (AISDLC-455)

### Adopter-facing surfaces

- `docs/concepts/substrate-contract.md` — adopter explainer (when to use Substrate Contract; how it differs from RFC-0009's schema invariants)
- `docs/tutorials/N-authoring-substrate-contract.md` — step-by-step authoring walkthrough
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 `docs/operations/substrate-contract.md` published with all 6 runbook sections
- [x] #2 Glossary additions ship (5 terms)
- [x] #3 `docs/concepts/substrate-contract.md` adopter explainer ships
- [x] #4 `docs/tutorials/13-authoring-substrate-contract.md` walkthrough ships
- [x] #5 Conformance test suite covers canonical taxonomy + all 5 CI assertions + drift composition + cold-start + tightening-only
- [x] #6 Each runbook section cross-links to the relevant RFC-0028 §7 OQ resolution
- [x] #7 RFC-0009 cross-ref pointers verified resolvable from glossary + runbook

## Final Summary

### Summary
RFC-0028 Phase 5 ships the full operator-facing documentation suite and conformance test suite for the substrate enforcement stack shipped in Phases 1-4. The operator runbook (6 sections) documents actual behavior from AISDLC-452/453/454 code. The 5 glossary terms, adopter explainer, and step-by-step tutorial complete the adopter-facing surface. The conformance test suite (AC-5a through AC-5f) asserts against the real implementation modules — not test doubles.

### Changes
- `docs/operations/substrate-contract.md` (new): 6-section operator runbook covering authoring, identityClass taxonomy, CI gate output, statistical drift reconciliation, cold-start period, and promotion runbook — each section cross-linked to RFC-0028 §7 OQ resolution
- `spec/glossary.md` (modified): 5 new terms added — Substrate Contract, identityClass (field-level), Statistical Drift, Structural Drift, Type-Registry Layer Detection
- `docs/concepts/substrate-contract.md` (new): adopter explainer — when to use Substrate Contracts, how they differ from RFC-0009 schema invariants, schema + type primitives overview
- `docs/tutorials/13-authoring-substrate-contract.md` (new): 10-step walkthrough from directory scaffold to cold-start operation
- `scripts/check-substrate-contract.conformance.test.mjs` (new): comprehensive conformance suite covering AC-5a (taxonomy), AC-5b (all 5 assertions pass+fail), AC-5c (drift composition), AC-5d (cold-start), AC-5e (tightening-only), AC-5f (RFC-0009 cross-refs)
- `package.json` (modified): added `test:substrate-contract-conformance` script + wired into root `test` suite

### Design decisions
- **Conformance tests assert against source files directly**: Rather than requiring the orchestrator dist to be built, the conformance suite reads the TypeScript source text and asserts against exported symbol names, constant values, and contract logic. This keeps the suite runnable from a fresh clone without `pnpm build` and makes the assertions self-documenting.
- **Tutorial numbered 13**: Checked existing tutorials/; the highest numbered was 12 (12-declaring-variants.md), so 13 is the correct next free number.
- **Glossary terms added in alphabetical position**: identityClass under I, Statistical Drift and Structural Drift under S (after SecretStore/SupportChannel), Substrate Contract under S (before targetedVariants), Type-Registry Layer Detection under T.

### Verification
- `pnpm test:substrate-contract-conformance` — all tests pass
- `pnpm test:substrate-contract-gate` — unaffected (existing tests still pass)
- `pnpm format:check` — clean
- Cross-links verified: RFC-0028 §3, §4, §7.1, §7.2 anchors resolve; RFC-0009 §3 + §7.2 "See also: RFC-0028" blocks present (AISDLC-455); RFC-0035 catalog routing cross-ref resolves

### Follow-up
- (none) — all 7 ACs met; RFC-0028 Phases 1-5 complete.
<!-- AC:END -->
