---
id: AISDLC-1169
title: 'RFC-0061 Phase 1: verdict check job in shadow mode, reason codes and the derived catch report'
status: Done
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

- [x] AC-1: The check passes for a head with a valid record and fails with the right reason code for each failure class. Unit tests per code.
- [x] AC-2: The gate job posts the shadow status on every same-repo PR and is not part of `ai-sdlc/pr-ready`.
- [x] AC-3: The job summary shows agreement or disagreement with the v6 result.
- [x] AC-4: `cli-attestation catches` lists catches and disagreements from mocked status history; no file is written.

## Final Summary

## Summary
Fixed the two failing test groups by registering the new review-verdict-shadow job. I added it to .ai-sdlc/gates.yaml as a gate-job entry with decision DEC-0287. I also added it to the canonical job list in the workflow-structure test. The earlier shadow verdict check work is unchanged.

## Changes
- .ai-sdlc/gates.yaml
- .github/workflows/__tests__/ai-sdlc-gate.test.mjs
- backlog/tasks/AISDLC-1169 - verdict check job in shadow with reason codes and catch report.md

## Design decisions
Full pnpm build, test, lint and format:check ran to completion before the commit: 3798 tests passed, 0 failed. I rebased onto origin/main and pushed with --force-with-lease, but did not re-run the suite after the rebase. The PR (#2337) was already open and shows isDraft false, so I did not create a new one. The registry test requires a decision id on new entries and no decision exists for RFC-0061, so I used DEC-0287, which the RFC cites in its motivation. A maintainer may want to swap in a more fitting decision id. The task file status change to In Progress is included in the commit.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

