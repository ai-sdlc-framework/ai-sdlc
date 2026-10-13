---
id: AISDLC-850
title: >-
  next-step reviewer set uses the attestation trust-chain classifier so test-reviewer is never omitted
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - pipeline
  - attestation
  - fix
dependencies: []
references:
  - pipeline-cli/src/next-step/review-prepare.ts
  - pipeline-cli/src/steps/reviewer-set.ts
  - pipeline-cli/src/attestation/review-scope.ts
  - pipeline-cli/attestation-core/review-scope-core.mjs
  - scripts/check-attestation-sign.sh
  - scripts/verify-attestation.mjs
  - pipeline-cli/src/next-step/review-prepare.test.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

On a diff that touches a trust-chain path (attestation code, hooks, governance files), the v6 attestation sign and verify step requires `test-reviewer` in the reviewer set. `next-step` spawned only `code-reviewer`(-codex) and `security-reviewer`, so the pre-push attestation-sign hook rejected the envelope ("reviewer set lacks test-reviewer on a trust-chain-path diff"). Seen on AISDLC-840 (PR #1469, DEC-0170 answered `rereview`) and AISDLC-842 (DEC-0172 answered `rerun-test-review`). Each occurrence costs a wasted reviewer round plus a re-sign. A related earlier note records the same shape: "reviewer-set classifier mismatch (next-step vs verify-attestation, DEC-0169)".

Code path found:

1. Verifier side: `pipeline-cli/attestation-core/review-scope-core.mjs` (`requiredReviewerKind`, the trust-chain path list) is the one classifier the CI verifier and `scripts/check-attestation-sign.sh` use, reached through `pipeline-cli/src/attestation/review-scope.ts` (`deriveEnvelopeReviewScope`) and `classifyReviewerSet` in `pipeline-cli/src/steps/reviewer-set.ts`.
2. next-step side: `pipeline-cli/src/next-step/review-prepare.ts` runs its own classifier (`runClassifier`, names `testing`, `critic`, `security`) and then `selectByClassifier` drops any prompt the classifier did not name. It never consults the trust-chain classifier, so it can omit `test-reviewer` (the `testing` name) on a diff the verifier calls trust-chain.

**Five-step review (requirements first).** 1. Requirement questioned: two independent classifiers answer the same question (which reviewers does this diff need), and nobody decided they may disagree; the verifier's answer is the only one that gates the push. 2. Deleted: next-step's own freedom to drop `test-reviewer` on a trust-chain diff (the narrowing in `selectByClassifier` for that case). 3. Simplified: next-step imports the verifier's required-set function (`requiredReviewerKind` / `classifyReviewerSet`) and treats its output as a floor; the narrowing classifier may only shrink the set above that floor; no second path list. 4. Accelerated: no wasted reviewer round and no re-sign after a hook rejection. 5. Automated: a test that every path the verifier calls trust-chain yields a next-step reviewer set the verifier accepts.

## Fix

1. In `pipeline-cli/src/next-step/review-prepare.ts`, after `runClassifier`, compute the required set from the same module the verifier uses (`classifyReviewerSet` over `built.changedFiles`, honouring the base-branch `reviewerSet` config and failing closed to three when the diff cannot be read) and union its reviewers into the selection, so `selectByClassifier` can never remove a reviewer the verifier requires.
2. Do not copy the trust-chain path list; import it.
3. Add a table test over the trust-chain paths from `review-scope-core.mjs` asserting the next-step selection is accepted by the verifier's check; a non-trust-chain docs-only diff keeps its current narrowed set.

Velocity impact: positive. Removes a recurring rejected-sign and reviewer re-run; no gate added, no control loosened (the set can only grow to what the verifier already requires).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 For a diff touching a trust-chain path, the `next-step` spawn-reviewers set always includes `test-reviewer` (or its codex variant), whatever the narrowing classifier returned
- [ ] #2 `next-step` obtains the required set from the same function the verifier uses; no second trust-chain path list exists in `pipeline-cli/src/next-step/`
- [ ] #3 A test iterates the trust-chain paths and asserts the next-step reviewer set passes the verifier's reviewer-set check; a docs-only diff still gets the narrowed set
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Follow-up

(none)
