---
id: AISDLC-732
title: >-
  Signer writes the v6 attestation envelope unformatted, so the format check fails and every PR needs a second push
status: To Do
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
- [ ] The signer (`ai-sdlc-plugin/scripts/sign-attestation.mjs`, and the verify path it shares) writes JSON that prettier leaves unchanged.
- [ ] A test in `ai-sdlc-plugin/scripts/sign-attestation.test.mjs` runs prettier's check over a freshly signed envelope.
- [ ] The verifier still accepts envelopes signed before the change (test with an existing envelope under `.ai-sdlc/attestations/`).
- [ ] Fallback only if the above is not feasible: exclude the attestations folder from the format check (`.prettierignore`), with the reason stated in the PR.
<!-- SECTION:DESCRIPTION:END -->
