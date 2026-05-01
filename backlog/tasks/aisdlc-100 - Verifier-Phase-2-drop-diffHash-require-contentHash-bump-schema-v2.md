---
id: AISDLC-100
title: >-
  Verifier Phase 2 — drop diffHash, require contentHash, bump schema to v2
status: To Do
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
  - scripts/ci-sign-attestation.mjs
  - orchestrator/src/runtime/attestations.ts
  - .ai-sdlc/schemas/attestation.v1.schema.json
  - backlog/completed/aisdlc-94*
priority: medium
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
