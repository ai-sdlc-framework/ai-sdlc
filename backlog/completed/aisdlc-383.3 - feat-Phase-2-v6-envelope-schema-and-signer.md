---
id: AISDLC-383.3
title: 'feat(attestation): RFC-0042 Phase 2 — v6 envelope schema + signer'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0042
  - phase-2
  - attestation
parentTaskId: AISDLC-383
dependencies:
  - AISDLC-383.2
priority: high
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
---

## Scope (RFC-0042 Phase 2)

Per RFC-0042 §Design Layer 4, implement the v6 attestation envelope schema and the signer that produces it. The v6 envelope carries per-reviewer transcript hashes, per-leaf Merkle inclusion proofs, the signed root, and the PR-bound nonce.

### v6 envelope shape (per RFC-0042)

```json
{
  "schemaVersion": "v6",
  "subject": { "digest": { "sha1": "<headSha>" } },
  "transcriptLeaves": [
    {"leafIndex": <n>, "reviewerName": "<name>", "transcriptHash": "<sha256>"}
  ],
  "merkleProofs": [
    {"leafIndex": <n>, "proof": ["<hash>", ...]}
  ],
  "rootHash": "<sha256>",
  "rootSignature": "<operator ed25519 over rootHash>",
  "nonce": "<32-byte hex bound to head sha>"
}
```

### Deliverables

1. **JSON schema** at `spec/schemas/attestation-envelope-v6.schema.json`
2. **Signer extension** in `ai-sdlc-plugin/scripts/sign-attestation.mjs`:
   - New `--schema-version v6` flag (default still v5 during transition)
   - Reads from `.ai-sdlc/transcript-leaves.jsonl` + computes proofs via AISDLC-383.2 primitives
   - Signs root with operator key (any-of-N per OQ-4)
   - Writes envelope to `.ai-sdlc/attestations/<head-sha>.dsse.json`
3. **Multi-key any-of-N** sign support per OQ-4 — operator can register multiple keys in `.ai-sdlc/trusted-reviewers.yaml`; signer uses whichever is locally available
4. CLI: `cli-attestation sign-v6` (manual invocation for testing); `cli-attestation inspect-v6 <envelope>` (pretty-print)
5. Hermetic tests covering: v6 sign happy path, missing transcript-leaves.jsonl, missing operator key, wrong key for registered identity

### Acceptance criteria

- [ ] #1 JSON schema defines v6 envelope shape + validates RFC-0042 §Design Layer 4 example
- [ ] #2 `sign-attestation.mjs --schema-version v6` produces valid v6 envelope
- [ ] #3 Any-of-N key support: signer picks any registered operator key that exists locally
- [ ] #4 Nonce bound to head sha (verifiable via head-sha → nonce derivation reproducibility from transcript)
- [ ] #5 CLI commands exist + tested
- [ ] #6 Hermetic test suite covers happy path + 3 error paths (missing leaves, missing key, schema-invalid envelope)
- [ ] #7 New code reaches 80%+ patch coverage

## Out of scope

- v6 verifier (deferred to AISDLC-383.4)
- Cutover from v5 (deferred to AISDLC-383.6)

## Source

RFC-0042 §Design Layer 4 + OQ-4 (any-of-N keys) + OQ-6 (nonce binding).
