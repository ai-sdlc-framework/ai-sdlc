---
id: AISDLC-739
title: >-
  review prompts embed the diff-binding nonce and the pre-push sign hook keeps committed envelopes
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - governance
dependencies: []
references:
  - pipeline-cli/src/steps/07-build-review-prompts.ts
  - pipeline-cli/src/cli/attestation.ts
  - ai-sdlc-plugin/scripts/check-attestation-sign.sh
priority: high
dispatchable: true
updated_date: '2026-10-10 14:58'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two defects. (a) The Step 7 review-prompt builder does not embed the diff-binding nonce, so reviewers run outside the executor come out self-authored unless the caller appends `[[ai-sdlc-nonce: N]]` by hand and calls emit-leaf with `--agent-id --nonce --project-dir <session root> --claude-session-id`.

(b) The pre-push attestation-sign hook deletes a valid committed attestation envelope from the working copy as "stale (rebase cycle)". Fix is to `git checkout` the file instead of deleting it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The Step 7 prompt builder embeds `[[ai-sdlc-nonce: N]]` in every review prompt (test).
- [x] A reviewer run outside the executor using that prompt and emit-leaf is not classified self-authored.
- [x] The pre-push sign hook restores a committed envelope with `git checkout` instead of deleting it (test).
- [x] The working copy still has the committed envelope after a rebase-cycle push.

## Final Summary

## Summary
Step 7 review prompts now embed a head-SHA-bound `[[ai-sdlc-nonce: N]]` marker, and the pre-push attestation-sign hooks restore a committed stale envelope with `git checkout` instead of deleting it.

## Changes
- `pipeline-cli/src/steps/07-build-review-prompts.ts` (modified): generates one nonce per build, appends the marker to every prompt, returns `nonce` and `headSha`.
- `pipeline-cli/src/types.ts` (modified): optional `nonce`/`headSha` result fields.
- `pipeline-cli/src/steps/07-build-review-prompts.test.ts` (modified): nonce-embedding test.
- `scripts/check-attestation-sign.sh`, `ai-sdlc-plugin/scripts/check-attestation-sign.sh` (modified): `git checkout HEAD --` restore for committed stale envelopes; rm fallback when uncommitted.
- `scripts/check-attestation-sign.test.mjs` (modified): asserts the committed envelope survives a rebase-cycle push.

## Design decisions
- **Head-named v6 envelope still deleted** in `scripts/check-attestation-sign.sh` (AISDLC-543 case): restoring it would fail the verifier's filename check.

## Verification
- `pnpm build` — clean
- pipeline-cli steps + attestation tests: 649 pass; hook node --test: 64 pass, 2 skipped
- `pnpm lint` — clean; format:check clean on changed files

## Follow-up
- declined: no dedicated emit-leaf classification test (the prompt uses the same `nonceMarkerLiteral` helper emit-leaf/harness scan consume).
