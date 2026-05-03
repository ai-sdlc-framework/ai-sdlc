---
id: AISDLC-124
title: >-
  CI-side attestor must sign v3 envelopes (currently signs v1 → verifier rejects
  post-AISDLC-103)
status: Done
assignee: []
created_date: '2026-05-01 21:24'
labels:
  - ci
  - attestation
  - infrastructure
  - follow-up
milestone: m-3
dependencies: []
references:
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - .ai-sdlc/schemas/attestation.v3.schema.json
  - .github/workflows/ai-sdlc-review.yml
priority: high
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: 'Referenced file no longer exists: scripts/ci-sign-attestation.mjs'
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: 'Referenced file no longer exists: spec/rfcs/RFC-0009-trusted-reviewers.md'
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
CI-attestor / verifier schema-version mismatch causing `ai-sdlc/attestation` status check to fail on every PR that doesn't have a locally-signed attestation (chore PRs, docs PRs, contributor PRs without signing keys).

**Symptom:** PR #148 (chore — backlog task files only) shows `ai-sdlc/attestation: FAILURE — invalid (schemaVersion 'v1' not in allowlist [v3])`. Same pattern on every chore/docs PR shipped via `--no-verify`.

**Root cause:** Per CLAUDE.md AISDLC-103, the verifier's allowlist narrowed to `['v3']` only. The local `/ai-sdlc execute` signing flow uses `ai-sdlc-plugin/scripts/sign-attestation.mjs` which writes v3 envelopes — those pass. But `scripts/ci-sign-attestation.mjs` (the CI-side attestor per AISDLC-87, which signs after CI's 3 reviewer agents approve) was never updated past v1 — its envelopes carry `schemaVersion: 'v1'` with `diffHash` instead of `contentHashV3`, and the verifier rejects them.

**Effect:** every PR not run through `/ai-sdlc execute` shows red on `ai-sdlc/attestation`. Erodes trust in the attestation gate; trains operators to ignore failing checks.

**Fix:** port the v3 predicate-building logic from `ai-sdlc-plugin/scripts/sign-attestation.mjs` (or factor a shared module both scripts import) and update `scripts/ci-sign-attestation.mjs` to write `schemaVersion: 'v3'` envelopes with `contentHashV3` per the AISDLC-101/103 spec.

**Verification:** open a docs-only chore PR after the fix and confirm `ai-sdlc/attestation` reports SUCCESS.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 scripts/ci-sign-attestation.mjs writes envelopes with schemaVersion: 'v3' and contentHashV3 (no legacy diffHash/contentHash fields)
- [ ] #2 Predicate-building logic shared between local + CI signing scripts (extract to a common module under ai-sdlc-plugin/scripts/lib/ or pipeline-cli/scripts/)
- [ ] #3 Existing local /ai-sdlc execute attestation flow still produces verifier-passing envelopes (no regression)
- [ ] #4 New chore/docs PR opened post-fix shows ai-sdlc/attestation: SUCCESS (verified by re-running the workflow)
- [ ] #5 CLAUDE.md "CI-side attestor (AISDLC-87)" section updated to reflect v3 schema
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Outcome: SUPERSEDED — diagnosis was incorrect

Closed without separate implementation work. PR #152 actually fixed the symptom (`ai-sdlc/attestation` red on chore/docs PRs) via a different root cause than this task described.

## What this task got wrong

This task asserted the CI-attestor was signing v1 envelopes. That's incorrect. Both signing scripts (`scripts/ci-sign-attestation.mjs` and `ai-sdlc-plugin/scripts/sign-attestation.mjs`) ALREADY emit v3 envelopes correctly via the shared `buildPredicate` at `orchestrator/src/runtime/attestations.ts:886` (hardcoded `schemaVersion: 'v3'`).

## Actual root cause + fix (PR #152)

The verifier (`scripts/verify-attestation.mjs:707-711`) scans ALL envelopes in `.ai-sdlc/attestations/` and surfaces the "closest mismatch" reason when no envelope matches the PR's expected predicate. The repo carried 48 v1 envelopes from pre-AISDLC-103 commits — these never matched current PRs but DID surface as the closest-mismatch reason `schemaVersion 'v1' not in allowlist [v3]` whenever a PR lacked a fresh local v3 envelope.

PR #152 deletes the 48 stale v1 envelopes (preserving the 6 legitimate post-AISDLC-103 v3 ones).

## Follow-up worth filing separately

The verifier behavior of "scan all envelopes, surface any mismatch as closest-match" means a single bad envelope (introduced accidentally or maliciously in a future commit) can poison the gate even after this cleanup. A defensive hardening worth considering: skip envelopes whose `schemaVersion` is outside the allowlist during the closest-match selection rather than including them as candidates. That would isolate the gate from envelope-noise in the attestations directory.

If anyone picks that up, file as a new task (rather than reopening this one).
<!-- SECTION:FINAL_SUMMARY:END -->
