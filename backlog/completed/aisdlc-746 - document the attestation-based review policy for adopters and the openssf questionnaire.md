---
id: AISDLC-746
title: >-
  document the attestation-based review policy for adopters and the OpenSSF questionnaire
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - docs
  - governance
dependencies: []
references:
  - docs/operations/decision-authority.md
  - README.md
  - SECURITY.md
  - CONTRIBUTING.md
  - orchestrator/src/cli/commands/doctor.ts
  - orchestrator/src/cli/commands/init.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
From DEC-0065 (operator, 2026-10-06): main keeps 0 required human approvals; the review signal is the signed three-reviewer attestation verified in the `ai-sdlc/pr-ready` rollup. Scorecard Code-Review alert 126 was dismissed with this reason.

Write a short policy page under `docs/operations` covering: what counts as a review, the nonce-bound reviewer transcripts, the v6 envelope, how an adopter verifies one, and how a human overrides. Link it from README, SECURITY and CONTRIBUTING as appropriate, and have `ai-sdlc init` output and `ai-sdlc doctor` point to it. Write it so the OpenSSF Best Practices questionnaire (alert 127, kept open until this lands) can cite it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] The review policy page exists under `docs/operations` and covers review definition, nonce-bound transcripts, the v6 envelope, adopter verification and human override.
- [x] The page is linked from README, SECURITY and CONTRIBUTING as appropriate.
- [x] `ai-sdlc init` output and `ai-sdlc doctor` name the policy page.
- [x] One test covers the doctor and init text.
