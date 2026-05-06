---
id: AISDLC-207
title: >-
  Verifier error message misleading — defaults to "contentHashV3 mismatch" for
  the no-envelope case
status: Done
assignee: []
created_date: '2026-05-06 02:00'
labels:
  - bug
  - ci
  - attestation
  - dx
references:
  - scripts/verify-attestation.mjs
  - .github/workflows/verify-attestation.yml
  - >-
    backlog/completed/aisdlc-193.1 -
    Stage-2-contentHashV4-base-independent-per-file-hash-plus-envelope-self-exclusion.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

When a PR has NO attestation envelope at all, `verify-attestation.yml` posts `ai-sdlc/attestation: failure — contentHashV3 mismatch (PR content differs from attested content)`. The "contentHashV3 mismatch" wording is the verifier's DEFAULT failure description and gets used regardless of the actual failure mode:

- envelope present + v4 mismatch → "contentHashV3 mismatch" (misleading — it's a v4 mismatch)
- envelope present + v3 mismatch (v4 absent / legacy envelope) → "contentHashV3 mismatch" (accurate but ambiguous with the others)
- envelope absent → "contentHashV3 mismatch" (very misleading — there's no v3 to mismatch against)

The misleading wording confused the operator on PR #338 — they reasonably asked "why is it still doing the old v3 attestation?" thinking the v4-prefer logic from AISDLC-193.1 wasn't working. In fact the verifier IS using v4 properly, but reports the same generic error string regardless.

## Impact

Operator/contributor diagnosis time on attestation failures is harder than it needs to be. The wording suggests the v4 work didn't ship or has a bug, when usually the actual cause is "no envelope was signed" (e.g., docs-only PR pushed with `AI_SDLC_SKIP_ATTESTATION_SIGN=1`).

## Goal

Distinguish the actual failure mode in the description text:

- `no envelope present at <head>` (when `.ai-sdlc/attestations/<sha>.dsse.json` doesn't exist for any reachable ancestor)
- `contentHashV4 mismatch` (envelope present, v4 doesn't match)
- `contentHashV3 mismatch (v3 fallback)` (envelope present without v4, v3 fallback path also doesn't match)
- `signature invalid` (envelope present but signature verification failed)

The status URL in the PR check should link to the workflow run, and the workflow run logs should show the precise reason.

## Implementation notes

`scripts/verify-attestation.mjs` builds the `description` argument to `gh api repos/.../statuses/<sha>` somewhere in the post-step. Likely a single ternary or the `else` branch of a hash-match check defaults to the generic string. Refactor to surface the specific failure mode based on which check failed.

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 When no envelope file exists for any reachable ancestor, the posted description reads `no envelope present at <head>` (or equivalent), not the generic v3-mismatch wording
- [x] #2 When envelope present + v4 mismatch, description reads `contentHashV4 mismatch` explicitly
- [x] #3 When envelope present without v4 + v3 fallback also mismatches, description reads `contentHashV3 mismatch (v3 fallback)` so the v3-vs-v4 distinction is visible
- [x] #4 When signature verification fails (key not in trusted-reviewers, malformed envelope), description reads `signature invalid: <reason>`
- [x] #5 Hermetic test in `scripts/verify-attestation.test.mjs` covers each of the 4 failure modes with the expected description string
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Code work shipped via PR #341 (commit `735dc9a` — `fix(orchestrator): distinguish verifier failure modes in description`). The dev opened PR #341 with the source changes + envelope but didn't include the lifecycle close — exactly the AISDLC-203 bug pattern.

This PR is the bookkeeping close: file move tasks/→completed/, status flip, AC checkboxes (all 5 verified met by the merged code: AC #1-4 distinct description strings + AC #5 hermetic tests in `scripts/verify-attestation.test.mjs`).
<!-- SECTION:FINAL_SUMMARY:END -->
