---
id: AISDLC-1227
title: resumed developer round commits only; Step 11 stays the sole pusher
status: In Progress
priority: high
labels: [bug, pipeline-cli, plugin, rfc-0061]
dependencies: []
dispatchable: true
---

## Problem

On a resumed developer round (`--developer-round` through `cli/dispatch.ts`, `hierarchy/reenter.ts`, `dispatch/resume.ts`), the developer subagent rebases onto `origin/main` and lease-pushes the task branch itself, then opens nothing because the PR already exists. Observed twice on AISDLC-707 / PR #2508 (2026-11-07, last at 19:54Z: head 2ffa9597 pushed by the developer, round then failed in review, no verdict record for that head).

The first developer run is meant to push: it opens a DRAFT PR, CI does not fire on a draft (AISDLC-218), and Step 11 later pushes the signed head and the verdict ref `refs/ai-sdlc/verdicts/<head>` in one atomic push and marks the PR ready (RFC-0061 OQ-1, `next-step/ship.ts`). A resumed round breaks that order: the PR is already ready, so the developer's push fires a full CI run on a head that has no verdict record (the `Review verdict` check goes red, one CI cycle is spent before review), Step 10.5 rebases a second time, and when the review round fails the PR sits on an unverified head the reconciler reads as a real failure. RFC-0061 OQ-2 states that no rebasing path writes a verdict and Step 11 stays the only local writer; a resumed round that pushes is a rebasing path outside Step 11.

Why it happens: `ai-sdlc-plugin/agents/developer.md` (Definition of Done items 2 to 4, step 5 "rebase, push, pr", "Rebase, push and PR are YOUR job") orders the rebase and push on every run with no exception for a resumed round, and the resume block in `pipeline-cli/src/steps/05-build-dev-prompt.ts` (`resumeBlock`) only says "commit on top of the existing commits" without overriding it. No hook distinguishes a developer-round push from a first-run push: `verdict-ref-fence.js` only fences pushes that name the verdict refs, and `lease-push-guard.js` checks shape and branch ownership only.

## Fix

**Five-step review (requirements first).**
1. Question: the first-run push stands (it opens the draft PR and nothing else does). Step 11 as the sole pusher of a ready PR stands (RFC-0061). What does not stand is a second pusher on a ready PR.
2. Delete: the rebase, push and PR steps from the resumed round. The resume block states it in one place: the PR exists, do not rebase, do not push, do not open a PR; commit on top of the existing commits and return the existing PR URL in `prUrl`. `developer.md` Definition of Done and step 5 point at that exception in one sentence ("in a resumed round the orchestrator pushes").
3. Simplify: Step 6 (`06-parse-dev-return.ts`) accepts the existing PR URL (or `prUrl: null` with a populated `commitSha`) as a complete developer return in a resumed round, so the developer has no reason to push to satisfy the return contract.
4. Accelerate: the PreToolUse guard (`enforce-blocked-actions.js`, next to `verdict-ref-fence.js`) denies a push of the task branch from a developer session when the run's pipeline state marks a resumed round and the push carries no verdict refspec; the denial names the rule and this task id so the next occurrence is read from the transcript.
5. Automate last: tests below; the denial is the only new mechanism.

Out of scope, noted for the planner: the `hierarchy/reenter.ts` `rebase` route (`gh pr update-branch --rebase`, a server-side head move with no verdict) and the legacy `steps/11-push-and-pr.ts` branch-only push are separate pushers outside Step 11 and get their own task if the operator wants them closed.

## Acceptance Criteria

- [ ] #1 Test: `buildDevPrompt` with `resumeFeedback` renders a resume block that states no rebase, no push, no PR, and names the existing PR URL to return; without `resumeFeedback` the prompt is unchanged.
- [ ] #2 Test: Step 6 treats a resumed-round developer return with the existing `prUrl` (and one with `prUrl: null` plus `commitSha`) as complete, not as a skipped push.
- [ ] #3 Test: the PreToolUse guard denies a lease push of the task branch from a developer session whose pipeline state marks a resumed round, with a message naming AISDLC-1227; the same command in a first run, and Step 11's atomic push with the verdict refspec, are allowed.
- [ ] #4 `developer.md` Definition of Done and step 5 carry the resumed-round exception in one sentence each; the rule text is not restated elsewhere (prompt-rules stay the single source).
- [ ] #5 The RFC-0061 impact table or `docs/operations/workflow-detail.md` names the resumed round as commit-only in one sentence.

## Notes

Evidence: `gh pr view 2508 --json commits` shows 2ffa9597 at 19:54:45Z from the developer round; the resume note for that round already asked for a review round only. Live: #2508 waits on AISDLC-1229 for its reenter; this task is not on its path.
