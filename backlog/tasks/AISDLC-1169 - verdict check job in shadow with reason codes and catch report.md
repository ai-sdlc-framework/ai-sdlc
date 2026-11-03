---
id: AISDLC-1169
title: 'RFC-0061 Phase 1: verdict check job in shadow mode, reason codes and the derived catch report'
status: In Progress
assignee: []
created_date: '2026-11-03'
labels:
  - rfc-0061
  - attestation
  - review-gate
  - ci
  - phase-1
dependencies:
  - AISDLC-1168
references:
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - .github/workflows/ai-sdlc-gate.yml
  - pipeline-cli/src/cli/attestation.ts
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

Implements the gate half of RFC-0061 (Proposal "The gate") and OQ-4b, in shadow.

**Scope.**
1. A pipeline-cli verdict check: fetch `refs/ai-sdlc/verdicts/<head>`; validate the schema; confirm `subject.headSha` is the PR head; confirm `coverage` with the shared rule from AISDLC-1168; enforce the required independence tier by reading the field (OQ-6, no recomputation). When no record exists for the head, call the carry-forward function (AISDLC-1170) once it lands; until then report `no-record`.
2. A new non-required job in `ai-sdlc-gate.yml` that runs the check and posts a status `ai-sdlc/review-verdict` (shadow name) with a reason code in the description: `no-record`, `subject-mismatch`, `coverage-short`, `replay-dirty`, `tier-short`, or `ok` / `ok-carried:<sha>`. It does not feed `ai-sdlc/pr-ready` yet.
3. **Shadow comparison:** the job also records whether the v6 attestation-gate result agreed; the disagreement goes into the job summary.
4. **Catch report (OQ-4b):** `cli-attestation catches [--since <date>]` compiles from GitHub status history every head where the verdict check failed while every other `ai-sdlc/pr-ready` input passed, with reason code, and every v6/verdict disagreement. No ledger file is written.

## Acceptance Criteria

- [ ] AC-1: The check passes for a head with a valid record and fails with the right reason code for each failure class. Unit tests per code.
- [ ] AC-2: The gate job posts the shadow status on every same-repo PR and is not part of `ai-sdlc/pr-ready`.
- [ ] AC-3: The job summary shows agreement or disagreement with the v6 result.
- [ ] AC-4: `cli-attestation catches` lists catches and disagreements from mocked status history; no file is written.
