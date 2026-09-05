---
id: AISDLC-579
title: >-
  v6 attestation: verify recomputes a DIFFERENT Merkle root than sign for 2+
  leaves — every multi-reviewer attestation fails its own verifier
status: Done
assignee: []
created_date: '2026-09-05 18:20'
updated_date: '2026-09-05'
labels:
  - attestation
  - proof-of-execution
  - bug
  - adoption
  - aisdlc-575-followup
  - security-critical
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem (HIGH — verifier rejects valid signatures)

A v6 DSSE attestation signed over **2+ transcript leaves** (any task reviewed by more than one reviewer — the NORMAL case: code + security [+ test]) FAILS its own verifier with `status=invalid / reason=v6: rootSignature did not match any trusted reviewer pubkey`, even though the ed25519 signature is valid over the envelope's `rootHash`. **Single-leaf** attestations pass (no tree to disagree on). Framework-wide, in `@ai-sdlc/pipeline-cli@0.20.0` `attestation-core/verify-core.mjs` (shipped by AISDLC-575). Reported by a downstream repo dogfooding the plugin-less `cli-attestation verify` (LT-540).

## Confirmed root cause (code-inspected 2026-09-05)

There are **two copies of the v6 Merkle implementation** and the verify path feeds them a **differently-ordered/filtered leaf set** than sign:

- **Sign** (`pipeline-cli/src/attestation/sign-v6.ts:141`) computes `computeMerkleRoot(allLeaves)` from `pipeline-cli/src/attestation/merkle.ts`, over the leaves as loaded by `loadLeavesForPatchId(patchId, repoRoot)` (append/`leafIndex` order).
- **Verify** (`attestation-core/verify-core.mjs`): `v6ComputeMerkleRoot(onDiskLeaves)` — an INLINE hand-copied re-implementation (`v6HashLeaf` @806, `v6HashPair` @792, `v6ComputeMerkleRoot` @838) — at **line ~1286**, then verifies the signature over that **recomputedRoot** at **~1296-1300** via `verifyV6RootSignatureAgainstRoot` (~1426).

The primitives (`SHA-256(0x00‖json)`, `SHA-256(0x01‖left‖right)`) and the tree loop are byte-identical between the two copies (reporter diffed them; single-leaf passes → per-leaf hashing agrees). Therefore the divergence is in the **leaf INPUT ORDER/FILTER** that verify's loader (`getLeavesForEnvelope` / `v6LoadLeaves` / the per-patch-id + shared-file fallback path around `verify-core.mjs:1005-1075`, note the readdirSync().sort() at ~732 and the "MUST mirror that filter" comment at ~1035) produces vs sign's `loadLeavesForPatchId` order. Because `hashPair(a,b) ≠ hashPair(b,a)`, a flipped 2-leaf order yields a different root; with one leaf there is no pairing so it coincides.

## Broader impact — framework's own gate is now broken

AISDLC-575 repointed the **repo CI verifier** (`scripts/verify-attestation.mjs`) AND the plugin driver at this same `verify-core.mjs`. So since #1001 merged, the `ai-sdlc/attestation` gate on main will REJECT any multi-reviewer (2+ leaf) code PR. #1001 itself slipped through only because its CI ran the pre-575 core. This blocks the standard 3-reviewer flow framework-wide, not just consumer repos.

## Fix

1. **Single-source the Merkle + leaf-canonicalization.** `verify-core.mjs` must use the SAME root computation + leaf loader/ordering as `sign-v6.ts`. Delete the inline `v6HashLeaf`/`v6HashPair`/`v6ComputeMerkleRoot` copy; import/share the one implementation. (verify-core is a dependency-free ESM shipped in the pipeline-cli package — if it cannot import the TS-compiled `merkle.js` cleanly, move the canonical merkle primitives INTO `attestation-core/` and have `merkle.ts` re-export them, so there is exactly ONE copy that both sign and verify call. Extend the AISDLC-575 dup-guard test to also assert a single `computeMerkleRoot`/`hashLeaf`, not just a single `verifyV6Envelope`.)
2. **Guarantee identical leaf SET + ORDER on both sides.** The verifier's `onDiskLeaves` (per-patch-id file → shared-file fallback, with the taskId filter) MUST reproduce sign's `allLeaves` ordering exactly (append order by `leafIndex`, NOT `readdirSync().sort()` or any reviewerName/hash sort). Add an explicit assertion/normalization so order can't drift.
3. **KEEP verifying the signature over the RECOMPUTED root** (do NOT switch to trusting `envelope.rootHash` — that would weaken tamper detection). The fix is to make the recompute equal sign's, not to trust the envelope's stated root.
4. **Round-trip tests (the coverage gap that let this ship):** sign→verify a **2-leaf** AND a **3-leaf** envelope end-to-end and assert `status=valid`; plus an order-permutation test (leaves emitted in a different order still verify) and a tamper test (mutating one leaf → invalid). Hermetic, Linux-safe.

## Bootstrap / chicken-and-egg (IMPORTANT for the fix PR)

The fix PR's own attestation, if signed with 2+ leaves, will FAIL the current (buggy) `ai-sdlc/attestation` gate on main — CI verifies with main's still-broken `verify-core.mjs`. Options: (a) attest the fix PR under the documented **gate-cutover bypass** (`AI_SDLC_BYPASS_ALL_GATES=1`, CLAUDE.md sanctions this exactly for "gate-rewrite cutover windows" — document in the PR body) after verifying locally with the FIXED core; or (b) sign the fix PR single-leaf to pass. Prefer (a) with a full 3-reviewer review + local multi-leaf verify proof in the PR body, since this is the attestation trust root.

## Acceptance Criteria
- [ ] A 2-leaf AND a 3-leaf v6 envelope sign→verify to `status=valid` (hermetic round-trip test).
- [ ] Exactly one Merkle/leaf-hash implementation ships (dup-guard extended to `computeMerkleRoot`/`hashLeaf`); the inline `v6*` copy is deleted.
- [ ] Verifier leaf set+order provably mirrors the signer's (`loadLeavesForPatchId` append order); regression test with leaves emitted out of order.
- [ ] Signature still verified over the recomputed root (tamper test: mutated leaf → invalid).
- [ ] Repo CI `verify-attestation.yml` + plugin verify path + `cli-attestation verify` all pass a multi-reviewer envelope.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note
Directly undermines the AISDLC-575 deliverable (the shipped plugin-less verify is broken for the normal multi-reviewer case). Composes with [[aisdlc-575]] (single-sourcing that missed the merkle layer) and [[aisdlc-576]] (the OTHER multi-version leaf-hash hazard — different bug, same trust root). This is the last blocker for the LT-540 downstream v6 cutover per the reporter.
<!-- SECTION:DESCRIPTION:END -->
