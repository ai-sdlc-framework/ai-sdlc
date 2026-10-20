---
id: AISDLC-984
title: 'Push step fails closed when the head patch-id has no attestation envelope'
status: Done
assignee: []
created_date: '2026-10-20'
labels:
  - attestation
  - trust-chain
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/next-step/resume-decision.ts
  - pipeline-cli/src/attestation/patch-id.ts
  - docs/operations/attestation-troubleshooting.md
priority: high
dispatchable: true
---

## Description

Twice on 2026-10-17, on resumes of two tasks, `next-step` treated an already-pushed, rebased head as the end of the ship step and skipped `emit-leaf` and signing, leaving an unsigned head on the PR for dispatch to repair by hand. The ship step (`pipeline-cli/src/next-step/ship.ts`) rebases before signing (`:81-105`, returning `kind: 'skipped'` when `origin/<target>` is already an ancestor of HEAD), runs the consumer sign script at `:361-367` and pushes at `:380`; nothing after the push checks that the head it just reported has an envelope. The resume decision (`pipeline-cli/src/next-step/resume-decision.ts:5-12`) classifies a branch by the newest envelope's patch id, so a head whose patch id differs from every envelope on the branch is exactly the case that must never be reported as done.

Fix: before `ship` reports the push as done, compute the head's patch id with `computePatchId` (`pipeline-cli/src/attestation/patch-id.ts:119`, with `computeMergeBase` at `:200`) and require a v6 envelope named by `patchIdFilenameV6` (`:254`) under `.ai-sdlc/attestations/`; when it is absent, return the sign step (never `done`), with a reason that names the head sha and the patch id it looked for. The same check runs on the resume path so a rebased head that lost its envelope is routed to re-sign, not to the next step. A test builds a branch whose head has no envelope and asserts the ship step returns the sign step; a second test with a matching envelope asserts done. `docs/operations/attestation-troubleshooting.md` gets the new refusal message with its remedy.

**Five-step review (requirements first).**
1. Requirement questioned: is the pre-push hook enough? No; the hook signs on the executor's push, but a head pushed by an earlier session (a rebase, a resume) can already be on the remote with no envelope, and the next session must not call that done.
2. Delete: nothing to delete.
3. Simplify: one predicate (head patch id has an envelope) used by both ship and resume.
4. Accelerate: dispatch no longer repairs unsigned heads by hand; the executor re-signs in the same session.
5. Automate: the two tests pin the predicate.

## Acceptance Criteria

- [ ] `ship` computes the head patch id after the push and returns the sign step, never `done`, when no v6 envelope for that patch id exists under `.ai-sdlc/attestations/`.
- [ ] The resume path applies the same predicate and routes to re-sign.
- [ ] Tests cover the missing-envelope and matching-envelope cases.
- [ ] `docs/operations/attestation-troubleshooting.md` documents the refusal and the remedy.
