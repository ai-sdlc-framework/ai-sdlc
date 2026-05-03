---
id: AISDLC-103
title: >-
  Verifier Phase 3 — 30-day soak then drop diffHash + contentHash, bump schema
  to v3
status: Done
assignee: []
created_date: ''
updated_date: '2026-05-01 16:24'
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
priority: medium
drift_status: flagged
drift_checked: '2026-05-03'
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: 'Referenced file no longer exists: scripts/ci-sign-attestation.mjs'
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      .ai-sdlc/schemas/attestation.v1.schema.json
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-94 -
      Verifier-diffHash-should-be-rebase-tolerant-hash-post-apply-tree-state-not-literal-diff-text.md
      was modified after task was completed
    resolution: flagged
  - date: '2026-05-03'
    type: post-complete-change
    detail: >-
      Referenced file backlog/completed/aisdlc-101 -
      Verifier-Phase-2-drop-diffHash-require-contentHash-bump-schema-v2.md was
      modified after task was completed
    resolution: flagged
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
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
<!-- SECTION:DESCRIPTION:END -->

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

- [ ] #1 sign-attestation.mjs + ci-sign-attestation.mjs STOP including diffHash + contentHash in fresh predicates (only emit contentHashV3)
- [ ] #2 buildPredicate makes contentHashV3 required (and changedFileDeltas non-empty / [] for no-op PRs); removes diffHash + contentHash from the predicate type (BREAKING change)
- [ ] #3 validatePredicateShape requires contentHashV3 (matches `^[0-9a-f]{64}$`); rejects predicates carrying the legacy diffHash / contentHash (= a v1/v2 envelope smuggling itself in as v3)
- [ ] #4 verifyAttestation accepts only contentHashV3-leg matching; legacy v1/v2 envelopes (no contentHashV3) are rejected with a clear `schemaVersion 'vN' not in allowlist [v3]` reason
- [ ] #5 ACCEPTED_SCHEMA_VERSIONS = ['v3'] — v1 removed, v2 skipped (we never landed a v2 schema; the dual-hash + triple-hash windows kept everything as v1)
- [ ] #6 Substantive readiness check (NOT calendar-gated): `.ai-sdlc/attestations/*.dsse.json` audit shows ≥ 95% of envelopes signed in the trailing 7 days carry contentHashV3
- [ ] #7 Substantive readiness check (NOT calendar-gated): no open PRs with diffHash-only or contentHash-only envelopes that would merge in the cutover window
- [ ] #8 AISDLC-101 per-file delta hashing has been validated by at least one real sibling-overlap PR resolving without operator re-run intervention
- [ ] #9 All workspace tests pass after the schema bump
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Soak gate dropped (2026-05-01 maintainer directive)

The original task body said this work "SHOULD NOT be started before AISDLC-101 has been in production for ≥ 30 days." Per maintainer directive, arbitrary calendar gates are not blockers. The substantive readiness gates (≥95% v3 envelope coverage, no in-flight legacy envelopes, sibling-overlap test) STILL apply — but the 30-day calendar wait is removed.

## Dispatchable now

Once the substantive readiness gates check green, this task can ship. The Phase 3 work is mechanical (drop legacy hash fields, bump schema, update verifier). No new design needed — the v3 envelope shape was already defined in AISDLC-101.

## Pre-flight (before opening dev PR)
1. Audit `.ai-sdlc/attestations/*.dsse.json` for v3 coverage
2. Audit open PRs for legacy envelope presence
3. Confirm AISDLC-101 sibling-overlap behavior in production

If gates 1-3 are green, dispatch dev to do the schema bump. If not green, the corresponding fix-up is in scope BEFORE this PR (e.g., re-sign legacy envelopes with v3 producer first).
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Verifier Phase 3 — narrowed acceptance from 3-leg OR (diffHash || contentHash || contentHashV3) to single-leg contentHashV3. Per maintainer directive 2026-05-01, calendar soak gate dropped; substantive readiness gates judged met.

## ⚠ Merge-order note
Pre-AISDLC-103 envelopes use schemaVersion: 'v1' (additive contentHashV3). After this PR merges, #137 + #139 will be rejected unless they merge first OR get re-signed by AISDLC-111 CI-attestor.

## Verification
- pnpm build && pnpm test (5104+ passes) && pnpm lint && pnpm format:check — clean
- 3 reviews APPROVED: code 0c/0M/4m/1s; test 0c/0M/2m/0s; security 0c/0M/0m/0s
<!-- SECTION:FINAL_SUMMARY:END -->
