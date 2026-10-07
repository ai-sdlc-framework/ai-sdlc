---
id: AISDLC-704.6
title: >-
  move verify-attestation and untrusted-pr-gate off the fork-head checkout
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - security
dependencies: []
references:
  - backlog/completed/aisdlc-704 - fix the two critical DangerousWorkflow code-scanning alerts and triage the open backlog.md
priority: medium
parentTaskId: AISDLC-704
updated_date: '2026-10-07 17:39'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from AISDLC-704 (code-scanning triage). `.github/workflows/verify-attestation.yml` and `.github/workflows/untrusted-pr-gate.yml` still check out the fork PR head into `pr-content/`. Apply the AISDLC-704 contents-API pattern (hex-validated sha, head repo bound through env, data only) to pre-empt the same DangerousWorkflow alert class, keeping the verifier behaviour identical.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The change described above is implemented with tests.
- [ ] The listed code-scanning alerts read `fixed` after merge.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
verify-attestation.yml and untrusted-pr-gate.yml no longer check out the fork PR head. verify-attestation fetches the head git objects and stages envelopes and transcript leaves through the new scripts/stage-attestation-data.sh (git ls-tree + git show, strict filename regexes, regular blobs only). untrusted-pr-gate builds a headless pr-content git dir from a hex-validated, env-bound fetch of base and head.

## Changes
- `.github/workflows/verify-attestation.yml` (modified): head objects fetched first, staging via script; event values bound through env.
- `.github/workflows/untrusted-pr-gate.yml` (modified): fetch step replaces both checkouts; dead HEAD~1 fallback removed, fails closed.
- `scripts/stage-attestation-data.sh` (new): data-only staging, no per-file API calls, no 1000-entry cap.
- `.github/workflows/__tests__/*.test.mjs` (modified): contract + hermetic staging tests.
- `docs/operations/operator-runbook.md`, `docs/api-reference/rfc-0043-ucvg.md` (modified): describe the new design.

## Design decisions
- **git objects instead of contents API**: round-1 review showed the contents API caps listings at 1000 entries and costs about 1000 token calls per run.

## Verification
- `node --test .github/workflows/__tests__/*.test.mjs` - 442/442 pass
- eslint + prettier clean on changed files (lint-staged)
- Reviews approved (security, code; Codex unavailable so Claude-native code-reviewer)

## Follow-up
declined: stale step name/comment in verify-attestation.yml and stage_blob ::error:: going to stdout are cosmetic minors; AC2 (alerts read fixed) is a post-merge check
<!-- SECTION:FINAL_SUMMARY:END -->
