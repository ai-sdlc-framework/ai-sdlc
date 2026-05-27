---
id: AISDLC-445
title: >-
  fix(ci): verify-attestation.yml Stage step must propagate per-patch-id
  transcript-leaves directory (AISDLC-421 follow-up)
status: To Do
assignee: []
created_date: '2026-05-27 01:39'
labels:
  - bug
  - ci
  - rfc-0042
  - attestation
  - high
dependencies: []
references:
  - .github/workflows/verify-attestation.yml
  - >-
    backlog/completed/aisdlc-421 -
    fixattestation-RFC-0042-amendment-—-per-task-transcript-leaves-files-to-eliminate-cross-PR-rebase-conflicts.md
  - >-
    backlog/completed/aisdlc-422 -
    fixattestation-RFC-0042-follow-up-—-exclude-.ai-sdlc-transcript-leaves-from-PATCH_ID_EXCLUSION-AISDLC-421-self-reference-bug.md
  - scripts/verify-attestation.mjs
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`verify-attestation.yml`'s `Stage fork envelope for verifier (DATA-ONLY copy)` step copies the singular `.ai-sdlc/transcript-leaves.jsonl` (the legacy shared fallback) into main's working tree but does NOT propagate the per-patch-id `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` directory introduced by AISDLC-421.

The CI verifier then falls back to the shared file (which carries stale leaves from whichever PR landed most recently) instead of the per-patch-id file that contains the PR's actual reviewer leaves. The recomputed Merkle root from stale leaves does not match the envelope's signed root, producing the misleading error:

```
v6: rootSignature did not match any trusted reviewer pubkey
```

The signature is fine; the leaves it is verified against are wrong.

## Empirical evidence

PRs 727 (AISDLC-443) and 729 (AISDLC-444), both opened 2026-05-26, hit this exact failure after auto-rearm rebased their branches onto post-AISDLC-435 main. Local `node scripts/verify-attestation.mjs` returned `status=valid reason=ok` for both. CI failed both. CI log shows:

```
[v6-verifier] leaves source: shared (.ai-sdlc/transcript-leaves.jsonl) [AISDLC-421 legacy fallback, full file]
reason=v6: rootSignature did not match any trusted reviewer pubkey
```

The per-patch-id file existed on the PR branch but was never staged into main's working tree where the verifier ran.

## Operator workaround applied (re-introduces AISDLC-421 friction)

Both PRs were unblocked by overwriting `.ai-sdlc/transcript-leaves.jsonl` on the PR branch with the per-patch-id leaves content. This works for verification but re-introduces the exact cross-PR rebase conflict on the shared file that AISDLC-421 was designed to eliminate (PR 729 now CONFLICTING after PR 727 merged because both modified the shared file).

## Proper fix

`verify-attestation.yml`'s `Stage fork envelope for verifier (DATA-ONLY copy)` step must additionally:

- Copy `pr-content/.ai-sdlc/transcript-leaves/*.jsonl` (per-patch-id directory) into main's working tree at `.ai-sdlc/transcript-leaves/*.jsonl`
- Apply the same filename validation as the attestations directory: `<40hex>.jsonl` pattern only (path-traversal guard)
- Same DATA-only contract (no execution)

After the fix, the verifier's `v6ResolveLeavesForEnvelope` per-patch-id-first lookup will find the staged per-patch-id file and skip the shared-fallback path entirely. Cross-PR friction on the shared file disappears.

## Scope

Two minor changes to `.github/workflows/verify-attestation.yml`:

1. The `Stage fork envelope` step: add a loop over `pr-content/.ai-sdlc/transcript-leaves/*.jsonl` with the same `[[ "$basename" =~ ^[0-9a-f]{40}\.jsonl$ ]]` filename validation pattern as the existing attestations loop.
2. The merge_group branch: add `git checkout "$HEAD_SHA" -- '.ai-sdlc/transcript-leaves/'` alongside the existing `transcript-leaves.jsonl` checkout.

Hermetic test: extend `.github/workflows/__tests__/verify-attestation.test.mjs` (or create if absent) to assert both the per-PR-event and merge_group code paths stage the per-patch-id directory.

## Verification

- [ ] After fix, simulate a PR with per-patch-id leaves only (no shared file content matching current PR). CI verifier finds per-patch-id file via primary lookup; verification succeeds without the shared-file fallback.
- [ ] Two concurrent PRs do not conflict on `.ai-sdlc/transcript-leaves.jsonl` (because both leave it unchanged — they only write per-patch-id files).
- [ ] Existing PRs with shared-file-only leaves (pre-AISDLC-421) continue to verify successfully via the AISDLC-421 fallback path.

## Related

- AISDLC-421 — per-patch-id transcript-leaves files (the upstream design that this CI gap broke)
- AISDLC-422 — exclude `.ai-sdlc/transcript-leaves/` from PATCH_ID_EXCLUSION
- PR 727 + PR 729 (2026-05-26) — operator-applied workaround that re-introduced cross-PR conflicts
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 #1 `.github/workflows/verify-attestation.yml`'s `Stage fork envelope for verifier` step copies `pr-content/.ai-sdlc/transcript-leaves/*.jsonl` (per-patch-id directory) into `.ai-sdlc/transcript-leaves/*.jsonl` with `[[ ^[0-9a-f]{40}\.jsonl$ ]]` filename validation (path-traversal guard)
- [ ] #2 #2 The merge_group branch in `verify-attestation.yml` adds `git checkout "$HEAD_SHA" -- '.ai-sdlc/transcript-leaves/'` alongside the existing shared-file checkout
- [ ] #3 #3 Same DATA-only contract — no execution, no sandbox-to-PATH promotion, file is only read by `node scripts/verify-attestation.mjs`
- [ ] #4 #4 Hermetic test in `.github/workflows/__tests__/verify-attestation.test.mjs` asserts per-patch-id directory is staged in both pull_request_target and merge_group code paths
- [ ] #5 #5 Regression test: simulate a PR with ONLY per-patch-id leaves (shared file unchanged from main). Verifier finds per-patch-id via primary lookup; verification succeeds
- [ ] #6 #6 Existing PRs with shared-file-only leaves (pre-AISDLC-421 legacy) continue to verify via AISDLC-421 fallback path
- [ ] #7 #7 Two concurrent PRs no longer conflict on `.ai-sdlc/transcript-leaves.jsonl` (the AISDLC-421 cross-PR friction elimination contract is restored)
<!-- AC:END -->
