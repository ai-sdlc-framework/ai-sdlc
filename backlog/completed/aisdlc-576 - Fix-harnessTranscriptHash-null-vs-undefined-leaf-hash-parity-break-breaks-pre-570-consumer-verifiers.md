---
id: AISDLC-576
title: >-
  Fix harnessTranscriptHash null-vs-undefined leaf-hash parity break (breaks
  pre-570 consumer verifiers)
status: Done
assignee: []
created_date: '2026-09-05 16:15'
updated_date: '2026-09-05'
labels:
  - attestation
  - proof-of-execution
  - adoption
  - aisdlc-570-followup
dependencies: []
priority: high
---

> **RESOLVED / SUPERSEDED by [[aisdlc-579]] (PR #1005, merged 2026-09-05).** The
> root cause here (sign includes `harnessTranscriptHash`, verify's copy omitted
> it → divergent leaf hash) was fixed by single-sourcing the Merkle/leaf-hash
> into `pipeline-cli/attestation-core/merkle-core.mjs`, so sign and verify now
> hash the field identically — the null-vs-undefined divergence is gone WITHIN a
> version (proven: a 3-leaf `harnessTranscriptHash:null` envelope verifies
> `status=valid` under the fixed core, no strip needed). The only residual is a
> pre-579 published verifier checking a post-579 producer's envelope, which is
> mitigated by the AISDLC-574 runtime-pin floor + the AISDLC-578 doctor
> reachability check. No separate emit-leaf "omit the field" change is needed.
> Closed without its own PR.


## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`pipeline-cli/src/attestation/merkle.ts` `hashLeaf()` documents an additive-field backward-compat contract (AISDLC-568/570): a trailing field that is `undefined` is dropped by `JSON.stringify`, so a leaf WITHOUT the field hashes IDENTICALLY to a pre-568/570 leaf. This is what lets a newer envelope still verify under an older verifier.

**The contract is broken for `harnessTranscriptHash`** because `emit-leaf` writes the field as an explicit `null` (not `undefined` / omitted) when no harness transcript is bound. `JSON.stringify` KEEPS `null` (`"harnessTranscriptHash":null`), so a post-570 signer's leaf hash differs from what a pre-570 verifier computes (whose `hashLeaf` ordered-object has no `harnessTranscriptHash` key at all). Result: **rootHash mismatch → `rootSignature did not match any trusted reviewer pubkey` → false REJECT.**

## Evidence (observed 2026-09-05, reconciling PR #1001 / AISDLC-575)

- Signed envelope `c78ea7c4…v6.dsse.json`, leaves all `harnessTranscriptHash: null`.
- rootSignature verifies against the operator key over the stored rootHash (signature is valid).
- Worktree (current-main source) merkle recompute MATCHES the signed rootHash → self-consistent.
- BUT the **published `@ai-sdlc/orchestrator` 0.19.0** runtime (and a stale local build) recompute a DIFFERENT rootHash → `status=invalid`. Root cause: their `hashLeaf` predates the `harnessTranscriptHash` field, and the explicit `null` in the leaf is NOT dropped, so the two sides serialize different canonical JSON.

## Why it matters (adoption path)

This is exactly the AISDLC-575 consumer scenario: a consumer running the plugin-less verify CLI with a PUBLISHED pipeline-cli/orchestrator that is one release behind the producer's main will **false-reject a valid attestation**. The dogfood CI is unaffected only because it builds the verifier from main source (both sides post-570). Any real adopter pinned to a released runtime older than the producer's leaf-schema is bitten.

## Scope

1. Make `emit-leaf` OMIT `harnessTranscriptHash` (leave `undefined` / don't write the key) when there is no bound harness transcript, instead of writing explicit `null`. Same audit for `verdictClass` and any other additive field — confirm each preserves the `undefined`-dropped parity contract when absent. (If a value IS present, it is correctly included on both sides ≥ the introducing version — that's expected and fine.)
2. Add a hermetic PARITY test: a leaf with the field absent must hash-equal a synthetic pre-field leaf (assert byte-equal canonical JSON AND equal `hashLeaf` output). A leaf with the field = explicit `null` must be treated identically to absent (either normalize null→omit at emit time, or make `hashLeaf` drop null for these trailing fields — pick one and test it).
3. Decide + document the canonicalization rule for trailing additive fields (null === absent) in RFC-0042 §Layer 2, so future additive fields don't reintroduce this.
4. Regression-guard: a test that signs with the current schema and verifies with a simulated pre-field `hashLeaf` (the backward-compat direction the contract promises).

## Acceptance Criteria
- emit-leaf no longer writes explicit `null` for unbound `harnessTranscriptHash` (field omitted), OR `hashLeaf` provably treats `null`===absent — with a test proving byte-identical canonical JSON to a pre-570 leaf.
- Hermetic parity test covering absent / null / present for harnessTranscriptHash AND verdictClass.
- A post-schema-N envelope verifies under a simulated schema-(N-1) `hashLeaf` (backward-compat direction).
- RFC-0042 §Layer 2 documents the null===absent trailing-field rule.
- `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note
Discovered during AISDLC-575 reconcile; NOT introduced by 575 (575 is verify-CLI plumbing). Composes with [[aisdlc-570]] (introduced the field) and [[aisdlc-575]] (consumer verify path this bug degrades). Does not block #1001 (dogfood CI is source-built, both sides post-570).
<!-- SECTION:DESCRIPTION:END -->
