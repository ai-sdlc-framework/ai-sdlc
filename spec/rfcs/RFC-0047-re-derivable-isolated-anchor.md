---
id: RFC-0047
title: Re-Derivable Isolated-Review Anchor
status: Draft
lifecycle: Draft
author: 'Dominique Legault'
created: 2026-09-06
updated: 2026-09-06
targetSpecVersion: v1alpha1
requires: [RFC-0043]
assumes: [RFC-0042, RFC-0046]
requiresDocs: []
---

# RFC-0047: Re-Derivable Isolated-Review Anchor

**Status:** Draft — mints the anchor mechanism that RFC-0046's `isolated` tier
depends on but did not specify to an implementable, verifier-checkable level. The
first implementation attempt (AISDLC-590 / PR #1021) shipped a self-asserted
anchor that a determined same-machine coordinator can forge; this RFC exists to
engineer the anchor correctly before the `isolated` tier ships. **5 §Open
Questions for operator walkthrough — none resolved here.**
**Lifecycle:** Draft
**Author:** Dominique Legault
**Created:** 2026-09-06

## Trigger

AISDLC-590 (RFC-0046 Phase 3) implemented the `isolated` tier's anchor as a
mint-time check on a self-asserted `report.provenance.deployment === 'ci'`
string, signed with the operator's ordinary key and never re-derived by the
verifier. A three-reviewer reconcile (2026-09-06) returned a **CRITICAL** finding:
the load-bearing tier is forgeable by exactly the actor RFC-0046 OQ-1 says it must
defend against. PR #1021 was held (not merged); the operator directed that the
anchor be designed in a dedicated follow-up RFC rather than iterated inline under
time pressure.

## Motivation

RFC-0046 models reviewer independence as a re-derivable tier and names `isolated`
as **the** load-bearing claim: "the review ran inside an RFC-0043 `SandboxDriver`
boundary the coordinator process cannot reach … the `isolated` anchor is
CI-re-derivable via RFC-0043's `deployment: ci` path (different infra)" and
"**Verifier** … re-derives the anchor via the RFC-0043 clean-room/CI path where
present." RFC-0046 resolved *that the anchor is re-derivable* (OQ-2 hybrid); it
did not resolve *how* re-derivation is cryptographically realized. That gap is
this RFC's subject.

### The forgery this RFC must close (verified, AISDLC-590 review)

A determined same-machine coordinator — the actor that holds the operator signing
key and also makes the ship decision — can, entirely locally, with no CI:

1. Hand-author (or locally-sandbox) an approved reviewer report and set
   `provenance.deployment: 'ci'` (a plain string; also derivable by setting
   `GITHUB_ACTIONS=true` in the local environment).
2. Run `clean-room-sign --independence-tier isolated`. The mint gate passes
   because the string says `ci`; the signing key resolves from
   `~/.ai-sdlc/signing-key.pem` — the **same** key whose pubkey is already in
   `.ai-sdlc/trusted-reviewers.yaml`.
3. The RFC-0042 v6 verifier accepts the leaf: the Merkle root is signed by a
   trusted key and the declared tier matches the Merkle-proved leaf. The verifier
   performs **no** `isolated`-specific re-derivation; `provenance` is discarded at
   sign time and never reaches the envelope.

Result: `overallIndependenceTier: 'isolated'` on a review the coordinator authored
itself. The tier collapses to "the operator's key signed it" — precisely the
sign-time-vouched (`attested`) trust model RFC-0046 deprecates as non-load-bearing.

**The invariant this RFC must establish:** an `isolated` leaf MUST be producible
ONLY by a process the coordinator does not control, and the verifier MUST be able
to re-derive that fact from evidence bound into the signed envelope — WITHOUT
trusting the operator's long-lived signing key as the sole authority for the
`isolated` claim.

## Proposal (design directions — to be selected via OQ walkthrough)

The lead direction (subject to OQ-1) is an **OIDC-re-derivable CI anchor** that
reuses GitHub's identity provider as the trust root for the `isolated` claim,
distinct from the operator's key:

- The `isolated` producing job in CI obtains a GitHub Actions **OIDC id-token**
  (`id-token: write`) whose claims (`repository`, `workflow_ref`, `job_workflow_ref`,
  `sha`, `run_id`) are signed by GitHub's JWKS and cannot be minted off-runner.
- The clean-room signer binds the OIDC token (or a verifiable digest of its
  claims) **into the signed transcript leaf** — so the evidence travels inside the
  Merkle-committed, operator-signed envelope and cannot be stripped without
  invalidating the root.
- The verifier, for any leaf declaring `independenceTier: 'isolated'`, **re-derives
  the anchor**: it validates the OIDC token against GitHub's published keys,
  confirms the `repository` / `workflow_ref` match the expected isolated-review
  workflow, and confirms the bound `sha` matches the PR head. A leaf whose anchor
  cannot be re-derived is **downgraded** (never over-claimed) to `attested`/`none`.
- Durability (the AISDLC-590 code-review MAJOR): the signed `isolated` envelope
  MUST be persisted (committed to the PR branch / uploaded and re-attached), not
  discarded on the ephemeral runner.

This makes `isolated` unforgeable by the same-machine coordinator: they cannot mint
a GitHub OIDC token for a CI run that did not happen, and the verifier's acceptance
no longer rests on the operator's key alone.

Alternative directions the walkthrough will weigh: a dedicated **CI-only signing
identity** the verifier pins for `isolated` (simpler than OIDC binding, but adds a
key to distribute and rotate), and **keyless signing via Sigstore/Rekor** (a
transparency-log anchor the verifier checks offline; strongest, heaviest, and
RFC-0046's deferred OQ-4 direction).

## Design Details

_(To be filled in after the OQ walkthrough resolves OQ-1/OQ-2. Placeholder so the
implementer has a single source of truth once the direction is chosen.)_

### Verifier re-derivation contract (sketch)

For each leaf with `independenceTier: 'isolated'`, the verifier MUST establish an
anchor from evidence bound in the signed envelope; if it cannot, it MUST downgrade
the leaf and MUST NOT report `isolated`. The re-derivation MUST NOT depend solely
on the operator's trusted signing key. Offline vs. online (network-required)
re-derivation is OQ-3.

## Open Questions

> None of the following are resolved in this Draft. They are for an operator
> rubric walkthrough (per the RFC OQ-walkthrough process). A dev subagent MUST NOT
> resolve these inline (AISDLC-298).

### OQ-1: Anchor trust root — GitHub OIDC vs. CI-only key vs. Sigstore/Rekor?

Which mechanism makes the `isolated` claim unforgeable by the same-machine
coordinator while remaining verifier-re-derivable: (A) GitHub OIDC id-token bound
into the leaf + verifier validation against GitHub JWKS; (B) a distinct CI-only
signing identity the verifier pins for `isolated`; (C) keyless Sigstore/Rekor with
a transparency-log re-derivation? Trade-offs: infra weight, offline-verifiability,
GitHub-coupling, key distribution/rotation.

### OQ-2: What evidence is bound into the signed leaf, and how?

The exact fields (raw OIDC JWT vs. a canonical digest of selected claims;
`run_id` / `workflow_ref` / `sha` / `repository`), and how they are bound into the
RFC-0042 leaf preimage without breaking the AISDLC-588 additive-compat hashing
boundary (a leaf omitting the field must still hash like a legacy leaf; only a
genuine `isolated` leaf binds the anchor evidence).

### OQ-3: Offline vs. online verification.

Does verifier re-derivation require a live network call (GitHub API / JWKS fetch),
or must it be offline-verifiable (favoring the Rekor/transparency-log direction)?
CI verifiers have network; adopter/consumer-repo verifiers and audit replays may
not. What is the degraded behavior when the network is unavailable — fail closed,
or downgrade to `attested` with a recorded reason?

### OQ-4: Envelope durability + retrieval.

Where does the signed `isolated` envelope live so a downstream verifier can find
it (commit to the PR branch like the pre-push chore commit, upload+re-attach, or a
separate attestations ref)? This closes the AISDLC-590 code-review MAJOR (the
minted claim was discarded on the ephemeral runner).

### OQ-5: Migration + relationship to RFC-0046.

RFC-0046 remains the owner of the tier taxonomy and the `none`/`attested`
behavior (both shipped: AISDLC-588/589). Does RFC-0047 supersede only RFC-0046's
`isolated` §Behavioral-Changes bullets, or also re-open the OQ-5 policy
(`requiredTier: isolated`) so a repo cannot require a tier that is not yet
producible? Until this RFC ships, `requiredTier: isolated` MUST be unsatisfiable
(policy config referencing it should warn/reject).

## Sign-Off

| Role | Owner | Status |
| --- | --- | --- |
| Engineering | Dominique Legault | ⏸ Pending |
| Operator | Dominique Legault | ⏸ Pending |
| Product | Alex | ⏸ Pending |
| Design | Morgan | ⏸ Pending |

## Revision History

| Date | Change |
| --- | --- |
| 2026-09-06 | Draft minted. Splits the `isolated` anchor mechanism out of RFC-0046 after AISDLC-590 / PR #1021's CRITICAL forgeability finding. 5 OQs for operator walkthrough; no OQ resolved. |
