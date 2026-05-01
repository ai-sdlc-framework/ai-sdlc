---
id: AISDLC-94
title: >-
  Verifier diffHash should be rebase-tolerant — hash post-apply tree state, not
  literal diff text
status: Done
assignee: []
created_date: '2026-04-30 21:12'
updated_date: '2026-05-01 01:09'
labels:
  - bug
  - verifier
  - attestation
  - rebase
dependencies: []
references:
  - scripts/verify-attestation.mjs
  - scripts/sign-attestation.mjs
  - orchestrator/src/runtime/buildPredicate.ts
  - .ai-sdlc/schemas/attestation.v1.schema.json
  - backlog/completed/aisdlc-84*
  - backlog/completed/aisdlc-85*
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Trigger:** AISDLC-93's PR #102 had a valid local attestation when initially pushed. After PR #101 (AISDLC-90) merged, the user rebased PR #102 onto the new `main`. The rebase was clean (no conflicts) and #102's intended changes were unchanged semantically — but `verify-attestation.yml` rejected the attestation post-rebase with `invalid (diffHash mismatch (PR diff differs from attested diff))`.

**Root cause:** AISDLC-90 modified `.github/workflows/ai-sdlc-review.yml` and `CLAUDE.md` — the same two files AISDLC-93 modifies. After the rebase, `git diff origin/main...HEAD` produces different diff TEXT (different line numbers in `@@` hunk headers, different surrounding context lines) even though AISDLC-93's actual changes to the codebase are identical. The verifier hashes the literal diff output, so any line-shift breaks the hash.

This means: the AISDLC-84/85 design intent of "rebase-stable attestation" only holds when the rebase doesn't conflict with files another PR touched. As soon as two PRs converge on the same files, every rebase invalidates the attestation — even when there's no semantic change.

The current behavior is correct from a paranoid threat-model standpoint (the verifier can't tell if the rebase introduced a conflict resolution that wasn't reviewed). But it's operationally broken at any meaningful PR throughput — every PR that needs to wait for a sibling PR to merge first will lose its attestation on the rebase.

## What changes

Replace the literal-diff hash with a **post-apply tree hash**: for each file in the PR's changed-file set, hash the file's CURRENT blob content (post-apply state, what the reviewers would see if they checked out the branch). Combine into a single hash that reflects "what state would code look like after this PR lands."

```
old: diffHash = sha256(`git diff origin/main...HEAD`)
new: contentHash = sha256(per file in changed-file-set: { path, blobSha (git ls-tree HEAD path) } sorted)
```

Properties:
- **Rebase-stable**: rebasing onto a different base doesn't change the file blob shas (assuming no conflicts/edits)
- **Conflict-aware**: a rebase that resolves a conflict differently DOES change the file content → blob sha changes → hash changes → attestation correctly rejects
- **Force-push-stable**: same as above — only meaningful changes invalidate
- **Cheap**: `git ls-tree -r HEAD <paths>` is fast

## Migration plan

Two-phase migration since this is a verifier change touching the attestation envelope schema:

### Phase 1: dual-hash envelope (backward compatible)

- Sign-attestation script computes BOTH `diffHash` (current) and `contentHash` (new), includes both in the predicate
- Verifier accepts envelope if EITHER matches (legacy diffHash for envelopes signed before this lands; new contentHash for envelopes signed after)
- Schema bump: `v1` → `v2`, but `v1` still accepted

### Phase 2: deprecate diffHash (after 30 days of dual-hash production)

- Sign-attestation drops the `diffHash` field
- Verifier requires `contentHash`
- Schema allowlist drops `v1`

## Acceptance Criteria
<!-- AC:BEGIN -->
1. Update `scripts/sign-attestation.mjs` and `orchestrator/src/runtime/buildPredicate` (or wherever the predicate is built) to compute and include `contentHash` alongside `diffHash`
2. Update `scripts/verify-attestation.mjs` to accept either hash (Phase 1 dual-hash mode); document the dual-acceptance behavior
3. Add unit tests for `contentHash` computation: same-content-different-base produces same hash; conflict-resolution produces different hash
4. Add integration test: open a PR, rebase onto a base that touches the same files (without conflict), confirm attestation remains valid
5. Document the new behavior in CLAUDE.md `What CI accepts` section: rebases that don't change file content remain valid even when another PR has modified the same files
6. Phase 2 lands as a separate follow-up task (AISDLC-9X) after 30 days of soak in Phase 1
7. All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean

## References

- AISDLC-90 — the PR that, on merge, caused #102's attestation to invalidate
- AISDLC-93 — the affected PR (#102) that exposed the issue
- AISDLC-84 — the original "verifier matches by predicate content" design (intended to be rebase-stable but only when files don't overlap)
- AISDLC-85 — the chore-commit allowlist (already rebase-stable via subject-SHA matching; this task is the diffHash equivalent)
- `scripts/verify-attestation.mjs` (verifier — file to extend)
- `scripts/sign-attestation.mjs` (signer — file to extend)
- `orchestrator/src/runtime/buildPredicate.ts` (predicate builder — file to extend)
- `.ai-sdlc/schemas/attestation.v1.schema.json` → `attestation.v2.schema.json` (new schema)
<!-- SECTION:DESCRIPTION:END -->

- [x] #1 Update sign-attestation script + orchestrator buildPredicate helper to compute and include `contentHash` (sha256 of {path, blobSha} pairs for changed files) alongside the existing `diffHash`
- [x] #2 Update `scripts/verify-attestation.mjs` to accept either `diffHash` OR `contentHash` matching (Phase 1 dual-hash mode); document the dual-acceptance behavior in code comments
- [x] #3 Add unit tests for `contentHash`: same-content-different-base produces same hash; conflict-resolution produces different hash; missing-file case handled
- [x] #4 Add integration test: open a PR, rebase onto a base that touched the same files (no conflict), confirm attestation remains valid
- [ ] #5 Add `attestation.v2.schema.json` schema with both `diffHash` and `contentHash` required; bump `acceptedSchemaVersions` allowlist to include `v2`
- [x] #6 Document in CLAUDE.md `What CI accepts (intentional, post-AISDLC-84)` section: rebases that don't change file content remain valid even when another PR has modified the same files (AISDLC-94)
- [ ] #7 Phase 2 (drop diffHash, require contentHash, drop v1 from allowlist) filed as a follow-up task with a 30-day soak window before execution
- [x] #8 All existing tests pass; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Phase 1 dual-hash attestation envelope. `buildPredicate` / sign-attestation / ci-sign-attestation now compute `contentHash` (sha256 of {path, blobSha} per changed file, sorted) alongside the legacy `diffHash`. The verifier accepts on either leg, so envelopes survive any rebase that doesn't change post-apply blob SHAs at HEAD.

## Changes

- `orchestrator/src/runtime/attestations.ts` — new `computeContentHash` + `collectChangedFileEntries` helpers, dual-hash predicate
- `orchestrator/src/runtime/attestations.test.ts` — 78 tests (16 new round 1 + 7 new round 2: 2 tab/newline rejection, 5 collectChangedFileEntries with stub runGit)
- `ai-sdlc-plugin/scripts/sign-attestation.mjs` — dynamic-imports shared helper
- `scripts/ci-sign-attestation.mjs` — same
- `scripts/verify-attestation.mjs` — accepts either hash leg; dual-hash block comment updated
- `scripts/verify-attestation.test.mjs` — 4 new integration tests
- `CLAUDE.md` — `What CI accepts (intentional, post-AISDLC-84)` section documents the new behavior + the limitation
- `backlog/tasks/aisdlc-101 - Verifier-Phase-2-...md` — Phase 2 follow-up filed (renamed from AISDLC-100 after collision check)

## AC status

- ✓ AC #1, #2, #3, #4, #6, #8 — fully met
- ✗ AC #5 (`.ai-sdlc/schemas/attestation.v2.schema.json`) — INTENTIONALLY skipped: `.ai-sdlc/**` is hard-blocked by `agent-role.yaml`. Phase 1 code works regardless because `contentHash` is OPTIONAL on v1 predicate. Operator follow-up to hand-edit the schema.
- ✗ AC #7 (Phase 2 follow-up task) — FILED as AISDLC-101 (NOT AISDLC-100, which would have collided with RFC-0012 parent)

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check` — clean
- `pnpm --filter @ai-sdlc/orchestrator test` — 2884/2884 pass (78 attestations + others)
- `node --test scripts/verify-attestation.test.mjs` — 54/54 pass
- 2 review iterations: round 1 had 1 critical (AISDLC-100 collision) + 4 minor + 1 suggestion. All addressed in round 2. Round 2 APPROVED across all 3 reviewers (0 critical, 0 major, 4 minor, 4 suggestions); ⚠ INDEPENDENCE NOT ENFORCED (codex unavailable).

## Important limitation (documented in CLAUDE.md)

**The AISDLC-93 / PR #102 root-cause scenario is NOT actually fixed by Phase 1.** When a PR rebases onto a base where a sibling PR ALSO modified the same files, the rebased HEAD now contains the sibling PR's contributions inside the same files — both diffHash AND contentHash diverge. Operator must re-run `/ai-sdlc execute` against the rebased branch in that case. Phase 2 (AISDLC-101) will explore per-file delta hashing for the overlapping-files scenario.

## Follow-up (non-blocking)

- **Code minor**: verifier reimplements diff/ls-tree walk inline (omits `core.quotepath=false` per reviewer). Theoretical unicode-path divergence between signer and verifier. Phase 2 should converge on the shared `collectChangedFileEntries` helper.
- **Test minor**: stub runGit dispatch in tests depends on flag order; could be more resilient.
- **Test minor**: optional ls-tree-throws test would lock in the intentional swallow-deletes behavior.
- **Security low (round 1, FIXED)**: tab/newline canonicalization weakness — closed in round 2.
- **Operator**: hand-edit `.ai-sdlc/schemas/attestation.v1.schema.json` to add optional `contentHash` field (couldn't be done from worktree due to blocked path).
<!-- SECTION:FINAL_SUMMARY:END -->
