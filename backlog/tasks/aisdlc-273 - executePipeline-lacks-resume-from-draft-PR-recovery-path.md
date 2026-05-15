---
id: AISDLC-273
title: executePipeline lacks resume-from-draft-PR recovery path
status: Done
assignee: []
created_date: '2026-05-13 14:48'
labels:
  - framework-gap
  - executePipeline
  - recovery
  - rfc-0010
dependencies: []
priority: high
references:
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/steps/03-setup-worktree.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/orchestrator/checkpoint.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/cli/resume-from-draft.ts
  - pipeline-cli/src/cli/rework-pr.ts
  - docs/operations/recovery-flows.md
---

## Bug

`ai-sdlc-pipeline execute --run` (the AISDLC-182 umbrella) cannot resume a task whose previous dispatch left a DRAFT PR open with attestation incomplete or with reviewer-flagged issues that need a fix. The mid-state "draft PR exists + branch has commits + needs new dev work or re-attestation" is the natural failure mode of the framework's intended workflow (per `docs/operations/aisdlc-218-draft-pr-flow.md`), but it is not a documented recovery point.

Surfaced during the 2026-05-13 dogfood session that dispatched 12 backlog tasks (AISDLC-261..271 + 269/272). 7 of 12 came back from reviewers with critical/major findings. Re-dispatching via the umbrella was the obvious next move per memory entry `feedback_must_run_full_pipeline.md` — but the umbrella refuses (Step 3 safety predicate "no open PR for the branch" fires regardless of whether the PR is draft or ready), so I had to patch each blocked PR manually + re-sign + force-push. The operator's correct call-out: *"the pipeline should run two rounds of reviews and fixes automatically"* — and it does, WITHIN a single session. But not across sessions when the PR has already opened.

## Existing recovery paths (for reference)

| Mechanism | Where | Scope |
|---|---|---|
| Step 9 iteration loop | `executePipeline()` → `iterateOnReviewFailure()` | Reviewers find issues → re-prompt dev with feedback. Max N iterations within ONE session. ✅ Works. |
| Recoverable-abort detection (AISDLC-242) | `runOrchestratorTick` → `detectRecoverableWorktree()` | Crash mid-flight → next tick sees worktree + sentinel + commits + NO PR → resumes. ✅ Works in autonomous orchestrator only. |
| Auto-cleanup of stale worktrees (AISDLC-224) | `setupWorktree()` (Step 3) | `AI_SDLC_ORCHESTRATOR_AUTO_CLEANUP=1` + safety predicates pass (no open PR + no uncommitted changes + no live process) → wipes + re-creates worktree. ⚠️ Refuses when ANY PR (incl. draft) exists. |

## What's missing

The natural mid-state of the framework's intended workflow (`docs/operations/aisdlc-218-draft-pr-flow.md`):

```
Step 5: dev work
Step 7-9: reviewers + iterate (within session)
Step 10: sign attestation (chore commit)
Step 11: push + open DRAFT PR  ← branch + draft PR now exist
Step 13: gh pr ready → flip draft to ready → CI fires → auto-merge
```

If the dispatch crashes between Step 11 (draft PR opened) and Step 13 (ready promotion), the framework cannot resume. Re-running `ai-sdlc-pipeline execute --run AISDLC-NNN` hits Step 3's open-PR predicate, which uses `gh pr list --head $branch --state open` — this includes BOTH draft AND ready PRs. The `--state draft` GitHub state could differentiate, but the safety predicate doesn't.

Worse: the gap also shows up when reviewers find issues AFTER the dispatch's session ends — operator runs reviewers post-hoc (e.g. via the Skill tool), files findings as PR comments, and would naturally want to re-dispatch the dev to fix those findings. No path exists. This was tonight's session: 7 PRs commented with findings, no way to re-dispatch.

## Acceptance criteria

- [x] **Step 3 safety predicate differentiates draft vs ready**: when the only open PR for the branch is DRAFT and has fewer than N commits ahead of origin/main matching `wip(checkpoint):` or `chore: auto-sign attestation` patterns (resumable mid-states), allow auto-cleanup OR a different recovery path. When the PR is ready OR has substantive non-checkpoint commits, refuse as today.
- [x] **`ai-sdlc-pipeline execute --resume-from-draft <task-id>`**: explicit operator opt-in path. Detects existing draft PR + branch + worktree, picks up at the FIRST step that hasn't completed (typically Step 7 reviewers, Step 10 attestation, or Step 13 ready-promotion), re-runs from there. Does NOT re-dispatch the dev unless explicitly flagged.
- [x] **`ai-sdlc-pipeline execute --rework-pr <pr-number>`**: distinct path for "PR exists, reviewers found bugs, dev needs to fix". Reads PR comments matching the `<!-- ai-sdlc:reviewer-findings -->` marker, posts them as additional context to the dev, runs Steps 5-13 fresh on top of the existing branch, force-pushes the rebased + re-attested HEAD. Bounded by the same Step 9 iteration cap (max N rework rounds before escalation).
- [x] **AISDLC-242 recoverable-abort surface extended to `executePipeline()`** (not just `runOrchestratorTick`). The umbrella one-shot path should also detect + offer to resume on next invocation.
- [x] **Documentation**: `docs/operations/recovery-flows.md` covers all the recovery paths (Step 9 iteration, crash recovery, draft-PR resume, PR rework) with operator-facing decision tree.
- [x] **Test coverage**: integration tests exercise each recovery path end-to-end (crash before Step 11, crash after Step 11 before Step 13, PR-with-findings rework).

## Out of scope

- Changes to the SUBSCRIPTION-billing path (`/ai-sdlc execute` slash command body). Same gap exists there but the operator-driven re-typing of the slash command is a workaround that doesn't apply to the bin-script umbrella.
- The `cli-orchestrator start` autonomous loop already has `runOrchestratorTick`-level resume; this task is about making the same recovery primitives available to the one-shot `executePipeline()` umbrella.

## Source

Hit during the 2026-05-13 dogfood session that fixed AISDLC-261..271 + 269/272. 7 of 12 PRs came back from reviewers with critical/major findings; manual patch+re-sign was the only path. Operator quote: *"We should be able to recover a failed execute or a partial execute functionality if you run the execute again it should detect which steps are completed and pick up from where it left off. do we not have that built in?"* — followed by *"the pipeline should run two rounds of reviews and fixes automatically"* + *"I thought that the developer was instructed to open the PR in draft mode. then once the reviewers complete the review and attestation then the PR is updated to be open. That would contradict the workflow assumtions that it would fail mid workflow"*.

The draft-PR observation is correct (Step 11 opens draft, Step 13 marks ready) but the safety predicate in Step 3 doesn't differentiate, so even the framework's intended draft-PR-as-mid-state pattern doesn't enable resume today.
