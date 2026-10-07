---
id: AISDLC-749
title: >-
  did compiler keeps evolving as the unlabeled-field default, documents the cross-layer exemption and warns per unlabeled field
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - orchestrator
dependencies: []
references:
  - orchestrator/src/sa-scoring/did-compiler.ts
  - orchestrator/src/sa-scoring/did-compiler.test.ts
  - docs/concepts/substrate-contract.md
priority: low
dispatchable: true
updated_date: '2026-10-07 17:55'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Resolves DEC-0003 (operator, 2026-10-06). The substrate-contract taxonomy defaults undeclared identityClass to core (rescoring-conservative); the DID compiler in `orchestrator/src/sa-scoring/did-compiler.ts` defaults to evolving because there the class is a similarity weight (core = 2x) and weight 1 is the neutral choice for unlabeled data.

Keep the compiler default. Add one paragraph to `docs/concepts/substrate-contract.md` under the identityClass section stating the exemption and why. Make the compiler emit one warning per unlabeled field naming the field, and test the warning.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The identityClass section of the substrate-contract doc has a paragraph stating the cross-layer exemption and why.
- [x] The compiler emits one warning per unlabeled field, naming the field, with a test.
- [x] No scoring change.

## Final Summary

## Summary
The DID compiler keeps `evolving` as the unlabeled-field default and now emits one `console.warn` per unlabeled field, naming its path. The substrate-contract doc gained a paragraph stating the cross-layer exemption and why. Scoring is unchanged.

## Changes
- `orchestrator/src/sa-scoring/did-compiler.ts` (modified): collect unlabeled field paths in a per-call set; warn once per path. Inherited principle classes are not warned.
- `orchestrator/src/sa-scoring/did-compiler.test.ts` (modified): tests for one warning per unlabeled field and for no warning when labeled.
- `docs/concepts/substrate-contract.md` (modified): cross-layer exemption paragraph under identityClass.

## Design decisions
- **console.warn, deduped per path per compile**: the compiler had no diagnostics mechanism; adding a field to CompiledDid would change the artifact shape and round-trip tests.

## Verification
- `pnpm build` — orchestrator and reference clean
- `pnpm test` — sa-scoring suite 341 passed
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews approved

## Follow-up
(none)
