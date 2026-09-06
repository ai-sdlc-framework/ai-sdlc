# `ci-only` trust marker — operator runbook

> RFC-0047 Phase 1 (AISDLC-593) — foundational seam for the `isolated`
> re-derivable anchor. See [RFC-0047](../../spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md)
> §Design Details (1) and OQ-1 for the full design rationale.

## What this is

`.ai-sdlc/trusted-reviewers.yaml` entries may carry an optional `ciOnly: true`
flag. It marks a signing key whose **private half lives ONLY in a protected
GitHub Actions environment** — never on any operator's machine. The verifier
partitions trusted keys into two sets (operator keys vs. `ci-only` keys) so
a later phase (RFC-0047 Phase 3) can require the `isolated` independence
tier's Merkle root signature to come specifically from a `ci-only` key —
closing the AISDLC-590 gap where `isolated` was anchored on a self-asserted
string signed with the operator's OWN key (forgeable by exactly the
same-machine coordinator RFC-0046 OQ-1 worried about).

**Phase 1 scope (this document, AISDLC-593):** the flag exists and the
verifier can tell the two key classes apart. **No existing verification
outcome changes** — an envelope signed by an operator key (the default,
`ciOnly` absent) verifies byte-for-byte exactly as before. Tier-crediting
logic that actually REQUIRES a `ci-only` signature for `isolated` ships in
RFC-0047 Phase 3.

## Why the private key must never touch an operator machine

The entire security value of the `ci-only` marker is that a person with
full disk access to their own laptop — including the coordinator that
makes ship/no-ship decisions on a PR — CANNOT produce a valid `ci-only`
signature. If the private key is ever copied to an operator machine (even
temporarily, even for testing), that guarantee is void and every
`isolated`-tier claim signed since becomes exactly as forgeable as an
operator-signed claim.

## Registering a `ci-only` key

1. **Generate a dedicated keypair** (do this ON the machine that will hold
   the private key ONLY as an ephemeral generation step — the private key
   file must not persist anywhere except the GitHub secret):

   ```bash
   openssl genpkey -algorithm ed25519 -out /tmp/ci-only-key.pem
   openssl pkey -in /tmp/ci-only-key.pem -pubout
   ```

2. **Store the private key in a protected GitHub Actions environment**
   (`Settings > Environments > <env-name> > Environment secrets`), with
   **required reviewers** configured on that environment so a workflow run
   cannot use the secret without an approval gate. This is what makes the
   "attacker-authored workflow" path detectable and blockable (see RFC-0047
   OQ-1's counter-argument/rebuttal) rather than a silent exfiltration path.

3. **Delete the local private key file** immediately after step 2:

   ```bash
   shred -u /tmp/ci-only-key.pem 2>/dev/null || rm -f /tmp/ci-only-key.pem
   ```

4. **Add the public key entry** to `.ai-sdlc/trusted-reviewers.yaml`, marked
   `ciOnly: true`, using the strict format the hand-rolled YAML loader
   requires (see the file's own header comment for the general format
   rules — string scalars single-quoted, PEM as a `|` block scalar indented
   exactly 6 spaces; `ciOnly` is the one field that is an **unquoted**
   boolean):

   ```yaml
     - identity: 'ci-only@ai-sdlc.io'
       machine: 'gha-isolated-review-job'
       addedAt: '2026-09-06'
       addedBy: 'deefactorial'
       ciOnly: true
       pubkey: |
         -----BEGIN PUBLIC KEY-----
         <base64-encoded pubkey>
         -----END PUBLIC KEY-----
   ```

5. **Open a PR** with the new entry — same review process as any other
   `trusted-reviewers.yaml` change (a maintainer reviews + merges).

## Verifying the partition (developer reference)

```js
import {
  partitionTrustedReviewers,
  isCiOnlyKey,
} from '@ai-sdlc/pipeline-cli/attestation-core/verify-core.mjs';

const { operatorKeys, ciOnlyKeys } = partitionTrustedReviewers(trustedReviewers);
isCiOnlyKey(somePubkeyPem, trustedReviewers); // true | false
```

Both helpers operate on the already-validated `TrustedReviewer[]` array
(the output of `validateTrustedReviewers`) — they do not re-parse YAML.

## Removing a `ci-only` entry

Same as removing any trusted-reviewer entry: open a PR deleting the row.
Any `isolated`-tier claim that depended on that key's signature (once
Phase 3 ships tier-crediting) becomes unverifiable retroactively, so
coordinate with whoever owns the protected GitHub Actions environment
before removing.

## Related

- [RFC-0047 — Re-derivable isolated anchor](../../spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md)
- [RFC-0046 — Attested reviewer independence](../../spec/rfcs/RFC-0046-attested-reviewer-independence.md)
- [`docs/operations/mcp-server-signing.md`](mcp-server-signing.md) — a similar
  "register a dedicated key in `trusted-reviewers.yaml`" flow for a
  different (non-`ci-only`) purpose; useful for comparison.
