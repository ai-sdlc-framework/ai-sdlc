---
id: AISDLC-492
title: Remove per-SHA verifier soak fallback (extracted from AISDLC-490)
status: Done
labels:
  - attestation
  - rfc-0042
  - cleanup
priority: medium
dependencies:
  - AISDLC-475
  - AISDLC-491
---

## Context

AISDLC-490 (PR #816) attempted two things in one: (1) introduce amend-in-place signing to eliminate the post-sign chore commit, and (2) remove the per-SHA legacy soak fallback from the verifier. The amend-in-place mechanism has a self-defeating bug — the filename binding locks to the pre-amend SHA, making reverification impossible after amend. AISDLC-490 is being closed without merging.

AISDLC-475 (Fix B) stopped writing the per-SHA bridge file when a patch-id is available. AISDLC-491 added the tree-equivalent-modulo-attestation relaxation. Together, these two changes made the standard chore-commit sign path fully rebase-safe, so the 1-release soak period for the per-SHA fallback is complete. This task extracts only AC-4 of AISDLC-490: removing the now-unnecessary per-SHA fallback from `scripts/verify-attestation.mjs`.

## What this task does

Removes the 8-line block in `runVerifier()` that matched v6 envelopes by `${headSha}.v6.dsse.json` filename as a legacy fallback. This block was marked with:

```
// DELETION FOLLOW-UP: remove this per-SHA lookup in AISDLC-490 after the
// 1-release soak period (once B+ lands and the chore-commit class is gone).
```

After removal, the only filename acceptance paths are:

1. Patch-id filename match (`${contentPatchId}.v6.dsse.json`) — the preferred current-era path
2. Subject-SHA ancestry match (`isAttestationOnlyDescendant`) — covers chore-commit shape and the equal-SHA case
3. Tree-equivalent match (`isTreeEquivalentModuloAttestation`) — covers rebase-orphaned envelopes (AISDLC-448)

## Acceptance Criteria

- [x] The per-SHA legacy soak fallback (`lowerName === \`${lowerHead}.v6.dsse.json\``) is removed from the `v6Envelopes` filter in `runVerifier()`.
- [x] Patch-id filename lookup, `isAttestationOnlyDescendant` (AISDLC-419), and `isTreeEquivalentModuloAttestation` (AISDLC-491/448) remain intact.
- [x] Existing tests covering the broadened filter, Merkle/signature gates, and current-era envelopes all pass.
- [x] Two new tests document the removal: one confirms SHA-named envelopes (subject.sha1 === headSha) still verify via the equal-SHA path in `isAttestationOnlyDescendant`; one confirms that a stale non-ancestor SHA-named envelope is not surfaced.
- [x] Blast radius assessed: zero currently-open code PRs carry SHA-only v6 envelopes. Open PRs at time of implementation are: PR #816 (AISDLC-490, being closed), dependabot dep bumps (#784-#787), and a GitHub Actions bump (#783) — all are docs-only or dep-only, exempt from `verify-attestation.yml` via `paths-ignore`. No code PRs are affected.
- [x] No amend-in-place changes from AISDLC-490 (`check-attestation-sign.sh` / `sign-v6.ts` amend hunks) are included.

## Files Changed

- `scripts/verify-attestation.mjs` — removed 8-line per-SHA fallback block; replaced with a 5-line comment explaining the removal (AISDLC-492)
- `scripts/verify-attestation.test.mjs` — added two new test cases under the "runVerifier — v6 integration" describe block
- `backlog/completed/aisdlc-492 - remove-per-sha-attestation-soak-fallback-extracted-from-aisdlc-490.md` — this task file (moved to completed)
