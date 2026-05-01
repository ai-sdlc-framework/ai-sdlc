---
id: AISDLC-103
title: >-
  Verifier Phase 3 — 30-day soak then drop diffHash + contentHash, bump schema to v3
status: To Do
assignee: []
labels:
  - verifier
  - attestation
  - rebase
  - migration
  - operator-action
dependencies:
  - AISDLC-94
  - AISDLC-101
  - AISDLC-102
references:
  - scripts/verify-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - scripts/ci-sign-attestation.mjs
  - orchestrator/src/runtime/attestations.ts
  - .ai-sdlc/schemas/attestation.v1.schema.json
  - backlog/completed/aisdlc-94*
  - backlog/completed/aisdlc-101*
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 3 of the AISDLC-94 → AISDLC-101 attestation rebase-tolerance migration. Phase 1 (AISDLC-94) shipped the verifier-side dual hash (`diffHash` + `contentHash`). Phase 1.5 (AISDLC-102) added the producer-side pre-sign rebase. Phase 2 (AISDLC-101) added the per-file-delta `contentHashV3` and the verifier accepts on ANY of the three legs (additive triple-hash window). Phase 3 closes the migration: after a 30-day soak with all three legs in production, drop `diffHash` + `contentHash` from fresh predicates, require `contentHashV3`, bump `schemaVersion` to `v3`.

This is the SECOND-half of the originally-filed AISDLC-101 work, split out because:
- The Phase 2 code (per-file delta hashing + verifier acceptance) is purely additive and can ship today without disrupting the in-flight envelope ecosystem.
- The Phase 3 cleanup REQUIRES a 30-day production soak to confirm v3 envelopes are landing reliably across `/ai-sdlc execute`, the CI-side attestor, fork PRs, etc.
- The Phase 3 schema file bump (`.ai-sdlc/schemas/attestation.v3.schema.json`) lives under `.ai-sdlc/**`, which the developer subagent's PreToolUse hook blocks — it needs an operator hand-edit OR a CI workflow allowance.

This task SHOULD NOT be started before AISDLC-101 has been in production for ≥ 30 days. Earliest-start gates:
- AISDLC-101 + AISDLC-102 have been in production for ≥ 30 days.
- `.ai-sdlc/attestations/*.dsse.json` audit shows ≥ 95% of envelopes signed in the trailing 7 days carry `contentHashV3`.
- No open PRs with `diffHash`-only or `contentHash`-only envelopes that are expected to merge in the cutover window.
- The two-half (Phase 2 additive, Phase 3 destructive) split has been validated by at least one real sibling-overlap PR resolving without operator re-run intervention.

## Phase 3 work for THIS PR

1. `sign-attestation.mjs` + `ci-sign-attestation.mjs` STOP including `diffHash` + `contentHash` in fresh predicates (only emit `contentHashV3`).
2. `buildPredicate` makes `contentHashV3` required (and `changedFileDeltas` non-empty / `[]` for no-op PRs); removes `diffHash` + `contentHash` from the predicate type (BREAKING change).
3. `validatePredicateShape` requires `contentHashV3` (matches `^[0-9a-f]{64}$`); rejects predicates carrying the legacy `diffHash` / `contentHash` (= a v1/v2 envelope smuggling itself in as v3).
4. `verifyAttestation` accepts only `contentHashV3`-leg matching; legacy v1/v2 envelopes (no `contentHashV3`) are rejected with a clear `schemaVersion 'vN' not in allowlist [v3]` reason.
5. `ACCEPTED_SCHEMA_VERSIONS = ['v3']` — `v1` removed, `v2` skipped (we never landed a `v2` schema; the dual-hash + triple-hash windows kept everything as `v1`).
6. New `.ai-sdlc/schemas/attestation.v3.schema.json` (or schema update via operator hand-edit) reflects the new shape; the schema-mirror test in `attestations.test.ts` still passes.
7. CLAUDE.md "What CI rejects" / "What CI accepts" sections updated: legacy diffHash-only and contentHash-only envelopes now reject with the schema-version reason.
8. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean; existing AISDLC-101 contentHashV3 tests still pass; the AISDLC-101 "Phase-1 envelope still verifies via dual-hash leg" test gets inverted to expect rejection.

## Acceptance Criteria

<!-- AC:BEGIN -->
1. `sign-attestation.mjs` + `ci-sign-attestation.mjs` stop emitting `diffHash` and `contentHash` in predicates
2. `buildPredicate` removes `diffHash` + `contentHash`, requires `changedFileDeltas` non-empty (or `[]` for no-op PRs), and produces predicates with `schemaVersion: 'v3'`
3. `validatePredicateShape` requires `contentHashV3` (matches `^[0-9a-f]{64}$`); rejects predicates carrying `diffHash` or `contentHash` (= a v1/v2 envelope smuggling itself in as v3)
4. `verifyAttestation` accepts only `contentHashV3`-leg matching; legacy v1/v2 envelopes are rejected with a clear schema-version-allowlist reason
5. `ACCEPTED_SCHEMA_VERSIONS = ['v3']` — `v1` removed
6. New `.ai-sdlc/schemas/attestation.v3.schema.json` (or schema update via operator) reflects the new shape; the schema-mirror test in `attestations.test.ts` still passes
7. CLAUDE.md "What CI rejects" / "What CI accepts" sections updated: legacy diffHash-only / contentHash-only envelopes now reject with the schema-version reason
8. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean; existing AISDLC-101 contentHashV3 tests still pass
<!-- AC:END -->

## References

- AISDLC-94 — Phase 1 (verifier-side dual hash)
- AISDLC-101 — Phase 2 (this is the follow-up; per-file delta `contentHashV3`)
- AISDLC-102 — Phase 1.5 (producer-side pre-sign rebase)
- AISDLC-93 — the affected PR that exposed the original sibling-overlap bug
- AISDLC-90 — the sibling PR whose merge invalidated #102's attestation
- AISDLC-84 — the original "verifier matches by predicate content" design
<!-- SECTION:DESCRIPTION:END -->
