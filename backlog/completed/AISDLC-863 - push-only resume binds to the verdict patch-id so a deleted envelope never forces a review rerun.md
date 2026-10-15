---
id: AISDLC-863
title: >-
  push-only resume binds to the verdict patch-id so a deleted envelope never forces a review rerun
status: Done
assignee: []
created_date: '2026-10-14'
labels:
  - pipeline
  - reliability
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/dispatch/resume.ts
  - pipeline-cli/src/cli/dispatch.ts
  - pipeline-cli/src/next-step/review-finalize.ts
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/executor.md
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`/ai-sdlc execute` always starts `next-step` with `--fresh`, so a resumed task keeps its approved reviews only through the push-only mode (`cli-dispatch push-only-check`). That mode proves "the branch content is what the reviewers approved" with `approvalEnvelopeMatches(worktree)`: an attestation envelope for the current patch-id must exist in the worktree. The envelope is a file the resume path itself removes: before a rebase re-sign the executor (or the squash hook) drops the stale envelope, and once it is gone `push-only-check` exits 1 with "the branch content no longer matches the approved verdict after the rebase", the normal resume restarts at developer iteration 1, and three reviewers run again on content that was already approved. AISDLC-862 (#1503) hit this twice on 2026-10-14; AISDLC-799 (#1389) carries the same shape. Each recurrence costs a full sonnet review round plus a dispatch/planner escalation loop.

**Five-step review (requirements first).** Requirement questioned: "push-only is proven by an envelope file in the worktree". The real requirement is that the content being pushed equals the content the reviewers approved; the envelope is one carrier of that fact and the only one that a rebase re-sign deletes. Delete: the dependency of `evaluatePushOnly` on `approvalEnvelopeMatches` as the sole proof. Simplify: `review-finalize` records the approved `patchId` (and `headSha`) in the worktree verdict `.ai-sdlc/verdicts/<task>.json` at approval time; `push-only-check` passes when the verdict is an approval and its `patchId` equals the current patch-id of the worktree, whether or not the envelope file is present (the re-sign at Step 10 recreates it from the transcript leaves). Accelerate: a resume with unchanged content goes straight to sign, format, lease push and ready, no developer or reviewer spawn. Automate: `push-only-check` prints which proof matched (`verdict-patch-id` or `envelope`) so dispatch notes stop guessing.

## Fix

1. `pipeline-cli/src/next-step/review-finalize.ts`: when the verdict is `APPROVED`, write `patchId` (from `pipeline-cli/src/attestation/patch-id.ts`) and `headSha` into the worktree verdict file.
2. `pipeline-cli/src/dispatch/resume.ts` `evaluatePushOnly`: accept `{ mode: 'push-only', proof: 'verdict-patch-id' }` when `verdict.approved === true` and `verdict.patchId === currentPatchId`; keep the envelope path as the second proof (`proof: 'envelope'`); refuse with the existing reasons otherwise. A verdict without `patchId` (written before this change) keeps today's envelope-only behaviour.
3. `pipeline-cli/src/cli/dispatch.ts` `push-only-check`: compute the current patch-id once, pass it to `evaluatePushOnly`, print the proof.
4. `ai-sdlc-plugin/commands/executor.md` push-only section: the executor never deletes an attestation envelope by hand before a resume; the re-sign step replaces it.

## Acceptance Criteria

- [ ] #1 `resume.test.ts`: an approved verdict whose `patchId` equals the worktree patch-id yields `push-only` with no envelope file present; a differing `patchId` yields `normal` with the existing reason.
- [ ] #2 `resume.test.ts`: a verdict without `patchId` behaves exactly as today (envelope present → push-only, absent → normal).
- [ ] #3 `review-finalize` test: an approved verdict file carries `patchId` and `headSha`; a non-approved verdict carries neither.
- [ ] #4 `push-only-check` output includes `proof`; the executor command doc names the no-hand-deletion rule.
- [ ] #5 A rebase that changes the patch-id (conflict resolution touched reviewed lines) still refuses push-only (the binding is the patch-id, not the branch name).

**Velocity impact.** Positive: removes a full review round and one escalation loop from every resume whose content is unchanged.

Authority: class (a) under `docs/operations/decision-authority.md` (reversible; the content binding is kept, only moved from a deletable file to the verdict; no control loosened).
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

Closed by AISDLC-882: `cli-dispatch reenter` carries the head SHA and the failing line on the manifest and a push-only round binds to the PR's current head; there is no separate resume path any more.
