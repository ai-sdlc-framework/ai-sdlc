---
id: AISDLC-498
title: 'feat: RFC-0043 Phase 2 — Report schema + Zod validator + clean-room signer wiring to RFC-0042 v6'
status: To Do
assignee: []
created_date: '2026-06-02'
labels:
  - rfc-0043
  - untrusted-pr-verification
  - phase-2
  - stage-4
  - clean-room
  - attestation
dependencies:
  - AISDLC-497
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of RFC-0043. Defines the trust boundary between the untrusted-execution environment (Stages 2-3) and the credential-holding signing step (Stage 4). The signing key NEVER touches the sandbox; a hardened signer reads + Zod-validates the unsigned report artifact before minting the RFC-0042 v6 attestation.

## Scope (RFC-0043 §Stage 4 + OQ-4 resolution)

### Report schema

- `spec/schemas/untrusted-pr-report.v1.schema.json` — JSON Schema for the unsigned report artifact per RFC §Design Details
- Mirrored Zod definition at `pipeline-cli/src/pipeline/report-validator.ts`
- Schema aligned with the existing reviewer verdict contract (`approved` boolean + severity-tagged findings); NO `confidenceScore` / `complexityDelta` / `cveDetected` parallel vocabulary
- Covers: `schemaVersion`, `prNumber`, `headSha`, `baseSha`, `generatedAt`, `trust.{classification, reason}`, `astGate.{outcome, offendingPaths}`, `differentialTest.{upstreamSuitePassed, newTestsPassed, newCodeCoveragePct}`, `reviewers.{code, test, security}`, `consensus.{approved, blockingFindings}`

### Clean-room signer

- New hardened signer step (operator's machine for local flow; minimal isolated job for CI flow)
- Reads unsigned report artifact emitted by sandbox (Stages 2-3 — Phase 3 / AISDLC-499)
- **Re-validates against Zod boundary schema** — malformed or tampered reports rejected BEFORE any key is touched
- Builds RFC-0042 v6 Merkle tree from committed transcript leaves
- Signs Merkle root with operator's ed25519 key (OUTSIDE sandbox)
- Writes v6 DSSE envelope per RFC-0042 §"v6 envelope schema"
- Signing key NEVER present in any environment that executed untrusted code

### OQ-4 resolution: operator-key Merkle ONLY for v1

- NO fork to keyless-OIDC / Sigstore for OSS-cross-org case
- `Decision: untrusted-pr-sigstore-anchor-request` Stage A counter wired (no v1 activation; counter only)
- Auto-promote threshold: ≥2 distinct adopter requests → trigger follow-on RFC

### Hermetic tests

- Schema round-trip: write report → validate → mutate → re-validate fails
- Clean-room signer: signs only after Zod validation passes
- Tampered report rejected at Zod boundary BEFORE key touch
- Output v6 envelope verifiable by existing RFC-0042 verifier
- Signing key isolation: signer refuses to run if any untrusted-PR-eval artifact is present in its environment
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `spec/schemas/untrusted-pr-report.v1.schema.json` ships per RFC §Design Details
- [ ] #2 Zod mirror at `pipeline-cli/src/pipeline/report-validator.ts` exports `UntrustedPrReportSchema` + inferred type
- [ ] #3 Schema aligned with existing reviewer verdict contract (severity-gated; NOT confidence-scored)
- [ ] #4 NO top-level `confidenceScore` / `complexityDelta` / `cveDetected` fields (deliberate divergence from feature request)
- [ ] #5 Clean-room signer step ships; reads unsigned report; re-validates via Zod boundary BEFORE any key touch
- [ ] #6 Signer builds RFC-0042 v6 Merkle tree from committed transcript leaves; signs root with operator key
- [ ] #7 Output v6 DSSE envelope verifiable by existing RFC-0042 verifier (regression test)
- [ ] #8 Signing key isolation invariant: signer refuses to run if any untrusted-PR-eval artifact present in its environment
- [ ] #9 `Decision: untrusted-pr-sigstore-anchor-request` Stage A counter wired (no v1 activation; counter only); auto-promote at ≥2 distinct adopter requests
- [ ] #10 Hermetic tests: schema round-trip, tamper rejection, v6 envelope generation, signer isolation invariant
<!-- AC:END -->
