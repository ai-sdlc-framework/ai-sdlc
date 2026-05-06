---
id: AISDLC-193.1
title: >-
  Stage 2 — contentHashV4 base-independent per-file hash + envelope
  self-exclusion (rebase-stable, queue-survivable)
status: Done
assignee: []
created_date: '2026-05-05 22:50'
labels:
  - bug
  - attestation
  - framework-bug
  - ci
  - rfc-0012
  - critical-path
parentTaskId: AISDLC-193
dependencies: []
references:
  - orchestrator/src/runtime/attestations.ts
  - orchestrator/src/runtime/attestations.test.ts
  - scripts/verify-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - backlog/completed/aisdlc-193 - Re-enable-attestation-as-required-merge-gate-design-rebase-stable-HEAD-content-binding.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Goal

Replace `contentHashV3` (base-dependent per-file delta hash) with `contentHashV4` (base-independent per-file `{path, headBlobSha}` map) so attestation envelopes survive merge-queue rebases. Plus exclude the envelope file itself from the hashed file set so the chore-commit pattern (sign at dev commit → commit envelope at chore commit → push) doesn't chicken-and-egg.

This unblocks AISDLC-193 stage 1 (re-enable as required merge gate) — without this fix, every code-touching PR deadlocks at the queue, exactly as PR #334 demonstrated within an hour of the stage-1 flip on 2026-05-05.

## Background

`contentHashV3 = sha256("<baseBlobSha> -> <headBlobSha>")` per changed file. The per-file delta is keyed off the base blob SHA — when the queue rebases the PR onto a sibling-merged main, the base blob SHAs for shared files change → contentHashV3 invalidates → required check fails → queue rejects.

Empirical reproducer (2026-05-05): PR #334 entered the queue. The queue created a fresh replay commit `1c93ce75` parented at current main `491aef92`. The verifier walked the queue commit's ancestors, none matched the envelope's subject SHA `5ceea7da`, and `ai-sdlc/attestation: failure — contentHashV3 mismatch (PR content differs from attested content)` was posted on the queue commit.

Plus a separate failure mode: when the chore commit adds the envelope file `.ai-sdlc/attestations/<sha>.dsse.json` to the diff, contentHashV3's file enumeration NOW includes the envelope file, but the envelope's expected hash was computed BEFORE the envelope existed → mismatch even on direct PR HEAD. This is masked today by the verifier's ancestor walk catching the dev-commit before the chore commit, but it adds fragility.

## Design — contentHashV4

### Algorithm

```ts
// Per-file canonical entry — head blob only, no base reference
type ContentHashV4Entry = { path: string; headBlobSha: string };

function computeContentHashV4(entries: ContentHashV4Entry[]): string {
  // Sort by path for determinism (matches v3's sort discipline)
  const sorted = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(e => ({ path: e.path, headBlobSha: e.headBlobSha }));
  return crypto.createHash('sha256')
    .update(JSON.stringify(sorted))
    .digest('hex');
}
```

The hash binds reviewers' approval to "I approved these files at these specific content blobs." Whatever the rebase does to the base ref, as long as the head blob SHAs (= the actual reviewed content) are unchanged, the hash matches.

### Envelope self-exclusion

The file collector (`collectChangedFileDeltaEntries` in `orchestrator/src/runtime/attestations.ts` lines 756+) currently includes ALL changed files between base and head. After this fix, paths matching `^\.ai-sdlc/attestations/[^/]+\.dsse\.json$` MUST be excluded from BOTH v4 hashing (because the envelope can't hash itself) AND v3 (back-compat — the dev commit shouldn't have been in the hash anyway, this just becomes explicit).

The exclusion only applies to the file COLLECTOR for hashing purposes. The chore-commit allowlist (`CHORE_COMMIT_PATH_ALLOWLIST` in `scripts/verify-attestation.mjs` line 369) STILL allows the envelope file in the chore-commit diff.

### Verifier behavior

When verifying a PR head against an envelope:

1. Extract `expectedContentHashV4` from envelope predicate (if present); fall back to `expectedContentHashV3` for legacy envelopes (back-compat).
2. Compute current `contentHashV4` from PR HEAD's file blob SHAs vs main, EXCLUDING `.ai-sdlc/attestations/<sha>.dsse.json` from the file set.
3. If v4 hashes match → success. (Skip the ancestor walk entirely — v4 is base-independent so no walk needed.)
4. If v4 hashes don't match → check if envelope is v3-only (legacy); if so, fall through to existing v3 ancestor walk.
5. If envelope has v4 AND v4 doesn't match → genuine content mismatch. Fail.

### Migration / back-compat

- Envelopes signed BEFORE this lands have only `contentHashV3`. The verifier handles them via the existing ancestor walk.
- Envelopes signed AFTER this lands have BOTH `contentHashV3` AND `contentHashV4`. The verifier prefers v4 (faster + rebase-stable), falls back to v3 if v4 fails (defense in depth).
- After all in-flight v3-only envelopes drain through (estimated 1-2 weeks), v3 can optionally be removed from the predicate (or kept as audit trail).

## Why this is critical-path

PR #334 (AISDLC-205, the docs-only fallback) demonstrated within an hour of stage 1's flip that the rebase-invalidation loop reproduces under the new gate. All code-touching PRs will deadlock until this lands. AISDLC-193's protection flip cannot be re-attempted until AISDLC-193.1 ships.

## Implementation notes

Prefer minimal-diff: add `contentHashV4` field to the predicate WITHOUT removing v3. Update `buildPredicate()` to populate both. Update verifier to try v4 first then fall through. Tests must cover:

- Identical content vs base → v3 differs across rebase, v4 matches
- Sibling rebase touching same file → v3 invalidates, v4 stays valid as long as our head blob is unchanged
- Sibling rebase modifying our head blob (genuine content change) → v4 correctly invalidates (this is the desired strictness)
- Envelope self-exclusion: chore-commit diff includes `.ai-sdlc/attestations/<sha>.dsse.json` but the v4 hash computation on the chore-commit's file set produces the same v4 as the dev-commit's file set
- Legacy v3-only envelope still verifies via ancestor walk
- New envelope with both v3 + v4 verifies via v4 first

After this lands + stable for 1 week, re-do AISDLC-193 stage 1 (re-add `ai-sdlc/attestation` to required_status_checks).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 New `computeContentHashV4(entries)` function in `orchestrator/src/runtime/attestations.ts` — base-independent, sorts by path, hashes JSON of `{path, headBlobSha}` pairs
- [ ] #2 `buildPredicate()` populates BOTH `contentHashV3` (legacy) AND `contentHashV4` (new) on every signed envelope
- [ ] #3 `collectChangedFileDeltaEntries()` excludes `.ai-sdlc/attestations/<sha>.dsse.json` paths from the returned entry set (envelope self-exclusion)
- [ ] #4 `scripts/verify-attestation.mjs` prefers v4 when present in the envelope; falls back to v3 ancestor walk for legacy envelopes
- [ ] #5 Verifier with v4-enabled envelope correctly accepts a PR-head whose content blob SHAs match the envelope, regardless of base ref movement (tested via fixture commit pair simulating queue rebase)
- [ ] #6 Verifier with v4-enabled envelope correctly REJECTS a PR-head whose content blob SHAs differ from the envelope (genuine modification)
- [ ] #7 Envelope self-exclusion verified: hash computed at dev-commit's file set EQUALS hash computed at chore-commit's file set (chore commit only adds the envelope file)
- [ ] #8 Legacy v3-only envelope still verifies via existing ancestor walk path (back-compat preserved)
- [ ] #9 Tests in `orchestrator/src/runtime/attestations.test.ts` cover all 6 scenarios in the Implementation Notes (identical, sibling-rebase-shared-file-our-blob-unchanged, sibling-rebase-modifies-our-blob, envelope-self-exclusion, legacy v3-only, dual v3+v4)
- [ ] #10 New code reaches 80%+ patch coverage
- [ ] #11 Documentation update: CLAUDE.md "## Review attestations" section reflects the v4 → v3 fallback chain (current text says only "contentHashV3" — keep both for the transition window)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped via PR #335 (fix(orchestrator): contentHashV4 base-independent hash + envelope self-exclusion). This lifecycle close was missed by the original PR (per AISDLC-203 — Codex/automation workflow doesn't atomically complete tasks); batched into chore/backlog-sync 2026-05-05.
<!-- SECTION:FINAL_SUMMARY:END -->
