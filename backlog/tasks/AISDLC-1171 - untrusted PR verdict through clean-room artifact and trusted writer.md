---
id: AISDLC-1171
title: 'RFC-0061 Phase 1: untrusted PRs get a verdict record through a clean-room artifact and a trusted workflow_run writer'
status: In Progress
assignee: []
created_date: '2026-11-03'
labels:
  - rfc-0061
  - attestation
  - review-gate
  - ci
  - security
  - rfc-0043
  - phase-1
dependencies:
  - AISDLC-1168
  - AISDLC-1169
references:
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/attestation-post.yml
  - pipeline-cli/src/pipeline/clean-room-signer.ts
priority: high
dispatchable: true
---

## Description

Implements RFC-0061 OQ-7.

**Scope.**
1. The `clean-room-sign` job in `untrusted-pr-gate.yml` also emits the verdict record as an Actions artifact, with `issuedBy.principal: ci-clean-room` and tier `isolated`. It gains no new permission.
2. A trusted `workflow_run` workflow, repurposing the slot of `attestation-post.yml`, never checks out or reads PR content. It downloads the artifact, validates the schema, checks that `subject.headSha` is the PR head and that the review jobs concluded successfully, then pushes `refs/ai-sdlc/verdicts/<headSha>`. Only this job holds `contents: write`.
3. The OQ-8 fence (AISDLC-1168) names this workflow as the second sanctioned writer.
4. v6 signing in the clean-room job stays until cutover (AISDLC-1172); the signing secret is deleted in AISDLC-1173.

**Security note.** Never give `contents: write` to a job that runs AI reviewers over PR content; a prompt-injected reviewer could push to any unprotected branch.

## Acceptance Criteria

- [ ] AC-1: The clean-room job uploads a schema-valid record artifact and its permissions are unchanged. Workflow test or actionlint plus a fixture.
- [ ] AC-2: The writer workflow rejects an artifact whose head does not match the PR head, and one whose review jobs did not succeed.
- [ ] AC-3: The writer workflow has no checkout of the PR ref. A static test greps the workflow.
- [ ] AC-4: The verdict check from AISDLC-1169 passes for an untrusted PR head with the written record.
