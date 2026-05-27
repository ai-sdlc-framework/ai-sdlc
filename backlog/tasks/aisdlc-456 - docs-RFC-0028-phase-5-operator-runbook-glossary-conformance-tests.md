---
id: AISDLC-456
title: 'docs: RFC-0028 Phase 5 — operator runbook + glossary + conformance test suite'
status: To Do
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
- [ ] #1 `docs/operations/substrate-contract.md` published with all 6 runbook sections
- [ ] #2 Glossary additions ship (5 terms)
- [ ] #3 `docs/concepts/substrate-contract.md` adopter explainer ships
- [ ] #4 `docs/tutorials/N-authoring-substrate-contract.md` walkthrough ships
- [ ] #5 Conformance test suite covers canonical taxonomy + all 5 CI assertions + drift composition + cold-start + tightening-only
- [ ] #6 Each runbook section cross-links to the relevant RFC-0028 §7 OQ resolution
- [ ] #7 RFC-0009 cross-ref pointers verified resolvable from glossary + runbook
<!-- AC:END -->
