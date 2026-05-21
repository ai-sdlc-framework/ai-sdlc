---
id: AISDLC-383.4
title: 'feat(attestation): RFC-0042 Phase 2 — v6 verifier in verify-attestation.yml'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0042
  - phase-2
  - attestation
  - ci
parentTaskId: AISDLC-383
dependencies:
  - AISDLC-383.3
priority: high
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - .github/workflows/verify-attestation.yml
  - scripts/verify-attestation.mjs
---

## Scope (RFC-0042 Phase 2)

Per RFC-0042 §Design Layer 5, implement the CI verifier for v6 envelopes. Verifier checks: root signature against trusted-reviewers.yaml, Merkle proof validity, leaf-presence in committed `.ai-sdlc/transcript-leaves.jsonl`, nonce binding to PR head sha. No external service dependency.

### Deliverables

1. **`scripts/verify-attestation.mjs` extension** — v6 branch:
   - Detect v6 envelope by schemaVersion field
   - Verify `rootSignature` against any-of-N pubkeys in `.ai-sdlc/trusted-reviewers.yaml` (per OQ-4)
   - Verify each Merkle proof: `proof + leaf → rootHash` chain
   - Verify each leaf's `transcriptHash` matches the committed leaf at `leafIndex` in `.ai-sdlc/transcript-leaves.jsonl`
   - Verify `nonce` derivable from head sha (matches what signer used)
2. **Verifier preference order**: v6 → v5 → v4 → v3 (latest first, fallback for legacy per OQ-7)
3. **Soft-fail-on-missing-transcript** per OQ-3 (when operator triggers spot-check; not in default verify path which is on-demand only per OQ-2)
4. **`.github/workflows/verify-attestation.yml`** updated:
   - v6 envelopes verify via new branch
   - Legacy envelopes (v3/v4/v5) still verify via existing code (kept indefinitely per OQ-7)
5. Hermetic tests covering: v6 happy path, tampered leaf, wrong nonce, unknown operator key, mixed-version envelope (v6 + v5 fallback)

### Acceptance criteria

- [ ] #1 `verify-attestation.mjs` correctly verifies valid v6 envelopes
- [ ] #2 Rejects v6 envelopes with: bad root signature, invalid Merkle proof, missing/tampered leaf, wrong nonce
- [ ] #3 Falls back to v5/v4/v3 verifier for legacy envelopes (no regression on existing PRs)
- [ ] #4 `verify-attestation.yml` workflow runs v6 verifier on PRs with v6 envelope
- [ ] #5 Hermetic test suite covers happy path + 4 error paths + 1 mixed-version path
- [ ] #6 Soft-fail-on-missing-transcript path emits informational warning, exit 0 (OQ-3)
- [ ] #7 New code reaches 80%+ patch coverage

## Out of scope

- Automated spot-check sampling (OQ-2 resolution: 0% automated; on-demand operator-triggered only via `cli-attestation spot-check`)
- LLM-as-judge content plausibility (future RFC)
- Cutover from v5 (deferred to AISDLC-383.6)

## Source

RFC-0042 §Design Layer 5 + OQ-2 (0% automated spot-check) + OQ-3 (soft-fail on missing transcript) + OQ-7 (legacy verifiers stay indefinitely).
