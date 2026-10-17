---
id: AISDLC-970
title: 'The attestation verifier requires a verified chain of envelopes back to the base commit when a leaf carries a delta reviewRange'
status: To Do
assignee: []
created_date: '2026-10-17'
labels:
  - attestation
  - trust-chain
  - security
dependencies: []
references:
  - pipeline-cli/attestation-core/verify-core.mjs
  - pipeline-cli/src/attestation/sign-v6.ts
  - pipeline-cli/src/incremental-review/review-rounds.ts
  - docs/operations/attestation-reference.md
priority: high
dispatchable: true
---

## Description

Incremental review (AISDLC-725, AISDLC-947) lets a later round review only the delta since a prior reviewed anchor; the leaf records `reviewRange { mode: 'delta', baseSha }` (`pipeline-cli/src/attestation/sign-v6.ts` lines 100-102, 427). The v6 envelope for the final patch-id contains only that round's leaves, and `pipeline-cli/attestation-core/verify-core.mjs` never reads `reviewRange`. CI therefore reports `valid` for an envelope whose reviewers saw only `baseSha..head`; whether the range from the base commit to `baseSha` was ever reviewed rests on the local anchor in `.ai-sdlc/review-state`, which AISDLC-947 verifies on the signing machine only. A wrong or edited anchor lands code nobody reviewed with a green attestation.

**Five-step review (requirements first).**
1. Requirement questioned: is delta review worth the verification cost? Yes, it is the main token saving of the review tier; the requirement is that the saving is provable, not that it is dropped.
2. Delete: nothing.
3. Simplify: when any leaf has `reviewRange.mode === 'delta'`, the verifier resolves the envelope whose subject is `reviewRange.baseSha` (committed under `.ai-sdlc/attestations/`), verifies it recursively, and requires the chain to reach a `full` review whose subject is the PR's base commit or an ancestor of it; a missing link, an unverifiable link, or a cycle is `invalid` with a reason naming the first missing sha.
4. Accelerate: chains are short (one or two links); cache verified subjects within one run.
5. Automate: fixtures in `verify-core` tests for a valid two-link chain, a missing middle link and a tampered `baseSha`; `docs/operations/attestation-reference.md` gains a "delta chain" paragraph.

## Acceptance Criteria

- [ ] A delta envelope whose chain reaches a full review at or before the PR's base commit verifies `valid`.
- [ ] A delta envelope with a missing, unverifiable or non-ancestor link verifies `invalid` and names the sha.
- [ ] Full (non-delta) envelopes behave exactly as before.
- [ ] Tests cover the three fixtures; the reference doc describes the chain.
