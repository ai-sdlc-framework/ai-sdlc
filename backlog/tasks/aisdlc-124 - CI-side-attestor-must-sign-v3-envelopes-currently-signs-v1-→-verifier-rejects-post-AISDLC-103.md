---
id: AISDLC-124
title: >-
  CI-side attestor must sign v3 envelopes (currently signs v1 → verifier rejects
  post-AISDLC-103)
status: To Do
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
  - scripts/ci-sign-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - .ai-sdlc/schemas/attestation.v3.schema.json
  - .github/workflows/ai-sdlc-review.yml
  - spec/rfcs/RFC-0009-trusted-reviewers.md
priority: high
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
