---
id: AISDLC-748.1
title: >-
  ship a verifying approve job in the adopter verify-attestation workflow template
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - governance
  - orchestrator
dependencies:
  - AISDLC-748
references:
  - orchestrator/src/cli/commands/init-templates.ts
  - .github/workflows/verify-attestation.yml
  - scripts/post-attestation-review.mjs
priority: high
parentTaskId: AISDLC-748
---

## Description

AISDLC-748 makes init require 1 approving review (DEC-0014), but the adopter `VERIFY_ATTESTATION_WORKFLOW` template is audit-only and has no `approve` job, so in an adopter repo nothing posts the approval; a non-admin merge waits on a human review or an admin bypass. This repo's own workflow has the job (AISDLC-747) but it depends on `scripts/post-attestation-review.mjs`, which adopters do not have.

Ship a job in the adopter template that verifies the v6 envelope (using the consumer-runnable verifier) and posts the approving review, so `templatePostsApproval` turns true and init output changes accordingly. Never approve without verification.

## Acceptance Criteria

- [ ] Adopter template contains an `approve` job gated on successful envelope verification.
- [ ] `ADOPTER_TEMPLATE_POSTS_APPROVAL` is true and tests cover the flipped messaging.
- [ ] `docs/operations/quality-gate.md` limitation note is removed.
