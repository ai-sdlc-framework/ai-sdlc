---
id: AISDLC-734
title: >-
  Reviewer leaf emission and signing are fragile: one-shot emit, patch-id drift, sentinel-only signer, slow local verify
status: To Do
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
- [ ] Items 1 and 3 reproduced first, with the real behaviour stated in the PR.
- [ ] Re-emitting a leaf for the same real reviewer run is idempotent and keeps its class.
- [ ] A leaf for a different head still cannot be produced from an old run (no relabeling); test.
- [ ] Committing review ledger files between emit and sign does not orphan a leaf, or the tooling refuses with the exact fix.
- [ ] The signer either honours `AI_SDLC_ACTIVE_TASK_ID` or says clearly why it skipped and what to run.
- [ ] Local verify finishes in bounded time on this repository and prints the required reviewer set.
- [ ] Executor docs (`ai-sdlc-plugin/commands/execute.md`) carry the emit-once guidance until fixed.

## Velocity impact
Prevents a leaf from being relabeled from an old run, which is the harm the class rule exists for; that protection is kept. The happy path (one emit per reviewer, then sign) gets zero new prompts and fewer silent skips. When the tooling refuses, it prints the exact fix command; the agent runs it and continues, with no skip variable.
<!-- SECTION:DESCRIPTION:END -->
