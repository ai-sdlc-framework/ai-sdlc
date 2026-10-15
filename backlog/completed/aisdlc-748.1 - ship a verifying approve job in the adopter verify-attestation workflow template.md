---
id: AISDLC-748.1
title: >-
  ship a verifying approve job in the adopter verify-attestation workflow template
status: Done
assignee: []
created_date: '2026-10-09'
labels:
  - governance
  - orchestrator
dependencies:
  - AISDLC-748
references:
  - orchestrator/src/cli/commands/init-templates.ts
  - .github/workflows/ai-sdlc-gate.yml
  - scripts/post-attestation-review.mjs
priority: high
parentTaskId: AISDLC-748
updated_date: '2026-10-10 22:09'
---

## Description

AISDLC-748 makes init require 1 approving review (DEC-0014), but the adopter `VERIFY_ATTESTATION_WORKFLOW` template is audit-only and has no `approve` job, so in an adopter repo nothing posts the approval; a non-admin merge waits on a human review or an admin bypass. This repo's own workflow has the job (AISDLC-747) but it depends on `scripts/post-attestation-review.mjs`, which adopters do not have.

Ship a job in the adopter template that verifies the v6 envelope (using the consumer-runnable verifier) and posts the approving review, so `templatePostsApproval` turns true and init output changes accordingly. Never approve without verification.

## Acceptance Criteria

- [x] Adopter template contains an `approve` job gated on successful envelope verification.
- [x] `ADOPTER_TEMPLATE_POSTS_APPROVAL` is true and tests cover the flipped messaging.
- [x] `docs/operations/quality-gate.md` limitation note is removed.

## Final Summary

## Summary
The adopter `VERIFY_ATTESTATION_WORKFLOW` template now ships a verifying `approve` job, so `ADOPTER_TEMPLATE_POSTS_APPROVAL` is true and init's DEC-0014 required-review protection no longer locks adopters out of non-admin merges.

## Changes
- `orchestrator/src/cli/commands/init-templates.ts` (modified): template moves to `pull_request_target` + `merge_group`; `verify` job checks out only the base SHA (no persisted credentials), fetches the head objects with the workflow token via a per-invocation extraheader, copies only the envelope and transcript leaves as data, installs the pinned verifier from npm with `--ignore-scripts`, and exposes `status`/`reason` outputs; new `approve` job holds the only `pull-requests: write`, runs no repo code, and posts an APPROVE review only for a fully `valid` result on non-draft same-repo PRs (rejects soft-fail/spot-check, dismisses stale approvals, idempotent per head SHA, names the repo setting on a 403).
- `orchestrator/src/cli/commands/init-features.test.ts` (modified): asserts the flag flip and template structure (trigger, permissions, approve gating, authenticated fetch, guards) including a YAML parse of the rendered template.
- `docs/operations/quality-gate.md` (modified): removed the limitation note.

## Design decisions
- **Verifier from npm, pinned (0.31.0)**: adopters have no `scripts/post-attestation-review.mjs` and no plugin install; the published `cli-attestation verify` needs neither. Tradeoff: the pin must be bumped by the release procedure.
- **pull_request_target**: needed so the approve job can hold a write token; safe because nothing from the PR head is executed.

## Verification
- `pnpm build` — clean
- orchestrator `src/cli` tests — 564 passed, 1 skipped
- `pnpm lint` — clean
- prettier on touched files — clean
- 3 reviewers approved on round 2 (Claude-native; Codex usage limit reached)

## Follow-up
- declined: lockfile-pinned verifier install (minor supply-chain hardening; dependencies below the two pinned packages float)
- declined: re-read PR head SHA right before posting the review (narrow stale-approval race; branch protection dismisses stale reviews)
- declined: symlink check on copied head files (minor; verifier only reads them and the trust root is the base checkout)
- declined: docs-only PRs get no approving review because of `paths-ignore` (matches this repo's own workflow)
