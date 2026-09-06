---
id: RFC-0047
title: Re-Derivable Isolated-Review Anchor
status: Draft
lifecycle: Ready for Review
author: 'Dominique Legault'
created: 2026-09-06
updated: 2026-09-06
targetSpecVersion: v1alpha1
requires: [RFC-0043]
assumes: [RFC-0042, RFC-0046]
requiresDocs: []
---

# RFC-0047: Re-Derivable Isolated-Review Anchor

**Status:** Ready for Review — **all 5 OQs resolved 2026-09-06 via operator rubric
walkthrough** (sign-off + phase tasks follow in the RtR→Signed Off PR). The `isolated` anchor is a **CI-only ed25519 key** (private half only
in a protected GitHub Actions environment; pubkey in `trusted-reviewers.yaml` marked
`ci-only`) — the security anchor is the *root signature by that key*, which a
same-machine coordinator holding the operator key cannot produce, while the verifier
stays **100% offline** (reuses the existing ed25519 + `trusted-reviewers.yaml` spine,
no JWKS/network). `{runId, workflowRef, signerKeyId}` are bound into the hashed leaf
as **audit-only** evidence (closing the AISDLC-590 over-claim). An `isolated` claim
without a verifying `ci-only` anchor **downgrades** to its computed tier with a
recorded reason (integrity failures still reject); the hard block lives at the
Phase-4 policy layer. The CI job **commits the attestation-only envelope to the PR
branch** (durable, patch-id-findable — fixing the AISDLC-590 "claim discarded"
MAJOR). Scope split: RFC-0046 keeps the taxonomy + `none`/`attested` + the
`requiredTier` policy engine; RFC-0047 owns the `isolated` producer/verifier and a
single "isolated producible" capability gate (`requiredTier: isolated` is
unsatisfiable until this RFC ships). Sigstore/Rekor is the documented forward
hardening path.
**Lifecycle:** Ready for Review
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

Resolved by the OQ walkthrough (2026-09-06). The implementation surface:

1. **`ci-only` trust marker** — extend `.ai-sdlc/trusted-reviewers.yaml` entries with an
   optional `ciOnly: true` flag; the verifier's trusted-key loader
   (`verify-core.mjs:2426-2430`) partitions keys into operator vs. `ci-only` sets.
2. **`anchorEvidence` leaf field** — append `anchorEvidence?: { runId, workflowRef,
   signerKeyId }` (fixed internal key order; `undefined` when absent) as the last key in
   the hashed leaf (`merkle-core.mjs` `hashLeaf`), the `TranscriptLeaf` interface
   (`merkle.ts`), and the envelope summary (`sign-v6.ts`). Add the additive-compat
   hash-identity test mirroring AISDLC-588. **Audit-only** — not the security anchor.
3. **Verifier `isolated` re-derivation** — in the per-leaf `independenceTier` block
   (`verify-core.mjs:1308-1334`): a leaf resolving to `isolated` is credited ONLY if the
   Merkle root signature verifies under a `ci-only` key; otherwise the leaf's effective
   tier is downgraded to its evidence-computed value with a recorded reason. Integrity
   (Merkle/signature) failures still reject. Stays fully offline.
4. **`isolated` producer + CI workflow** — the internal-isolated-review path runs the
   reviewers in the RFC-0043 sandbox, emits the unsigned report, and the clean-room signer
   (invoked in a SEPARATE, protected CI job that materializes the `ci-only` key — never the
   operator key, never inside the sandbox) mints the envelope stamped `independenceTier:
   isolated` with `anchorEvidence`. The job then commits the attestation-only envelope to
   the PR branch (`contents: write`, protected environment) — no operator sentinel/key.
5. **Capability gate** — a single `isolatedTierAvailable()` source of truth the RFC-0046
   `requiredTier` policy engine consults; `requiredTier: isolated` warns/rejects while it
   returns false.

### Verifier re-derivation contract

For each leaf resolving to `independenceTier: 'isolated'`, the verifier credits the tier
ONLY when the Merkle root signature verifies under a `ci-only`-marked trusted key; the
trust MUST NOT rest solely on the operator's key. If the `ci-only` anchor cannot be
established, the verifier downgrades the leaf to its evidence-computed tier with a recorded
reason and MUST NOT report `isolated` (OQ-3). Verification is fully offline (OQ-1).

## Open Questions

> **All 5 resolved 2026-09-06 via operator rubric walkthrough.** The original
> question text is preserved for context; each Resolution block records the
> reasoning, industry research, counter-argument, and why the choice won.

### OQ-1: Anchor trust root — GitHub OIDC vs. CI-only key vs. Sigstore/Rekor?

Which mechanism makes the `isolated` claim unforgeable by the same-machine
coordinator while remaining verifier-re-derivable: (A) GitHub OIDC id-token bound
into the leaf + verifier validation against GitHub JWKS; (B) a distinct CI-only
signing identity the verifier pins for `isolated`; (C) keyless Sigstore/Rekor with
a transparency-log re-derivation? Trade-offs: infra weight, offline-verifiability,
GitHub-coupling, key distribution/rotation.

**Resolution (2026-09-06, full rubric): CI-only ed25519 key (option B) for v1, with the leaf/verifier seam designed to swap to Sigstore later.** A second keypair whose private half lives ONLY in a protected GitHub Actions environment; its pubkey is added to `.ai-sdlc/trusted-reviewers.yaml` marked `ci-only`; the verifier requires a leaf declaring `isolated` to be under a Merkle root signed by that `ci-only` key. Industry research: npm/PyPI provenance (already in `release.yml`) uses GitHub OIDC→Fulcio→Rekor; `gh attestation verify` binds to a workflow identity; the simplest "only CI can sign X" pattern is a CI-held key distinct from developer keys. **Substantive gap this closes:** AISDLC-590 anchored `isolated` on a self-asserted `deployment: 'ci'` string signed with the operator's OWN key — forgeable by exactly the OQ-1 same-machine coordinator. **Why B over OIDC-JWT (A) and Sigstore (C):** the survey confirmed the verifier is 100% offline (no JWT/JWKS code, ed25519-only, trust = `trusted-reviewers.yaml`); B is the only option that PRESERVES that offline invariant at near-zero new infra (reuses the ed25519 + trusted-key spine) and directly kills the exploit (the local coordinator has the operator key, not the CI secret). **Counter-argument:** "B is theater — the determined coordinator is often the repo admin, who can commit a workflow that exfiltrates the CI secret; only Sigstore's transparency log makes forgery *publicly detectable*." Rebuttal: B moves forgery from an invisible local one-liner to an attacker-authored workflow that must land on a protected branch and lives forever in git history — the detectability RFC-0046 wanted — and GitHub **environment protection rules** (required reviewers on the signing environment) close the malicious-workflow path for all but a reviewer-colluding admin. B also composes forward: the `ci-only` key can later be replaced by keyless Sigstore without touching the leaf/verifier seam. **Selected over C** for v1 on offline-preservation + shipping cost (Sigstore is the documented forward hardening path); **over A** because C strictly dominates A's identity strength while keeping offline verify.

### OQ-2: What evidence is bound into the signed leaf, and how?

The exact fields (raw OIDC JWT vs. a canonical digest of selected claims;
`run_id` / `workflow_ref` / `sha` / `repository`), and how they are bound into the
RFC-0042 leaf preimage without breaking the AISDLC-588 additive-compat hashing
boundary (a leaf omitting the field must still hash like a legacy leaf; only a
genuine `isolated` leaf binds the anchor evidence).

**Resolution (2026-09-06, full rubric): the security anchor is the `ci-only` root signature (OQ-1); ALSO bind `{runId, workflowRef, signerKeyId}` into the hashed leaf as a fixed-key-order trailing `anchorEvidence` object, explicitly labeled AUDIT-ONLY.** Industry research: SLSA/in-toto provenance binds builder identity + invocation metadata into the signed predicate so auditors can trace which run produced an artifact, while the *trust decision* rests on the signer identity, not the metadata strings. The survey confirmed the leaf's trailing-optional pattern (`verdictClass`/`independenceTier`, `merkle-core.mjs:96-103`) is low-friction to extend, with one caveat: a nested object needs a fixed internal key order (like the existing `findings` sub-object) and MUST be `undefined` when absent (never `null`/`{}`), following the `independenceTier` precedent, or legacy leaves stop hashing identically (the AISDLC-588 additive-compat invariant). **Substantive gap this closes:** AISDLC-590's MAJOR was that `runId`/`workflowRef` were *documented as verification evidence but never bound or checked* (a trust-word over-claim). **Refinement:** the fields become bound (tamper-evident) and auditable, while the spec states in plain terms that the security anchor is the signer identity, NOT these strings. **Counter-argument:** "any bound-but-not-security-checked field re-invites the exact 'looks like verification' smell that just bit us; if the `ci-only` signature is the whole security story, add nothing." Rebuttal: the smell came from *mislabeling*, not from binding — SLSA binds invocation metadata precisely so incident response can trace a bad signer's runs, and an unbound envelope-header `runId` is forgeable free-text that is *worse* for audit. **Selected over "bind nothing"** on audit value with identical security surface; **over per-leaf signatures** because the Merkle root already provides per-leaf integrity under the one signature.

### OQ-3: Offline vs. online verification.

Does verifier re-derivation require a live network call (GitHub API / JWKS fetch),
or must it be offline-verifiable (favoring the Rekor/transparency-log direction)?
CI verifiers have network; adopter/consumer-repo verifiers and audit replays may
not. What is the degraded behavior when the network is unavailable — fail closed,
or downgrade to `attested` with a recorded reason?

**Resolution (2026-09-06, full rubric): fully OFFLINE (settled by OQ-1's key anchor — no JWKS/network); and when an `isolated` claim's `ci-only` anchor can't be established, the verifier COMPUTES the effective tier from evidence and DOWNGRADES with a recorded reason — it does NOT reject the attestation.** The verifier derives the tier from re-derivable evidence (`ci-only` signer ⇒ isolated-eligible; else ≤ `attested`), treats the envelope's *declared* tier as advisory, and never over-claims. Industry research: Sigstore/`gh attestation verify`/cosign fail-closed on a bad *signature* but treat *identity/policy* shortfalls as reported outcomes, not crashes — verify integrity, then evaluate identity against policy and report. The existing RFC-0046 verifier already computes `overallIndependenceTier` as a weakest-link rather than trusting a declared value (`verify-core.mjs:1372-1402`); the `isolated`-specific re-derivation slots into the per-leaf `independenceTier` block (`verify-core.mjs:1308-1334`). **Load-bearing distinction:** Merkle/signature *integrity* failures still REJECT (unchanged); only an *anchor/identity* shortfall downgrades. A forger who declares `isolated` and signs with the operator key simply gets `attested` — they gain nothing, so downgrade is exactly as safe as reject. **Counter-argument:** "silent downgrade hides misconfiguration — a repo that *requires* `isolated` (Phase 4) then fails with a confusing 'tier too low' instead of a clear 'anchor missing'; a hard reject is more debuggable." Rebuttal: downgrade carries a **recorded reason** ("isolated requested but no `ci-only` anchor: <why>"), the exact actionable signal the Phase-4 policy gate surfaces at enforcement — while a global reject would fail *even repos that use `isolated` only informationally*, violating RFC-0046's "opt-in, informational by default." The hard block belongs at the policy layer (OQ-5), not the integrity layer. **Selected over reject** on correct layering + opt-in scoping.

### OQ-4: Envelope durability + retrieval.

Where does the signed `isolated` envelope live so a downstream verifier can find
it (commit to the PR branch like the pre-push chore commit, upload+re-attach, or a
separate attestations ref)? This closes the AISDLC-590 code-review MAJOR (the
minted claim was discarded on the ephemeral runner).

**Resolution (2026-09-06, full rubric): the isolated-review CI job COMMITS the attestation-only envelope to the PR branch and pushes it** (`.ai-sdlc/attestations/<patch-id>.v6.dsse.json` + its leaf file), so the offline, patch-id-keyed verifier finds it by the unchanged lookup. Industry research: `actions/attest-build-provenance` pushes attestations to a durable store rather than leaving them on the runner; SLSA provenance is published as a first-class retrievable artifact; workflow *artifacts* expire (~90 days) and aren't content-addressable — unsuitable for an indefinitely-auditable claim. The repo's model is "envelope committed in git, found by patch-id," and the AISDLC-419 attestation-only-descendant relaxation already tolerates such a commit without invalidating head-binding. **Substantive gap this closes:** AISDLC-590 signed the `isolated` envelope and then DISCARDED it on the ephemeral runner (code-review MAJOR) — and it requested an *unused* `contents: write`; here `contents: write` is scoped to the isolated-review job inside the same protected environment that guards the `ci-only` key, and it is genuinely USED to commit the envelope. **Counter-argument:** "CI pushing to the PR branch broadens the CI token, can race with developer pushes/rebases, and adds commit-graph churn — an artifact keeps the branch immutable." Rebuttal: artifacts expire and aren't content-addressable, failing the exact durability + offline-audit requirement this OQ exists for; and a push race degrades *gracefully* via OQ-3 (a not-yet-committed envelope just downgrades the tier, never breaks the PR) with CI re-running on the new head — the same rebase-tolerant model the existing pre-push chore-commit relies on. **Selected over artifact/status** on durability + offline-auditability; **over an operator-commits-in-finalize hand-off** because the goal is CI-produced-without-the-operator.

### OQ-5: Migration + relationship to RFC-0046.

RFC-0046 remains the owner of the tier taxonomy and the `none`/`attested`
behavior (both shipped: AISDLC-588/589). Does RFC-0047 supersede only RFC-0046's
`isolated` §Behavioral-Changes bullets, or also re-open the OQ-5 policy
(`requiredTier: isolated`) so a repo cannot require a tier that is not yet
producible? Until this RFC ships, `requiredTier: isolated` MUST be unsatisfiable
(policy config referencing it should warn/reject).

**Resolution (2026-09-06, full rubric): scope split — RFC-0046 keeps the tier taxonomy + `none`/`attested` + the `requiredTier` policy ENGINE; AISDLC-591 ships that engine NOW for `none`/`attested` (on shipped 588/589). RFC-0047 owns the `isolated` producer/verifier AND flips a single "isolated producible" capability the engine consults.** `requiredTier: isolated` warns/rejects until RFC-0047 ships, then becomes satisfiable. RFC-0047 supersedes ONLY RFC-0046's `isolated` §Behavioral-Changes bullets; it does not re-open RFC-0046's settled OQ-5 policy design. Industry research: standard capability-gated rollout — a policy engine consults a single "is capability X available?" check and rejects configs that require an unavailable capability; and a follow-up RFC supersedes only the specific superseded sections (the project's "mint new, don't re-amend" convention). **Counter-argument:** "splitting `requiredTier` enforcement across two implementations risks an AISDLC-421-class seam bug — 591 ships a `requiredTier: isolated` path that's dead/rejecting until RFC-0047 wires it later." Rebuttal: the seam is ONE capability boolean ("isolated producible?") with a single source of truth, plus a test asserting `requiredTier: isolated` rejects pre-RFC-0047 and satisfies post- — not scattered logic. **Selected over "hold all of Phase 4"** because that delays shipped-ready `none`/`attested` policy value for zero security benefit (those tiers don't depend on the anchor); **over "RFC-0047 absorbs the whole policy"** because that re-opens a settled parent decision.

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
| 2026-09-06 | **OQ walkthrough — all 5 OQs resolved via full rubric; Draft → Ready for Review.** OQ-1: CI-only ed25519 key anchor (offline-preserving, reuses ed25519/trusted-reviewers; Sigstore is the forward hardening path). OQ-2: bind `{runId, workflowRef, signerKeyId}` as an audit-only trailing leaf field (closes the 590 over-claim); signer identity is the security anchor. OQ-3: fully offline; unanchored `isolated` downgrades with a recorded reason (integrity failures still reject). OQ-4: CI commits the attestation-only envelope to the PR branch (fixes the 590 discarded-claim MAJOR). OQ-5: RFC-0046 keeps the taxonomy + `none`/`attested` + policy engine (591 ships now); RFC-0047 owns the `isolated` producer/verifier + a single capability gate; `requiredTier: isolated` unsatisfiable until this RFC ships. Design Details filled. |
