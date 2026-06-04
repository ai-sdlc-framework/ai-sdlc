---
id: AISDLC-512
title: 'feat(ucvg): RFC-0043 Phase 7 — integration glue: real report → clean-room sign → attestation'
status: To Do
assignee: []
labels:
  - rfc-0043
  - phase-7
  - integration
dependencies:
  - AISDLC-511
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - pipeline-cli/src/cli/ucvg.ts
  - pipeline-cli/src/pipeline/clean-room-signer.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wire the now-real pieces together end-to-end in `cli-ucvg` (W5): real differential results (AISDLC-509) + real reviewer verdicts (AISDLC-511) → unsigned report → cross-runner artifact transfer → clean-room signer (Stage 4, already implemented) → v6 attestation. Stage 4 already refuses unapproved/injection-flagged reports; this task proves the *happy path* actually reaches it with genuine data.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `sandbox-run` writes an unsigned report containing real differential results + real reviewer verdicts (no placeholders)
- [ ] #2 The cross-runner artifact transfer (sandbox-and-review → clean-room-sign, upload/download-artifact from AISDLC-501) is validated end-to-end with real content
- [ ] #3 Stage 4 signs a genuinely-approved report → produces a v6 attestation that `verify-attestation.mjs` reports `status=valid`; an unapproved/injection-flagged report is refused (`phase: consensus-rejected`)
- [ ] #4 The `untrusted-pr-gate.yml` job chain runs the real path (Docker driver) instead of erroring on the stub
- [ ] #5 build/test/lint clean; ≥80% patch coverage on new glue
<!-- AC:END -->
