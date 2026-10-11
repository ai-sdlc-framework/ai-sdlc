---
id: AISDLC-810
title: >-
  pre-push hook must re-sign after a rebase: a stale envelope subject passes locally but fails in CI
status: To Do
assignee: []
created_date: '2026-10-11'
updated_date: '2026-10-11'
labels:
  - attestation
  - velocity
  - root-cause
dependencies: []
references:
  - scripts/check-attestation-sign.sh
  - scripts/verify-attestation.mjs
  - pipeline-cli/attestation-core/verify-core.mjs
  - pipeline-cli/src/attestation/sign-v6.ts
priority: critical
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (verified 2026-10-11 02:40Z on PR #1383 / AISDLC-806).** A resumed task rebased its branch after signing. The content-addressed envelope `.ai-sdlc/attestations/59190b0c....v6.dsse.json` kept its name (patch-id unchanged) but its `subject.digest.sha1` is `69a8220e...`, the pre-rebase commit, which is now orphaned. The pre-push hook (`scripts/check-attestation-sign.sh`, the "envelope exists for the current patch-id" step) runs the verifier locally; locally the orphaned object still exists, so the tree-equivalence relaxation (`isTreeEquivalentModuloAttestation` in `pipeline-cli/attestation-core/verify-core.mjs`, added by AISDLC-448) accepts the envelope and the hook skips re-signing (`status=valid` is an idempotent no-op).

In CI (`verify-attestation.yml`, main's verifier, fetch of the PR head only) the orphaned commit is unreachable, the relaxation cannot run (`AISDLC-491: could not compute changed paths (subject merge-base unreachable?)`, logged near the `verifyV6Envelope` caller), and verification fails in `verifyV6Envelope` with `v6: envelope filename '<subject sha>.v6.dsse.json' does not match expected '<headSha>.v6.dsse.json'`. Same failure on #1386, #1385, #1388, #1389 and #1378: every rebase-resume of 2026-10-11. Fresh PRs (#1387) pass. The planner instruction "rebase; if the patch-id is unchanged let the hook re-sign" therefore never re-signed. Related: AISDLC-448 (tree-equivalence relaxation), AISDLC-398 (content-addressed envelopes), AISDLC-618 (three-way exclusion lockstep), AISDLC-756.

**Five-step review (requirements first).**
1. Requirement questioned: "an envelope stays valid across a conflict-free rebase without re-signing" (AISDLC-448 relaxation, planner). It only holds where the orphaned commit is still present, i.e. on the signer's machine, never in CI. A requirement that cannot be met where it matters is the wrong requirement.
2. Delete: remove the local-only acceptance. The hook must treat "subject is not an ancestor of HEAD" as not-signed, regardless of what the local verifier says. Consider deleting `isTreeEquivalentModuloAttestation` from the verifier entirely and keeping `isAttestationOnlyDescendant`, which CI can evaluate.
3. Simplify: one rule in the hook. `git merge-base --is-ancestor <subject> HEAD` false means re-sign from the existing verdict and the per-patch-id transcript leaves (no reviewer round; the patch-id is unchanged).
4. Accelerate: the re-sign happens in the same push (the existing fixup "re-run git push" flow).
5. Automate: none beyond the above.

**Velocity impact.** Positive: removes a two-push-plus-CI-failure loop on every rebase-resume and the manual re-sign each one needed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Hermetic test in `scripts/check-attestation-sign.test.mjs`: a branch is signed, then rebased onto a moved base (subject orphaned); the hook re-signs and the new envelope's subject equals the pre-chore HEAD
- [ ] #2 The hook never skips re-signing when the envelope subject is not an ancestor of HEAD, even if `scripts/verify-attestation.mjs` reports `status=valid` locally (covered by a test with the orphaned object still present)
- [ ] #3 Decision recorded (planner records it in the catalog) on whether `isTreeEquivalentModuloAttestation` is deleted; the task implements whichever the record says, default delete, and `scripts/verify-attestation.test.mjs` is updated accordingly
- [ ] #4 CLAUDE.md "v6 head-binding survives rebase + chore commits" paragraph is corrected to the shipped behaviour
- [ ] #5 CI: a PR rebased after signing verifies green in `verify-attestation.yml`
- [ ] #6 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test:attestation-sign-gate && node --test scripts/verify-attestation.test.mjs`
- `pnpm lint && pnpm format:check`
