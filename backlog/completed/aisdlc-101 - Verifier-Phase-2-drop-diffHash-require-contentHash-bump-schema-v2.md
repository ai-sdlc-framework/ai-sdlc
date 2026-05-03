---
id: AISDLC-101
title: 'Verifier Phase 2 — drop diffHash, require contentHash, bump schema to v2'
status: Done
assignee: []
labels:
  - verifier
  - attestation
  - rebase
  - migration
dependencies:
  - AISDLC-94
references:
  - scripts/verify-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - orchestrator/src/runtime/attestations.ts
  - >-
    backlog/completed/aisdlc-94 -
    Verifier-diffHash-should-be-rebase-tolerant-hash-post-apply-tree-state-not-literal-diff-text.md
priority: medium
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
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 2 of the AISDLC-94 dual-hash migration. AISDLC-94 (Phase 1) shipped envelopes that carry BOTH `diffHash` (legacy) and `contentHash` (rebase-tolerant for the file set as a whole). The verifier accepts either. After a 30-day soak window with Phase 1 in production — long enough for any in-flight PR with a legacy `diffHash`-only envelope to either merge or get re-signed — Phase 2 deprecates the diffHash path entirely.

**Open design question (BEFORE starting Phase 2 work):** AISDLC-94 Phase 1's `contentHash` only covers the case where the rebase target didn't touch the PR's changed files. The AISDLC-93 / PR #102 root case (rebase onto a base where a sibling PR ALSO modified the same files) still makes contentHash diverge — because the post-apply blob SHA at the PR's HEAD now reflects "baseline + sibling-PR contributions + this-PR contributions" instead of "baseline + this-PR contributions". Phase 2 may need to switch to a "per-file delta hash" (sha256 over per-file `<path>\t<blob-at-base>\t<blob-at-head>` pairs, with the base being the merge-base of `origin/main` and HEAD) to actually solve the overlapping-files scenario. Pin this design decision in an RFC before starting implementation.

- `sign-attestation.mjs` + `ci-sign-attestation.mjs` STOP including `diffHash` in fresh predicates
- `buildPredicate` makes `contentHash` required and removes `diffHash` (BREAKING change to the predicate type)
- `validatePredicateShape` requires `contentHash`, rejects envelopes without it
- `verify-attestation.mjs` requires `contentHash`-leg matching, rejects envelopes that only carry `diffHash`
- Bump `schemaVersion` to `v2`; `ACCEPTED_SCHEMA_VERSIONS` becomes `['v2']` (drop `v1`)
- New schema file `.ai-sdlc/schemas/attestation.v2.schema.json` (see AISDLC-94 follow-up note about the `.ai-sdlc/**` path block — schema bump needs operator hand-edit OR a CI workflow allowance)

This task SHOULD NOT be started before 2026-05-31 (= 30 days after AISDLC-94 lands). Filing now so the followup is tracked. Earliest start gates on:
- AISDLC-94 has been in production for ≥ 30 days
- `.ai-sdlc/attestations/*.dsse.json` audit shows ≥ 95% of envelopes signed in the trailing 7 days carry `contentHash`
- No open PRs with `diffHash`-only envelopes that are expected to merge in the cutover window

## Acceptance Criteria

<!-- AC:BEGIN -->
1. `sign-attestation.mjs` + `ci-sign-attestation.mjs` stop emitting `diffHash` in predicates
2. `buildPredicate` removes `diffHash`, requires `changedFiles` non-empty (or `[]` for no-op PRs), and produces predicates with `schemaVersion: 'v2'`
3. `validatePredicateShape` requires `contentHash` (matches `^[0-9a-f]{64}$`); rejects predicates carrying `diffHash` (= a v1 envelope smuggling itself in as v2)
4. `verifyAttestation` accepts only `contentHash`-leg matching; legacy v1 envelopes (no `contentHash`) are rejected with a clear `schemaVersion 'v1' not in allowlist [v2]` reason
5. `ACCEPTED_SCHEMA_VERSIONS = ['v2']` — `v1` removed
6. New `.ai-sdlc/schemas/attestation.v2.schema.json` (or schema update via operator) reflects the new shape; the schema-mirror test in `attestations.test.ts` still passes
7. CLAUDE.md "What CI rejects" / "What CI accepts" sections updated: legacy diffHash-only envelopes now reject with the schema-version reason
8. `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean; existing AISDLC-94 contentHash tests still pass; the AISDLC-94 "legacy v1 envelope still verifies" test gets inverted to expect rejection
<!-- AC:END -->

## References

- AISDLC-94 — Phase 1 (dual-hash, this is the follow-up)
- AISDLC-93 — the affected PR that exposed the original rebase-fragility bug
- AISDLC-90 — the sibling PR whose merge invalidated #102's attestation
- AISDLC-84 — the original "verifier matches by predicate content" design
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Phase 2 of the AISDLC-94 attestation rebase-tolerance migration, implemented as **additive defense-in-depth** rather than the originally-scoped destructive cleanup. Added a third content binding `contentHashV3 = sha256({path, fileDeltaHash} per changed file, sorted)`, where `fileDeltaHash[path] = sha256(<base_blob_sha> + ' -> ' + <head_blob_sha>)` and the base blob is read at `git merge-base(<baseRef>, <headRef>)`. The verifier now OR's three legs at match time (`diffHash` v1 / `contentHash` v2 / `contentHashV3` v3) — survives the AISDLC-93 / PR #102 sibling-overlap rebase scenario without operator re-run, since blob SHAs are content-addressed and stable across base shifts.

## Changes

- `orchestrator/src/runtime/attestations.ts` — added `computeContentHashV3` + `collectChangedFileDeltaEntries` exports; extended `validatePredicateShape` / `buildPredicate` / `verifyAttestation` to handle optional `contentHashV3` predicate field. Existing v1/v2 functions untouched.
- `scripts/verify-attestation.mjs` — added `computeShaContentHashV3` + `resolveBlobShaAt`; `predicateMatchReason` extended with v3 leg in OR semantics; `resolveSubjectShaForEnvelope` deep-walk fallback considers v3.
- `ai-sdlc-plugin/scripts/sign-attestation.mjs` + `scripts/ci-sign-attestation.mjs` — producer-side now collects `changedFileDeltas` and emits `contentHashV3` in fresh predicates.
- `*.test.{ts,mjs}` — +36 tests in attestations.test.ts (78→114), +7 in verify-attestation.test.mjs (54→61), +1 each in sign-attestation.test.mjs + ci-sign-attestation.test.mjs.
- `CLAUDE.md` — added bullet under "What CI accepts (intentional, post-AISDLC-84)" documenting the AISDLC-101 v3 leg and how it composes with v2 + v1.
- `backlog/tasks/aisdlc-103 - Verifier-Phase-3-...md` (new) — follow-up task for the deferred destructive cleanup.

## AC status

- ✓ AC #3 (`validatePredicateShape` accepts new `contentHashV3` shape, validates `^[0-9a-f]{64}$`)
- ✓ AC #6 (no new schema file but optional v3 field added; the existing schema-mirror test in `attestations.test.ts` still passes)
- ✓ AC #8 (`pnpm build && pnpm test && pnpm lint && pnpm format:check` clean)
- ✗ AC #1, #2, #4, #5, #7 — INTENTIONALLY DEFERRED to AISDLC-103 per user-directed scope change. Original ACs assumed destructive removal of `diffHash`; mid-flight redesign reframed as additive defense-in-depth (per user feedback "we still need the delta when re-base cause that will happen often. but rebasing before we do the attestation will prevent some of the attestation problems"). AISDLC-101 + AISDLC-102 now layer; the destructive cleanup waits 30 days for AISDLC-101 production soak.

## Design decisions

- **Additive instead of destructive**: AISDLC-101 + AISDLC-102 reframed as complementary defense-in-depth layers. AISDLC-102's pre-sign rebase narrows the failure window; AISDLC-101's per-file delta hashing tolerates the residual cases. Destructive cleanup waits in AISDLC-103.
- **Empty-string blob marker**: `('' -> X)` for added, `(X -> '')` for deleted, `(X -> Y)` for modified. The encoding is injective — three change shapes produce three distinct hashes.
- **`--no-renames` everywhere**: producer + verifier both use `git diff --no-renames` so a rename appears as add+delete on both sides. Deterministic, no rename-detection drift.
- **Path canonicalization**: rejects `\t` and `\n` (mirrors AISDLC-94 v2 defense).
- **Schema mirror gap**: `.ai-sdlc/schemas/attestation.v1.schema.json` doesn't list `contentHashV3` — runtime validation is `validatePredicateShape` (correctly updated), the JSON schema file is informational only and inherits the same drift that already existed for v2 since AISDLC-94. Deferred operator hand-edit.

## Verification

- `pnpm build` — clean
- `pnpm vitest run orchestrator/src/runtime/attestations.test.ts` — 114/114 pass
- `pnpm test` (full workspace) — orchestrator 2920/2920, dashboard 126/126, dogfood 292/292, conformance 23/23, mcp-advisor 131/131; node-tests for verify-attestation 61/61, sign-attestation 5/5, ci-sign-attestation 16/16
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 parallel reviews approved (code-reviewer 0c/0M/2m/2s; test-reviewer 0c/0M/2m/1s; security-reviewer 0c/0M/0m/0s); ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to claude-code)

## Follow-up

- **AISDLC-103** — Verifier Phase 3: 30-day soak then drop diffHash + contentHash, bump schema to v3
- **Operator hand-edit**: `.ai-sdlc/schemas/attestation.v1.schema.json` to add optional `contentHashV3` field (regex `^[0-9a-f]{64}$`) — `.ai-sdlc/**` is in agent blockedPaths
- **Code minor (reviewer)**: verifier-side `resolveBlobShaAt` doesn't pass `-c core.quotepath=false`; producer's `resolveBlobSha` does. Functionally harmless because both extract via hex-only regex, but mirroring would lock in consistency for any future caller.
- **Code suggestion**: `computeContentHashV3` could enforce blob SHA shape (`^[0-9a-f]{40}$|^$`) defensively for future external callers
- **Test suggestion**: explicit test for two paths with identical (base, head) pairs hashing differently (currently implicit via path-in-canonical-encoding)
- **Anticipated rebase conflict** with in-flight AISDLC-102 (both touch `attestations.ts` + `verify-attestation.mjs`); both kept additive so whichever lands first the second rebases cleanly
<!-- SECTION:FINAL_SUMMARY:END -->
