---
id: AISDLC-422
title: >-
  fix(attestation): RFC-0042 follow-up — exclude .ai-sdlc/transcript-leaves/
  from PATCH_ID_EXCLUSION (AISDLC-421 self-reference bug)
status: Done
assignee: []
created_date: '2026-05-25 03:16'
labels:
  - bug
  - attestation
  - rfc-0042
  - post-aisdlc-421
dependencies:
  - AISDLC-421
references:
  - pipeline-cli/src/attestation/patch-id.ts
  - scripts/verify-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

AISDLC-421 introduced per-patch-id transcript-leaves files at `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` to eliminate cross-PR rebase conflicts. The patch-id is computed via `git diff-tree -p main..HEAD -- ':!.ai-sdlc/attestations/' | git patch-id --stable` — i.e. attestations are excluded, but `.ai-sdlc/transcript-leaves/` is NOT.

This makes the per-patch-id filename **self-referential**: committing the leaves file at `<computed-patch-id>.jsonl` changes the diff, which changes the patch-id, which changes the expected filename. The pre-push attestation-sign hook then can't find the leaves and fails the push.

**Concrete failure observed on PR #675 rebase recovery (2026-05-25):**

1. `emit-leaf` computed patch-id `d25ab2da` from pre-commit diff → wrote `.ai-sdlc/transcript-leaves/d25ab2da.jsonl`
2. `sign-v6` signed envelope `d25ab2da.v6.dsse.json`, verified locally `status=valid`
3. Commit added BOTH files → new diff → new patch-id `3a007ed0`
4. Pre-push hook (`check-attestation-sign.sh`) computed `3a007ed0` from current HEAD, looked for `3a007ed0.jsonl`, didn't find it (leaves are at `d25ab2da.jsonl`)
5. Hard fail: `ERROR: [sign-v6] No transcript leaves found for taskId 'AISDLC-275' (patch-id 3a007ed04802...)`

The bug blocks **every post-AISDLC-421 rebase recovery** that re-emits leaves. Initial post-421 signs (where the dev did the work pre-commit) happen to work because the iteration only runs once before commit.

## Fix

Add `.ai-sdlc/transcript-leaves/` to the patch-id exclusion in **both** signer and verifier sides:

- `pipeline-cli/src/attestation/patch-id.ts:35` — `export const PATCH_ID_EXCLUSION = ':!.ai-sdlc/attestations/'` → add `':!.ai-sdlc/transcript-leaves/'` (the function takes a single pathspec arg; either expand to a multi-element exclusion array or join with another `:!` pathspec — verify which yargs/diff-tree syntax works)
- `scripts/verify-attestation.mjs:79` — `[..., '--', ':!.ai-sdlc/attestations/']` → mirror exclusion

The symmetry rule (sign + verify exclude the same set) is critical or we re-introduce the bug that AISDLC-421's hotfix (verifier shared-fallback taskId filter) fixed in a different shape.

## Why excluding transcript-leaves is safe

Per-PR Merkle root is computed over the LEAVES THEMSELVES (their content), not the diff that introduced them. The verifier:
1. Resolves the per-patch-id file via the patch-id hint extracted from the envelope filename
2. Reads leaves from that file
3. Recomputes Merkle root from leaves
4. Verifies signature

Excluding the leaves DIRECTORY from patch-id computation means a sibling PR's leaves file landing on main between rebases won't change THIS PR's patch-id (so envelope name stays stable, easy queue rebases). The leaves themselves are still committed, still on disk, still resolved by filename for verification.

## Acceptance criteria

1. `PATCH_ID_EXCLUSION` in `pipeline-cli/src/attestation/patch-id.ts` excludes both `.ai-sdlc/attestations/` AND `.ai-sdlc/transcript-leaves/`
2. The verifier's pathspec in `scripts/verify-attestation.mjs` mirrors the exclusion (any drift = bug)
3. Hermetic test: stage leaves file at `<patch-id>.jsonl`, commit, recompute patch-id, assert it's UNCHANGED from pre-commit value
4. Hermetic test: full sign → commit → re-compute-patch-id → re-find-envelope roundtrip succeeds (the failure mode that blocked #675 recovery)
5. `sign-v6.ts` unchanged (it consumes the patch-id; doesn't compute it)
6. RFC-0042 amendment to document the exclusion (per AISDLC-421's per-patch-id contract)
7. Patch coverage on changed `patch-id.ts` lines ≥ 80%
8. Local pre-push gates pass: coverage, DoR, attestation-sign (no `AI_SDLC_SKIP_*` flags)

## Recovery plan for #675 (operator decides)

Option A: wait for this fix to land, then rebase #675 (will use the fixed exclusion).
Option B: ship #675 via legacy `--schema-version v5` (single-line flag override on sign-attestation).
Option C: discard #675's attestation chore commits, sign once with the fix uncommitted-but-applied to the worktree's pipeline-cli, accept the chore commit's patch-id drift on the FINAL push only.

Recommend Option A unless #675 needs to land tonight.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `PATCH_ID_EXCLUSIONS` in `pipeline-cli/src/attestation/patch-id.ts` includes both `.ai-sdlc/attestations/` AND `.ai-sdlc/transcript-leaves/`; old `PATCH_ID_EXCLUSION` retained as a deprecated alias.
- [ ] #2 Verifier's pathspec in `scripts/verify-attestation.mjs` mirrors the exclusion list exactly.
- [ ] #3 Bash hook `scripts/check-attestation-sign.sh` passes the same `:!.ai-sdlc/transcript-leaves/` exclusion to `git diff-tree` when computing patch-id.
- [ ] #4 Hermetic test: stage and commit a leaves file at `<patch-id>.jsonl`, recompute patch-id from base..HEAD, assert it equals the pre-commit value.
- [ ] #5 Hermetic test: AISDLC-398 regression — committing an attestation envelope file still yields the same patch-id (refactor didn't regress the original invariant).
- [ ] #6 Full sign → commit → re-compute-patch-id → re-find-envelope roundtrip succeeds end-to-end in a real worktree (the recovery path that blocked PR #675).
- [ ] #7 Local pre-push gate chain passes with NO `AI_SDLC_SKIP_*` flags set (coverage, DoR, attestation-sign all green).
- [ ] #8 Patch coverage on the changed lines in `patch-id.ts` and `verify-attestation.mjs` >= 80%.
<!-- AC:END -->
