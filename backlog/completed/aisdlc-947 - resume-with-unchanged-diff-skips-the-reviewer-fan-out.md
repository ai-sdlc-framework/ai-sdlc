---
id: AISDLC-947
title: 'Resume with an unchanged or chore-only diff skips the reviewer fan-out and re-signs instead of re-running developer plus three reviewers'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - pipeline
  - review
  - cost
dependencies: []
references:
  - pipeline-cli/src/steps/07-build-review-prompts.ts
  - pipeline-cli/src/steps/reviewer-set.ts
  - pipeline-cli/src/steps/09-iterate.ts
  - pipeline-cli/src/attestation/patch-id.ts
  - docs/operations/attestation-reference.md
priority: critical
dispatchable: true
---

## Description

A 48-hour usage audit (2026-10-14 19:00Z to 2026-10-16 19:00Z, 618 sessions) measured 44 of 60 board verdicts as resumes, 25 of them resuming a verdict that was already `success` (reasons: a required check failed, a stale attestation, a rebase, a push-only refusal). Every such resume spawns the developer and the full reviewer set again on a diff that did not change, and the security reviewer runs on Opus every time: 198 developer runs for 68 tasks (about three pipelines per task), the security reviewer at 19 percent of all spend and 35 percent of executor spend, and three tasks alone cost 49 executor sessions. The attestation already records the patch id of the reviewed tree, so the pipeline can tell an unchanged diff from a real change.

**Five-step review (requirements first).**
1. Requirement questioned: does a resume need a review at all? Only when the code the reviewers attested to has changed. A rebase, a re-sign, a task-file move or a rerun of a red check leaves the reviewed patch id unchanged and needs no new review.
2. Delete: the unconditional developer plus reviewer fan-out on every resume; a resume whose patch id (per `PATCH_ID_EXCLUSIONS`) equals the last attested patch id runs no agent at all and goes straight to reconcile and re-sign.
3. Simplify: one decision at the top of the resume path, "patch id unchanged, chore-only, or changed", read from the existing attestation envelope; no new state file.
4. Accelerate: when the patch id changed, the reviewer set is selected by `selectReviewerSet` on the diff between the last attested head and the new head, not the whole PR, so a chore-only or docs-only delta gets the correctness reviewer alone (AISDLC-723 rule) and the security reviewer runs only when the delta touches a trust-chain path.
5. Automate: a unit test per branch of the decision (unchanged, chore-only delta, trust-chain delta) and a verdict note that names which branch ran, so the spend report can count skipped rounds.

Velocity impact: positive; a resume after a green verdict finishes in the reconcile step without waiting on four subagents.

## Acceptance Criteria

- [ ] AC-1: On a resume, the pipeline computes the patch id of the current tree and compares it to the patch id in the newest attestation envelope for the task; when equal, no developer and no reviewer subagent is spawned and the pipeline proceeds to reconcile and re-sign.
- [ ] AC-2: When the patch id differs, the reviewer set is selected from the diff between the last attested head and the current head; a delta with no trust-chain path does not include the security reviewer unless the repository sets `reviewerSet: three`.
- [ ] AC-3: A resume with no prior attestation runs the full pipeline as today.
- [ ] AC-4: The verdict notes record which branch ran (`review-skipped: unchanged`, `review-delta: <reviewers>`, `review-full`).
- [ ] AC-5: Tests cover the three branches and the no-attestation fallback; `docs/operations/attestation-reference.md` describes the resume decision.

## Notes

Origin: planner usage audit 2026-10-16. Complements AISDLC-725 (incremental review after a rejection); this task covers the resume after a success or a push-only refusal.
