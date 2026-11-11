---
id: AISDLC-1259
title: 'Review and land fork PR #2623 (split oversized reviewer prompts so the nonce marker stays readable; issue #2622)'
status: To Do
assignee: []
created_date: '2026-11-11'
labels:
  - pipeline-cli
  - review
  - external-contribution
  - operator
dependencies: []
references:
  - pipeline-cli/src/next-step/review-prepare.ts
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/next-step/types.ts
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/scripts/persist-reviewer-artifacts.sh
priority: high
dispatchable: false
dispatchableReason: 'Human-only: PR #2623 heads a fork (thanhduyspkt/ai-sdlc), so fixesPr takeover is refused and cli-merge-if-eligible refuses untrusted PRs; the merge is an operator action after the reviewer set has run.'
blocked:
  reason: >-
    Tracking task for an external contribution. Review runs with /ai-sdlc review-pr 2623; the
    merge of a fork PR is a class (c) operator action (trust evaluation refuses it). Close this
    task when #2623 is MERGED or when the operator decides on a different path.
---

## Description

**Report.** Issue #2622 (adopter, plugin 0.42.0): `/ai-sdlc execute` aborts at Step 7b.5 with `persist-reviewer-artifacts.sh: harness transcript ... does not contain the nonce marker; refusing to persist` after the reviewers approved. `review-prepare.ts` writes each reviewer prompt as one file (instructions, full `git diff --text --no-textconv`, nonce marker on the last line). When a lock file is in the diff the prompt exceeds the Read tool token cap, the reviewer stops paging and never echoes the marker, and the integrity check refuses the transcript. The diagnosis was verified against `review-prepare.ts` (single `writeRunFile`, marker appended last, bootstrap prompt says "Read with the Read tool").

**Contribution.** PR #2623 by the reporter splits a prompt that does not fit one Read call (40,000 bytes / 1,500 lines) into `review-r<N>-<agent>.part-<i>-of-<n>.md` parts, each ending with the path of the next, keeps the marker in the last part, adds an optional `promptParts` to `SpawnedReviewer` and the `spawn-reviewers` instruction, and an `AI_SDLC_REVIEW_PROMPT_PART_BYTES` override. 7 files, +294/-9, with tests. Trust classification, AST gate and governance boundary passed; sandbox reviewer matrix and clean-room attestation were skipped (untrusted author).

**Why a task.** A fork head is refused by `fixesPr` (Step 2 and `cli-file`), and `cli-merge-if-eligible` refuses untrusted PRs, so this contribution cannot go through the executor path. This task holds the ledger entry so the dispatched-work landing check sees it.

## Fix

**Five-step review.**
1. Requirement questioned: the nonce marker must prove the reviewer read the whole diff. Stands; the PR keeps the marker last and the transcript check unchanged.
2. Deleted: nothing.
3. Simplified: no new mechanism; the prompt becomes a chain of files the reviewer reads in order.
4. Accelerated: no change to review cost; large prompts now complete instead of aborting after every review has already run.
5. Automated: review runs through `/ai-sdlc review-pr 2623`; the merge stays an operator action.

## Steps

1. Run `/ai-sdlc review-pr 2623` (testing, critic, security) and post the verdicts on the PR.
2. If findings need code, ask the contributor on the PR (maintainer-can-modify is on, but pushes to a fork head are outside the executor's sanctioned paths).
3. Operator merges when `ai-sdlc/pr-ready` is green and the review verdicts approve; then close this task with the merge sha in `finalSummary`.

## Acceptance Criteria

- [ ] AC-1: the three review verdicts for #2623 are posted on the PR.
- [ ] AC-2: issue #2622 acceptance criteria #1 to #7 hold on the PR head (verified by the review or by a maintainer run against a diff that contains a lock file).
- [ ] AC-3: #2623 is MERGED and its merge sha is recorded here; or the operator records a different decision and this task is closed with the reason.
- [ ] AC-4: the follow-up tasks AISDLC-1260 to AISDLC-1263 (the four related observations from #2622) remain filed and are not folded into #2623.
