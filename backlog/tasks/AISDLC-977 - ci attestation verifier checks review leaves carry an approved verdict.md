---
id: AISDLC-977
title: 'CI attestation verifier checks that review leaves carry an approved verdict'
status: To Do
assignee: []
created_date: '2026-10-20'
labels:
  - attestation
  - trust-chain
dependencies:
  - AISDLC-970
references:
  - pipeline-cli/attestation-core/verify-core.mjs
  - scripts/verify-attestation.mjs
  - docs/operations/attestation-reference.md
priority: high
dispatchable: true
---

## Description

`verifyV6Envelope` (`pipeline-cli/attestation-core/verify-core.mjs:1024` onward) checks the envelope shape, the Merkle inclusion proof of every transcript leaf (`:1230-1238`, through `v6VerifyInclusion` at `:698`), the root signature and the reviewer set. The only verdict assertion in the file is the inverse one at `:1391`: a `stage` leaf must carry `verdictApproved=false` and zero findings. No code path asserts that a reviewer leaf carries `verdictApproved: true` and no critical or major finding. An envelope signed over three CHANGES_REQUESTED leaves is structurally valid and verifies, so `ai-sdlc/attestation` turns green on a rejected review.

Fix: add a predicate in verify-core that, for every reviewer leaf credited toward the reviewer set, requires `verdictApproved === true` and a zero count of critical and major findings, returning `status: 'invalid'` with a reason naming the leaf and reviewer otherwise. `scripts/verify-attestation.mjs` surfaces the new reason in its GitHub output lines (that script is a hook-blocked path for agents; the change there is small and is operator-reviewed in the PR). A fixture test builds an envelope with one rejected leaf and asserts the verifier refuses it, and the existing green fixtures still pass. `docs/operations/attestation-reference.md` lists the predicate among the v6 checks.

**Five-step review (requirements first).**
1. Requirement questioned: is a verdict check the verifier's job, or the aggregator's? The aggregator runs in the untrusted worktree; the verifier is the only check CI trusts, so the predicate belongs there.
2. Delete: nothing to delete.
3. Simplify: one predicate over the leaf fields the signer already writes; no new leaf field.
4. Accelerate: no runtime cost beyond reading two fields per leaf.
5. Automate: the fixture test with a rejected leaf guards the predicate.

## Acceptance Criteria

- [ ] `verify-core.mjs` refuses a v6 envelope whose credited reviewer leaf has `verdictApproved !== true` or any critical or major finding, with a reason naming the leaf index and reviewer.
- [ ] `scripts/verify-attestation.mjs` surfaces that reason in its output lines (operator-reviewed change).
- [ ] A fixture test with one rejected leaf fails verification; all existing green fixtures still pass.
- [ ] `docs/operations/attestation-reference.md` documents the predicate.
