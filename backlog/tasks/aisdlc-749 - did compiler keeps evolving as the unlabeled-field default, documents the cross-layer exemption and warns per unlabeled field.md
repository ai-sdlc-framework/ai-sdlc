---
id: AISDLC-749
title: >-
  did compiler keeps evolving as the unlabeled-field default, documents the cross-layer exemption and warns per unlabeled field
status: To Do
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
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Resolves DEC-0003 (operator, 2026-10-06). The substrate-contract taxonomy defaults undeclared identityClass to core (rescoring-conservative); the DID compiler in `orchestrator/src/sa-scoring/did-compiler.ts` defaults to evolving because there the class is a similarity weight (core = 2x) and weight 1 is the neutral choice for unlabeled data.

Keep the compiler default. Add one paragraph to `docs/concepts/substrate-contract.md` under the identityClass section stating the exemption and why. Make the compiler emit one warning per unlabeled field naming the field, and test the warning.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The identityClass section of the substrate-contract doc has a paragraph stating the cross-layer exemption and why.
- [ ] The compiler emits one warning per unlabeled field, naming the field, with a test.
- [ ] No scoring change.
