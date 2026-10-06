---
id: AISDLC-704.6
title: >-
  move verify-attestation and untrusted-pr-gate off the fork-head checkout
status: To Do
assignee: []
created_date: '2026-10-06'
labels:
  - security
dependencies: []
references:
  - backlog/completed/aisdlc-704 - fix the two critical DangerousWorkflow code-scanning alerts and triage the open backlog.md
priority: medium
parentTaskId: AISDLC-704
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from AISDLC-704 (code-scanning triage). `.github/workflows/verify-attestation.yml` and `.github/workflows/untrusted-pr-gate.yml` still check out the fork PR head into `pr-content/`. Apply the AISDLC-704 contents-API pattern (hex-validated sha, head repo bound through env, data only) to pre-empt the same DangerousWorkflow alert class, keeping the verifier behaviour identical.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] The change described above is implemented with tests.
- [ ] The listed code-scanning alerts read `fixed` after merge.
