---
id: AISDLC-732
title: >-
  Signer writes the v6 attestation envelope unformatted, so the format check fails and every PR needs a second push
status: Done
assignee: []
created_date: '2026-10-05'
labels:
  - attestation
  - friction
dependencies: []
references:
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.test.mjs
  - .prettierignore
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tier 1 friction. Seen on PRs #1185 (AISDLC-693) and #1212 (AISDLC-690) on 2026-10-05: `pnpm format:check` fails on the envelope under `.ai-sdlc/attestations/`, so the executor adds a prettier-only commit and pushes again.

This task removes friction; it adds no new check.

## Acceptance Criteria
- [x] The signer (`ai-sdlc-plugin/scripts/sign-attestation.mjs`, and the verify path it shares) writes JSON that prettier leaves unchanged.
- [x] A test in `ai-sdlc-plugin/scripts/sign-attestation.test.mjs` runs prettier's check over a freshly signed envelope.
- [x] The verifier still accepts envelopes signed before the change (test with an existing envelope under `.ai-sdlc/attestations/`).
- [x] Fallback only if the above is not feasible: exclude the attestations folder from the format check (`.prettierignore`), with the reason stated in the PR.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Both envelope writers now emit prettier-identical JSON: a dependency-free formatter reproduces prettier's JSON rules (short arrays such as a one-element merkle proof collapse onto one line), so `pnpm format:check` passes on a freshly signed envelope.

## Changes
- `ai-sdlc-plugin/scripts/format-envelope-json.mjs` (new): formatter used by `sign-attestation.mjs`.
- `pipeline-cli/src/attestation/format-json.ts` (new): TS port used by `sign-v6.ts`.
- Tests: prettier --check over a freshly signed envelope, formatter vs prettier, round-trip of existing envelopes.

## Design decisions
- **Own formatter, not prettier**: the signer runs in adopter repos where prettier may be absent. Verifiers JSON.parse the envelope and check the signed payload, so whitespace never affects verification.

## Verification
- build clean; sign-attestation tests pass except 3 pre-existing adopter-runtime-resolution failures unrelated to this change.

## Follow-up
(none)
<!-- SECTION:FINAL_SUMMARY:END -->
