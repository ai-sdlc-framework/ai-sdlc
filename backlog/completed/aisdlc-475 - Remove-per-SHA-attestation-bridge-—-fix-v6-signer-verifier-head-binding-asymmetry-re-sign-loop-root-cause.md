---
id: AISDLC-475
title: >-
  Remove per-SHA attestation bridge — fix v6 signer/verifier head-binding
  asymmetry (re-sign loop root cause)
status: To Do
assignee: []
created_date: '2026-05-29 17:42'
labels:
  - attestation
  - rfc-0042
  - ci-friction
  - needs-walkthrough
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**DO NOT DISPATCH YET — operator walkthrough required before implementation (touches the attestation trust chain).**

## Problem (audit 2026-05-29)

The v6 attestation pre-push signer and the CI verifier use ASYMMETRIC head-binding logic, producing a "re-sign loop" that costs ~10 min per PR and forces operators into `AI_SDLC_SKIP_ATTESTATION_SIGN=1`.

- The **verifier** (`scripts/verify-attestation.mjs`) forgives the chore-commit / rebase pattern via two relaxations: `isAttestationOnlyDescendant` (AISDLC-419, subject SHA is attestation-only ancestor of HEAD) and `isTreeEquivalentModuloAttestation` (AISDLC-448, trees byte-identical modulo `ATTESTATION_PATH_EXCLUSIONS`).
- The **pre-push signer** (`scripts/check-attestation-sign.sh`, idempotency check ~lines 206-215) does NOT apply those relaxations. It only checks two literal filenames: `<patch-id>.v6.dsse.json` and `<HEAD_SHA>.v6.dsse.json`. When HEAD moves past the signed SHA (every attestation chore commit, every rebase), the per-SHA filename no longer matches HEAD, the hook concludes "no envelope here," and re-signs → new chore commit → HEAD moves again → loop.

This is the exact `#767` failure: `envelope filename 'f76bd1bb….v6.dsse.json' does not match expected '<headSha>.v6.dsse.json'`.

## Root architectural debt: the per-SHA bridge is not load-bearing

The signer (`pipeline-cli/src/attestation/sign-v6.ts` ~lines 314-319) dual-writes BOTH a `<patch-id>.v6.dsse.json` (primary, content-addressed, base-independent per AISDLC-398) AND a `<HEAD_SHA>.v6.dsse.json` legacy bridge bound to the dev commit. The security analysis found the per-SHA bridge adds NO security property the patch-id + Merkle-root signature + commit-SHA-derived nonce don't already provide. No comment or doc anywhere justifies keeping it. It is a pre-patch-id legacy crutch that now generates more failures than it prevents.

## Proposed fix (Fix B from the audit — confirm in walkthrough)

1. Signer: stop writing the `<HEAD_SHA>.v6.dsse.json` bridge; write the patch-id-addressed file only.
2. Pre-push hook: simplify idempotency to check ONLY the patch-id file; drop the per-SHA fallback that triggers the re-sign loop.
3. Verifier: KEEP the per-SHA fallback lookup for LEGACY envelopes during a 1-release soak (pre-AISDLC-398 / pre-this-change envelopes stay findable).
4. Keep `ATTESTATION_PATH_EXCLUSIONS` in lockstep across signer (`patch-id.ts:PATCH_ID_EXCLUSIONS`) and verifier (asymmetric lists reproduce the AISDLC-421 bug class).

## Alternatives considered (for the walkthrough)
- **Fix A**: port the verifier's two relaxations into the bash hook so signer+verifier agree. Rejected as primary because it duplicates ~200 lines of mjs logic in bash and creates permanent divergence risk.
- **Fix C**: ephemeral per-SHA bridge deleted in the same chore commit. Adds a footgun; partial.

## Walkthrough agenda (operator + engineering)
- Confirm the per-SHA bridge has no remaining consumer (grep all verifier lookup paths, CI workflows, external tooling).
- Decide soak length + whether to delete legacy per-SHA verifier fallback after soak.
- Confirm replay-protection is fully covered by the nonce (re-read AISDLC-383.4 security review).
- Decide whether to ALSO cut the post-sign chore-commit entirely (deeper fix: don't move HEAD after signing at all).

## Source files
- `scripts/check-attestation-sign.sh` (pre-push idempotency)
- `pipeline-cli/src/attestation/sign-v6.ts` (dual-write)
- `scripts/verify-attestation.mjs` (relaxations + per-SHA fallback)
- `pipeline-cli/src/attestation/patch-id.ts` (PATCH_ID_EXCLUSIONS)

Full audit findings captured in this session's transcript 2026-05-29.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 WALKTHROUGH GATE: operator + engineering walkthrough completed and the chosen approach (remove bridge vs. teach-hook-relaxations vs. cut-chore-commit) is recorded before any code change
- [ ] #2 Signer no longer writes the `<HEAD_SHA>.v6.dsse.json` per-SHA bridge file (writes patch-id-addressed envelope only) IF removal is the chosen approach
- [ ] #3 Pre-push hook idempotency check no longer triggers a re-sign when a valid patch-id envelope exists but HEAD has moved past the signed SHA
- [ ] #4 Verifier retains per-SHA fallback lookup for legacy (pre-change) envelopes for a 1-release soak window
- [ ] #5 A PR with an attestation chore commit on top of the dev commit pushes WITHOUT the signer re-signing (re-sign loop eliminated) — demonstrated end-to-end
- [ ] #6 ATTESTATION_PATH_EXCLUSIONS remain identical across signer (patch-id.ts) and verifier (verify-attestation.mjs)
- [ ] #7 Hermetic tests cover: (a) chore-commit-on-top no-resign, (b) clean-rebase no-resign, (c) genuine-source-change DOES invalidate + require re-sign
- [ ] #8 No replay-protection regression — nonce continues to bind the envelope to the commit SHA
<!-- AC:END -->
