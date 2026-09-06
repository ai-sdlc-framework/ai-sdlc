---
id: AISDLC-595
title: >-
  RFC-0047 Phase 3 — verifier isolated re-derivation (credit under ci-only root sig, else downgrade)
status: To Do
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0047
  - phase-3
dependencies:
  - AISDLC-593
  - AISDLC-594
references:
  - spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0047 Phase 3 (OQ-3). Make the verifier CREDIT `independenceTier: 'isolated'` only when the Merkle root signature verifies under a `ci-only`-marked trusted key (AISDLC-593). Otherwise the leaf's effective tier is DOWNGRADED to its evidence-computed value with a recorded reason — never over-claimed. This is the security teeth of RFC-0047: it makes `isolated` unforgeable by the same-machine coordinator (who holds only the operator key), while keeping the verifier 100% offline.

## Scope
- In the per-leaf `independenceTier` block (`pipeline-cli/attestation-core/verify-core.mjs:~1308-1334`) and/or the aggregation (`~1372-1402`): a leaf resolving to `isolated` is credited ONLY if `verifyV6RootSignature` matched a **ci-only** key (thread the "which key matched" result out of the signature-verification step — today it only returns a boolean). If the root was signed by an operator key, downgrade the leaf's effective isolated to at-most-`attested` and attach a machine-readable reason (e.g. `isolatedDowngraded: { reason: 'no ci-only anchor' }`) surfaced in the verify result.
- **Integrity failures still REJECT** (unchanged): a bad Merkle proof or a root signature matching NO trusted key fails the whole attestation. Only an anchor/identity shortfall on an otherwise-valid envelope downgrades.
- The `overallIndependenceTier` weakest-link aggregation consumes the post-downgrade effective tiers.
- Fully OFFLINE — no network/JWKS. Reuses the existing ed25519 + trusted-reviewers path only.
- Carry forward the AISDLC-588 security-reviewer precondition where it intersects: the effective-tier computation must not let a leaf be credited `isolated` above what the signer identity proves.

## Acceptance Criteria
- [ ] A leaf declaring `isolated` under a root signed by a `ci-only` key ⇒ verifier reports `overallIndependenceTier: 'isolated'`.
- [ ] **Security-critical negative:** the SAME leaf/envelope re-signed by the OPERATOR key (not ci-only) ⇒ verifier downgrades to `attested`/`none` with a recorded reason, attestation still `status=valid` (does NOT reject).
- [ ] An integrity failure (tampered leaf / root sig matching no trusted key) still REJECTS.
- [ ] Verifier makes zero network calls (assert offline).
- [ ] Hermetic tests for credit, downgrade-with-reason, and integrity-reject paths.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0047 §Design Details (3) + §Verifier re-derivation contract + OQ-3 resolution. Frontmatter `dependencies` (AISDLC-593 ci-only trust set, AISDLC-594 anchorEvidence field) is authoritative.
<!-- SECTION:DESCRIPTION:END -->
