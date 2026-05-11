---
id: AISDLC-258
title: contentHashV4 still flaky in merge queue — operator hits rebase+re-sign loop on every multi-PR queue
status: Done
assignee: []
created_date: '2026-05-10 16:35'
labels:
  - bug
  - attestation
  - merge-queue
  - rfc-0010
dependencies: []
priority: high
references:
  - scripts/verify-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - .github/workflows/verify-attestation.yml
  - docs/operations/merge-queue-rebase-recovery.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

contentHashV4 was designed to be "base-independent — survives merge-queue rebases when the PR's files don't overlap with sibling PRs" (CLAUDE.md, AISDLC-193.1, AISDLC-237). In practice operator hits attestation failures on every multi-PR merge queue cycle:

> "first one merges then the second fails attestation cause it rebases onto the second and can't merge" — operator 2026-05-10

Witnessed on PR #434 (AISDLC-178.7) when it queued alongside #436 (AISDLC-255). Recovery required:

1. `git fetch origin main && git rebase origin/main` (manual)
2. Re-sign attestation
3. Force-push
4. Re-arm `gh pr merge --auto`

This is the SAME loop AISDLC-237 was supposed to eliminate. AISDLC-237 added the v3→v4 path-keyed hash that should be base-independent. So either:

- **(a)** v4 is computing the wrong hash (file collector includes too many files, or hashes the wrong blobs)
- **(b)** v4 is correct but the verifier reads the wrong commit's tree
- **(c)** The PR's files genuinely DO overlap with sibling PRs (e.g., `pnpm-lock.yaml`, `CHANGELOG.md`, generated schemas) and v4 is correctly rejecting — meaning the "shared churn files" need an exclude list

## Investigation needed

Likely candidate (c): files like `pnpm-lock.yaml`, `reference/src/core/generated-schemas.ts`, `pipeline-cli/package.json` change in MOST PRs because they're shared scaffolding. When two PRs both edit `pnpm-lock.yaml` (or `package.json`), the rebase produces a NEW pnpm-lock.yaml content, the head blob SHA changes, and v4 correctly rejects.

But operator considers this a UX failure — they want the queue to "just work" without manual recovery on every cycle.

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Reproduce: open 2 PRs that both modify `pnpm-lock.yaml` (or `package.json`), enter both in merge queue, observe v4 rejection on the second
- [ ] #2 Diagnose which file's blob SHA changed during the rebase (instrument verify-attestation to log the per-file expected vs actual hash on mismatch)
- [ ] #3 Decision: pick one of:
  - **(A)** Add a "shared churn files" exclude list to v4's file collector (`pnpm-lock.yaml`, generated schemas, CHANGELOG, etc.) — accepts the risk that an attacker could slip changes through these files unattested
  - **(B)** Auto-rebase + re-sign in the verify-attestation.yml workflow itself when v4 fails (CI does what operator currently does manually) — keeps full attestation coverage but moves the work into CI
  - **(C)** Block multi-PR merge queue entirely (only one PR in queue at a time) — simplest fix but defeats the point of a queue
- [ ] #4 Implement chosen path
- [ ] #5 Update `docs/operations/merge-queue-rebase-recovery.md` to reflect the new behavior (or delete it if option B/C eliminates the recovery flow entirely)
- [ ] #6 Test: open 3 sibling PRs, queue all three, all merge without operator intervention
<!-- SECTION:ACCEPTANCE:END -->

## Composes with

- **AISDLC-237** — original contentHashV4 fix; this is a regression report
- **AISDLC-193** — attestation gate

## Severity

**HIGH** — every multi-PR queue cycle requires operator intervention. Blocks autonomous orchestrator from achieving its "operator wakes up to merged PRs" UX goal.
<!-- SECTION:DESCRIPTION:END -->
