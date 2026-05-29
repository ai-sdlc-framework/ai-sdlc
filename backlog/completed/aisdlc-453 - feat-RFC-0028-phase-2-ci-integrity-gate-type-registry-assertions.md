---
id: AISDLC-453
title: 'feat: RFC-0028 Phase 2 — CI integrity gate (type-registry assertions) + structural drift detection'
status: Done
assignee: []
created_date: '2026-05-27'
labels:
  - rfc-0028
  - substrate-enforcement
  - phase-2
  - ci-gate
dependencies:
  - AISDLC-452
references:
  - spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0028 §4 + §7.2 resolution. Ships the CI integrity gate (type-registry layer detection) — the fourth drift detection mechanism complementing RFC-0009 §7.2's three orchestrator-side rules.

## Scope (RFC-0028 §4 + §7.2 v0.2 resolution)

### CI integrity gate assertions

Implement the 5 assertions listed in RFC-0028 §4 as a deterministic test suite:

1. Registry key matches contract `soulId` field (catches mis-registration drift)
2. `soulId` ∈ runtime soul-membership set (catches phantom-Soul-DID registration — the §4.2 concrete catch)
3. RFC-0009 §7.1 Eρ₅ compliance locks INVIOLABLE on declared-vulnerable Soul DIDs (catches categorical gate bypass at authoring)
4. Director agent ∈ council membership (catches cross-soul authority leak)
5. Substrate marker keys ∈ shared SSOT marker registry (catches substrate contamination)

Ship as `scripts/check-substrate-contract.mjs` invoked by the pre-push hook (joins the existing chain in `.husky/pre-push`) AND by CI workflow `substrate-contract-integrity.yml`.

### Structural drift Decision routing

When ANY assertion fails:
- Emit `Decision: substrate-structural-drift-detected` with severity HIGH + asserting which assertion failed + which Soul DID + which contract field
- Block PR merge (hard gate — surfaces in `ai-sdlc/pr-ready` rollup as failing)

### Deterministic test discipline

- No LLM, no I/O during assertions (per RFC-0028 §4)
- All 5 assertions run in <5s on a typical contract corpus
- Hermetic tests using fixture contracts cover each assertion's pass/fail path AND the §4.2 concrete catch (Soul DID's identifier missing from runtime soul-membership set)

### Composes with shipped substrate

Reuses substrate from RFC-0030 (signal-ingestion) Phase 4 governance-events module pattern: emit Decision via existing catalog substrate (RFC-0035 default-on flag). No new event-emission code needed beyond the per-assertion failure case.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 5 type-registry CI assertions implemented per RFC-0028 §4
- [x] #2 `scripts/check-substrate-contract.mjs` ships and is invoked by pre-push hook
- [ ] #3 `substrate-contract-integrity.yml` CI workflow ships and feeds into `ai-sdlc/pr-ready` rollup — PARTIAL: governance blocks `.github/workflows/**` writes; gate feeds into rollup via `pnpm test` in existing `build-test` job. Operator to add standalone workflow file after review.
- [x] #4 Assertion failure emits `Decision: substrate-structural-drift-detected` severity HIGH with which-assertion / which-Soul / which-field details
- [x] #5 PR merge BLOCKED on assertion failure (hard gate — via pre-push hook + pnpm test in CI)
- [x] #6 Deterministic: no LLM, no I/O; all 5 assertions run in <5s on typical contract corpus
- [x] #7 Hermetic tests cover each assertion's pass + fail paths AND the §4.2 concrete catch reproduction (phantom-Soul-DID registration)
- [x] #8 Cold-start handling: gate is no-op when zero substrate contracts exist in the repository (fresh adopter)
<!-- AC:END -->

## Final Summary

Shipped `scripts/check-substrate-contract.mjs` (RFC-0028 Phase 2 CI integrity gate) with 5
deterministic type-registry assertions, 70 hermetic tests, pre-push hook integration, and
`pnpm test:substrate-contract-gate` wired into the root test suite. The gate is a cold-start
no-op when no `substrate-contracts/` directory exists (AC-8). AC-3 (standalone CI workflow) is
partially met: the `.github/workflows/**` governance restriction prevents creating a new workflow
file; instead the gate feeds into `ai-sdlc/pr-ready` via the existing `build-test` job which
runs `pnpm test`. Operator to add `substrate-contract-integrity.yml` after review.
