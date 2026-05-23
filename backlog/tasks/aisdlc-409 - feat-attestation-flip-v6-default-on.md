---
id: AISDLC-409
title: 'feat(attestation): flip AI_SDLC_V6_CUTOVER_ACTIVE default-ON — make v6 the default schema'
status: In Progress
labels: [attestation, rfc-0042, promotion, operator-merge]
references:
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - pipeline-cli/src/attestation/sign-v6.ts
  - scripts/verify-attestation.mjs
priority: high
permittedExternalPaths: []
---

## Description

Per operator directive 2026-05-23: switch attestation default schema from v5 to v6 ASAP. The v6 path (RFC-0042 Merkle-transcript model) is fully implemented (AISDLC-383.4 verifier, AISDLC-383.6 signer wiring) but gated behind `AI_SDLC_V6_CUTOVER_ACTIVE=1`. Flipping the default to v6 unblocks signed sub-attestations (eliminates the AISDLC-380 forgery defense gap on v5 envelopes) and aligns the canonical signing path with the Merkle-transcript trust model.

The current behavior: `sign-attestation.mjs` line 166 reads `process.env['AI_SDLC_V6_CUTOVER_ACTIVE'] === '1' ? 'v6' : 'v5'`. New behavior: default to v6 unless operator opts out via `AI_SDLC_V5_LEGACY=1` (or similar opt-out env). The AISDLC-380 sub-attestation gate downgrades to audit-only on v5 envelopes when v6 is the default (already coded that way per CLAUDE.md).

The pre-existing gap (transcript-leaves emission must be reliable) is satisfied for the canonical `/ai-sdlc execute` and `/ai-sdlc orchestrator-tick` paths — both already call `cli-attestation.mjs emit-leaf` for each reviewer. The remaining gap (ad-hoc reviewer spawning outside those skills) is tracked separately and is not a v6-cutover blocker because ad-hoc spawning is not a supported production path.

## Acceptance criteria

- [ ] AC-1: Flip default in `ai-sdlc-plugin/scripts/sign-attestation.mjs` line 166 — change `defaultSchema` from `'v5'` to `'v6'`. Introduce a `AI_SDLC_V5_LEGACY` opt-out env that forces v5 (mirror polarity of the existing flag).
- [ ] AC-2: Update CLAUDE.md "Default schema (current): v5" → "Default schema (current): v6" + revise the AISDLC-380 gate paragraph to reflect that the gate is now in audit-only mode by default.
- [ ] AC-3: Update CLAUDE.md to remove the RFC-0042 Phase 3 "SCAFFOLDING SHIPPED, GATED" caveat (v6 is now the active default, no longer gated).
- [ ] AC-4: Hermetic test: `sign-attestation.mjs` defaults to v6 when env is unset; defaults to v5 when `AI_SDLC_V5_LEGACY=1`; honors explicit `--schema-version` flag in both cases.
- [ ] AC-5: Verify `scripts/verify-attestation.mjs` accepts both v5 and v6 envelopes on PRs (already does per CLAUDE.md — confirm with a verifier test if missing).
- [ ] AC-6: CHANGELOG entry under Unreleased noting v6 promotion + opt-out env name.

## Out of scope

- Wiring transcript-leaves emission into ad-hoc reviewer spawning (separate gap, file follow-up).
- Deletion of v5/v4/v3 signer code (scheduled in AISDLC-383.7 after 30-day soak).
- Branch protection rule changes.

## Estimated effort

30-45 min. Mostly a flag-flip + docs update + opt-out env wiring.
