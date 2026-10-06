---
id: AISDLC-734
title: >-
  Reviewer leaf emission and signing are fragile: one-shot emit, patch-id drift, sentinel-only signer, slow local verify
status: Done
assignee: []
created_date: '2026-10-05'
labels:
  - attestation
  - friction
dependencies: []
references:
  - pipeline-cli/src/attestation/verdict-class.ts
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation-if-consumer.sh
  - ai-sdlc-plugin/commands/execute.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tier 1 friction. Observations from 2026-10-05:

1. To confirm first: a second `emit-leaf` for the same reviewer agent drops to self-authored with a null transcript hash even inside the 30-minute window (`MARKER_MAX_AGE_MS` in `pipeline-cli/src/attestation/verdict-class.ts`). The suspected cause is that `determineVerdictClass` consumes the SubagentStart marker on the first emit. This led an executor to reuse old leaves on PR #1211, which had to be redone.
2. The leaf file is named by patch-id, and the patch-id changes if anything else (for example `.ai-sdlc/reviews/`) is committed between emit and sign.
3. The pre-push signing hook (`ai-sdlc-plugin/scripts/sign-attestation-if-consumer.sh`) reads only the `.active-task` sentinel and ignores `AI_SDLC_ACTIVE_TASK_ID`, so in a worktree without the sentinel it skips signing silently (seen on AISDLC-703, PR #1215). An executor on AISDLC-690 reported the opposite, so to confirm first: establish the real behaviour.
4. The local verify run hung scanning old envelopes and does not print the reviewer set it requires for the diff.

This task removes friction.

## Acceptance Criteria
- [x] Items 1 and 3 reproduced first, with the real behaviour stated in the PR.
- [x] Re-emitting a leaf for the same real reviewer run is idempotent and keeps its class.
- [x] A leaf for a different head still cannot be produced from an old run (no relabeling); test.
- [x] Committing review ledger files between emit and sign does not orphan a leaf, or the tooling refuses with the exact fix.
- [x] The signer either honours `AI_SDLC_ACTIVE_TASK_ID` or says clearly why it skipped and what to run.
- [x] Local verify finishes in bounded time on this repository and prints the required reviewer set.
- [x] Executor docs (`ai-sdlc-plugin/commands/execute.md`) carry the emit-once guidance until fixed.

## Velocity impact
Prevents a leaf from being relabeled from an old run, which is the harm the class rule exists for; that protection is kept. The happy path (one emit per reviewer, then sign) gets zero new prompts and fewer silent skips. When the tooling refuses, it prints the exact fix command; the agent runs it and continues, with no skip variable.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Reproduced items 1 and 3 first, then fixed them. Real behaviour: (1) CONFIRMED. `determineVerdictClass` and `bindLeafToReviewerRun` deleted the SubagentStart marker on the first `emit-leaf`, so a second emit for the same agent (a changed transcript, or a patch-id change that defeats the per-patch-id idempotency check) found no marker and fell to `self-authored` with a null `harnessTranscriptHash`, inside the 30 minute window. (3) PARTLY CONFIRMED. Both signing hooks (`scripts/check-attestation-sign.sh` and `ai-sdlc-plugin/scripts/sign-attestation-if-consumer.sh`) read only the `.active-task` sentinel and ignored `AI_SDLC_ACTIVE_TASK_ID`; in a worktree without the sentinel they exited 0. It was not fully silent (they printed a skip line) but the line gave no next step, which explains both executor reports. Item 2: `.ai-sdlc/reviews/` is already excluded from the patch-id (AISDLC-616), so committing ledger files between emit and sign does not move it; a commit to any non-excluded path does, and the signer then failed with a generic "no leaves" message. Item 4: local verify took 1m52s on this repository (689 envelope files, two git probes per v6 envelope, one `resolveSubjectShaForEnvelope` per legacy envelope) and printed no reviewer set.

## Changes
- `pipeline-cli/src/attestation/verdict-class.ts` (modified): a consumed marker is kept and bound to `{headSha, reviewer}` (`consumedFor`); same head and reviewer re-matches (idempotent, class kept), any other head or reviewer cannot (no relabeling); without a head the old delete-on-use applies.
- `pipeline-cli/src/attestation/harness-transcript.ts`, `pipeline-cli/src/cli/attestation.ts` (modified): thread `headSha` through so both selection paths use the claim.
- `pipeline-cli/src/attestation/sign-v6.ts` (modified): when no leaves exist at the current patch-id but the task has leaves under another one, refuse naming both patch-ids, the reviewers seen, and the exact `emit-leaf` fix.
- `scripts/check-attestation-sign.sh`, `ai-sdlc-plugin/scripts/sign-attestation-if-consumer.sh` (modified): honour `AI_SDLC_ACTIVE_TASK_ID` when the sentinel gives no task (sentinel wins); the skip message names the fix.
- `pipeline-cli/attestation-core/verify-core.mjs` (modified): v6 candidates are walked newest first and the walk stops at the first match (same envelope the old filter-then-sort chose); both the v6 and legacy walks share a 60s budget (`AI_SDLC_VERIFIER_SCAN_BUDGET_MS`) and fail closed with a reason; prints the required reviewer set to stderr.
- `ai-sdlc-plugin/commands/execute.md` (modified): emit-once guidance.
- Tests: `verdict-class-reemit.test.ts` (new), additions to `sign-v6.test.ts`, `attestation.test.ts`, `check-attestation-sign.test.mjs`, `sign-attestation-if-consumer.test.mjs`, `verify-attestation.test.mjs`.

## Design decisions
- **Bind the marker instead of deleting it**: keeps the relabeling protection (a different head, role or task never matches; the head must be a full 40-hex SHA) while making same-run re-emit idempotent; no skip variable. A bound marker is re-matchable only while its `firedAt` is within the age window of wall-clock time, and, when a harness transcript backed the leaf, only for that same transcript hash.
- **Refuse, do not adopt, leaves under a different patch-id**: leaves are bound to the diff they reviewed; the error prints the fix command.
- **Budget on the verifier scan**: the exact patch-id-named envelope is found by filename before any timed walk (planted far-future `signedAt` envelopes cannot push it out); the walk is bounded by both wall-clock and a candidate-count cap, failing closed with a reason that names the env vars.

## Verification
- `pnpm build`, `pnpm lint`, `pnpm format:check` clean; targeted vitest and node:test suites pass (see PR notes).

## Follow-up
- `scripts/verify-attestation.mjs` is a blocked path for the executor; no change was needed there (the logic lives in `verify-core.mjs`). declined: nothing further.
<!-- SECTION:FINAL_SUMMARY:END -->
