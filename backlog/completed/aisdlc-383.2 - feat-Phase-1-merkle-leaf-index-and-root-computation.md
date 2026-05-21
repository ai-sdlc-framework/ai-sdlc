---
id: AISDLC-383.2
title: 'feat(attestation): RFC-0042 Phase 1 — Merkle leaf index + root computation'
status: Done
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0042
  - phase-1
  - attestation
  - merkle
parentTaskId: AISDLC-383
dependencies:
  - AISDLC-383.1
priority: high
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
---

## Scope (RFC-0042 Phase 1)

Per RFC-0042 §Design Layer 2 + Layer 3, implement the append-only Merkle leaf index and root computation. Each reviewer transcript is hashed; the hash becomes a leaf in an append-only Merkle tree. The slash command body computes and signs the running root.

### Deliverables

1. **Append-only leaf file** at `.ai-sdlc/transcript-leaves.jsonl` (committed, never pruned):
   ```jsonl
   {"leafIndex": <n>, "taskId": "<id>", "reviewerName": "<name>", "transcriptHash": "<sha256>", "nonce": "<hex>", "harness": "<name>", "model": "<name>", "verdictApproved": <bool>, "findings": {...}, "signedAt": "<iso>"}
   ```
2. **Merkle tree implementation** in `pipeline-cli/src/attestation/merkle.ts` — pure-TS, no external deps, standard binary Merkle with sha256
3. **Root computation** — function `computeMerkleRoot(leaves)` returns 32-byte root hash + per-leaf inclusion proofs
4. **Nonce generation** per RFC-0042 §Nonce binding — 32-byte hex, bound to PR's head sha
5. CLI: `cli-attestation merkle-root` (prints current root + leaf count); `cli-attestation merkle-proof <leafIndex>` (prints proof path)
6. Hermetic tests covering: single-leaf tree, multi-leaf tree, inclusion proof verification, append idempotency

### Acceptance criteria

- [ ] #1 `.ai-sdlc/transcript-leaves.jsonl` append-only writes work; corruption-resistant (atomic append)
- [ ] #2 `computeMerkleRoot(leaves)` returns deterministic 32-byte root + valid inclusion proofs for every leaf
- [ ] #3 Inclusion proof verification function `verifyInclusion(leafHash, proof, root)` returns true for valid proofs, false otherwise
- [ ] #4 Nonce generation produces 32-byte hex, bound via inclusion in transcript prompts (OQ-6 — first push IS genesis)
- [ ] #5 CLI commands exist + tested
- [ ] #6 Hermetic test suite covers single-leaf, multi-leaf, append idempotency, tampered-leaf detection, valid + invalid proofs
- [ ] #7 New code reaches 80%+ patch coverage

## Out of scope

- v6 envelope schema (deferred to AISDLC-383.3)
- Operator signing of the root (deferred to AISDLC-383.3)
- CI verifier (deferred to AISDLC-383.4)

## Source

RFC-0042 §Design Layers 2-3 + OQ-6 (first push IS genesis, no ceremony).
