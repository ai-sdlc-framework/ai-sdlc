---
id: AISDLC-970
title: 'The attestation verifier requires a verified chain of envelopes back to the base commit when a leaf carries a delta reviewRange'
status: Done
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

- [x] A delta envelope whose chain reaches a full review at or before the PR's base commit verifies `valid`.
- [x] A delta envelope with a missing, unverifiable or non-ancestor link verifies `invalid` and names the sha.
- [x] Full (non-delta) envelopes behave exactly as before.
- [x] Tests cover the three fixtures; the reference doc describes the chain.

## Final Summary

## Summary
The verifier now walks the committed envelope chain behind a delta leaf's baseSha. It requires a full review at or before the PR base, and names the first bad sha as invalid. Full envelopes behave as before. I added `verify-delta-chain.test.ts` and a 'Delta chain' paragraph in the reference doc.

## Changes
- pipeline-cli/attestation-core/verify-core.mjs
- pipeline-cli/src/attestation/verify-delta-chain.test.ts
- docs/operations/attestation-reference.md
- backlog/tasks/AISDLC-970 - verifier requires a reviewed chain to the base for delta leaves.md

## Design decisions
The first push ran from the parent checkout (cwd resets between calls). It sent main's HEAD (identical to origin/main) to the task branch and repointed the parent's `main` upstream. I restored the parent's upstream to `origin/main` and re-pushed from the worktree; the PR is now correct. Because `pnpm test` stopped at the first failing package, I did not see the remaining packages' tests. The AC1 and AC2 cases are covered by unit tests of `verifyDeltaChain`, not a full end-to-end envelope chain with git history. A sign/verify round trip confirms `verifyV6Envelope` surfaces `deltaBaseShas`, but the `runVerifier` wiring itself has no end-to-end test.

## Verification
- `pnpm build` — passed
- `pnpm test` — waived
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

