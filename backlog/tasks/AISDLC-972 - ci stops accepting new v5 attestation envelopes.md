---
id: AISDLC-972
title: 'CI rejects v5 attestation envelopes signed after the v6 cutover; v5 stays read-only for history'
status: In Progress
assignee: []
created_date: '2026-10-17'
labels:
  - attestation
  - trust-chain
dependencies: []
references:
  - orchestrator/src/runtime/attestations.ts
  - pipeline-cli/attestation-core/verify-core.mjs
  - scripts/check-attestation-sign.sh
  - docs/operations/attestation-reference.md
priority: medium
dispatchable: true
---

## Description

RFC-0042 made v6 (Merkle tree over transcript leaves) the default and said v5 is "retained read-only". The code still accepts a new v5 envelope: `orchestrator/src/runtime/attestations.ts` line 63 lists `ACCEPTED_SCHEMA_VERSIONS = ['v3','v5']` for the legacy path and `pipeline-cli/attestation-core/verify-core.mjs` (line 2743) still calls it; `AI_SDLC_V5_LEGACY=1` or `--schema-version v5` on the signer produces one. A v5 envelope proves a key signature over a content hash and reviewer names the signer asserts, with no transcript evidence and no `enforceReviewScope`, so it is a standing way to land code with a weaker proof than the gate advertises.

**Five-step review (requirements first).**
1. Requirement questioned: is v5 still needed anywhere? Only to verify envelopes already on main that were signed before the cutover (2026-05-23). No producer needs it.
2. Delete: the `--schema-version v5` and `AI_SDLC_V5_LEGACY` producer paths in the signer and the pre-push hook.
3. Simplify: the verifier accepts a v5 envelope only when its `signedAt` is before the cutover date; a later v5 envelope is `invalid` with reason `v5-after-cutover`.
4. Accelerate: nothing.
5. Automate: tests for a pre-cutover v5 (valid), a post-cutover v5 (invalid) and the removed flags refusing; `docs/operations/attestation-reference.md` states v5 is read-only and names the cutover.

## Acceptance Criteria

- [ ] A v5 envelope with `signedAt` after 2026-05-23 verifies `invalid`; one before verifies as today.
- [ ] The signer and the pre-push hook refuse to produce v5 and say why.
- [ ] Existing v5 envelopes on main still verify.
- [ ] Tests and the reference doc cover the rule.
