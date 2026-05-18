---
id: AISDLC-362
title: >-
  feat(attestation): contentHashV5 — delta-hash with embedded signedMergeBase
  for true rebase-stability
status: Done
assignee: []
created_date: '2026-05-17'
updated_date: '2026-05-18'
labels:
  - attestation
  - security
  - rebase-stability
dependencies: []
priority: critical
---

## Description

`contentHashV4` still invalidates when a sibling PR merges files overlapping
with the PR's diff, because the diff base (`origin/main`) moves between
sign-time and verify-time. The fix is to freeze the merge-base at sign-time
by embedding `signedMergeBase` in the envelope. The verifier then reproduces
the EXACT file enumeration the signer used by diffing against the frozen SHA
instead of the moving `origin/main`.

## Acceptance Criteria

- [x] **v5 algorithm**: `computeContentHashV5(entries, signedMergeBase)` and
  `collectChangedFileEntriesForV5` implemented with frozen merge-base
- [x] **Envelope schema**: `contentHashV5` + `signedMergeBase` added to predicate;
  `schemaVersion` bumped to 'v5' for new envelopes; `ACCEPTED_SCHEMA_VERSIONS`
  updated to `['v3', 'v5']`
- [x] **Verifier priority**: v5 > v4 > v3 in both `verifyAttestation` and
  `verify-attestation.mjs`
- [x] **Sibling-PR overlap detection**: overlapping blob SHAs still cause v5
  rejection; non-overlapping sibling merges do NOT invalidate v5
- [x] **Tests**: unit + integration + round-trip; `buildPredicate with v5` suite;
  `CONTENTHASH_SHARED_CHURN_FILES` backward-compat alias tests
- [x] **Migration**: `CONTENTHASHV4_IGNORE_FILES` alias preserved; CLAUDE.md
  updated from AISDLC-343 to AISDLC-362 reference

## Final Summary

## Summary

Implemented `contentHashV5` — a rebase-stable attestation hash that captures
the `git merge-base origin/main HEAD` (the "frozen merge-base") at sign-time
and embeds it in the DSSE envelope predicate as `signedMergeBase`. The verifier
reproduces the EXACT file enumeration using the frozen SHA rather than the
moving `origin/main`, so non-overlapping sibling merges no longer invalidate
the attestation. Overlapping sibling merges (same file) still correctly
invalidate it because the blob SHA changes.

## Changes

- `orchestrator/src/runtime/attestations.ts` (modified): Added
  `computeContentHashV5`, `collectChangedFileEntriesForV5`, `ChangedFileV5Entry`,
  `V5CollectResult` interfaces; updated `ACCEPTED_SCHEMA_VERSIONS` to include
  'v5'; renamed `CONTENTHASHV4_IGNORE_FILES` to `CONTENTHASH_SHARED_CHURN_FILES`
  with backward-compat alias; updated `buildPredicate` + `verifyAttestation` for
  v5 priority chain
- `orchestrator/src/runtime/index.ts` (modified): Added all new v5 exports and
  previously unexported symbols to the runtime barrel
- `orchestrator/src/runtime/attestations.test.ts` (modified): Added 26 new
  tests for `computeContentHashV5`, `collectChangedFileEntriesForV5`, v5
  round-trip, and backward-compat alias
- `ai-sdlc-plugin/scripts/sign-attestation.mjs` (modified): Added v5 collection
  with graceful fallback; passes `v5Entries` + `v5MergeBase` to `buildPredicate`
- `ai-sdlc-plugin/scripts/sign-attestation.test.mjs` (modified): Updated test
  to accept both v5 and v3 schema versions
- `scripts/verify-attestation.mjs` (modified): Added v5 fast-path in
  `resolveSubjectShaForEnvelope`; v5 priority in `predicateMatchReason`
- `CLAUDE.md` (modified): Updated attestation section to describe v5 algorithm,
  priority chain, frozen merge-base approach; updated AISDLC-343 reference to
  AISDLC-362; renamed `CONTENTHASHV4_IGNORE_FILES` to `CONTENTHASH_SHARED_CHURN_FILES`

## Design Decisions

- **Frozen merge-base, not moving base**: The key insight is that `git merge-base`
  computed at sign-time is stable; computing it at verify-time would change as
  sibling PRs merge, defeating the purpose.
- **2-dot diff (`<sha>..<HEAD>`)**: Used instead of 3-dot to ensure the exact
  same file set is enumerated by signer and verifier.
- **All three hashes emitted**: New envelopes carry v3+v4+v5 for maximum
  backward + forward compatibility; verifier preference chain handles all
  combinations.
- **Graceful fallback on v5 collection failure**: If `git merge-base` fails
  (network issue, shallow clone), the sign script falls back to v3-only rather
  than blocking the signing workflow.

## Verification

- `pnpm build` — clean
- `pnpm test` — 3309 orchestrator tests + 12 sign-attestation tests passed
- `pnpm lint` — 2 pre-existing warnings in unrelated file, 0 errors
- `pnpm format:check` — clean

## Follow-up

- The `CONTENTHASHV4_IGNORE_FILES` alias can be removed in a future cleanup PR
  once all callers are updated.
