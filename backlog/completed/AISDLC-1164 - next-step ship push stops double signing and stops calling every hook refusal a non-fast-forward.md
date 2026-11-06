---
id: AISDLC-1164
title: >-
  next-step ship: the push after Step 10.6 signing must not be re-signed by the
  pre-push hook, and a hook refusal must not be reported as
  push-non-fast-forward
status: Done
assignee: []
created_date: '2026-11-03'
labels:
  - pipeline-cli
  - next-step
  - attestation
  - push
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - .husky/pre-push
priority: high
dispatchable: true
drift_log:
  - date: '2026-11-05'
    type: ref-deleted
    detail: 'Referenced file no longer exists: scripts/check-attestation-sign.sh'
    resolution: flagged
drift_checked: '2026-11-05'
---

## Description

Every task run on 2026-11-02 from 21:00Z onward that passed review ended as a draft PR with a failed verdict, cause `push-non-fast-forward`: AISDLC-1157 (#2301), 1159 (#2302), 1161 (#2303), 1162 (#2304), 1158 (#2305), 1160 (#2306), 1163 (#2307), 1156 (#2308). Earlier the same day 1083 (#2277), 1153 (#2282), 1154 (#2286) and 1155 (#2292) failed the same way. Each one needed the operator to notice the draft and the planner to push and mark it ready by hand.

None of these was a real non-fast-forward. In every case the local branch was strictly ahead of `origin/<branch>` (2 ahead, 0 behind), and the planner's plain `git push origin HEAD:refs/heads/<branch>` from the same worktree, with the same pre-push hook, succeeded first time.

The worktree reflogs show the same sequence on every task (1156, 1157, 1162, 1163 checked):

```
commit: chore: mark AISDLC-N complete
commit: chore: auto-sign attestation for AISDLC-N (AISDLC-133)   <- Step 10.6 in-process sign
commit: chore: auto-sign attestation for AISDLC-N (AISDLC-133)   <- pre-push hook signs again during ship's push
rebase (start): checkout HEAD~1                                   <- executor drops the duplicate by hand
```

So inside `ship` (`pipeline-cli/src/next-step/ship.ts`, Step 11a loop, `PUSH_ATTEMPTS = 2`): the pre-push hook does not accept the envelope Step 10.6 just committed, signs again, commits a second envelope and exits 1; the retry fails as well; the final error text matches `/non-fast-forward|rejected/` and is reported as a non-fast-forward with the "delete the remote branch" advice. AISDLC-1154 added a fast-forward fallback only to `steps/11-push-and-pr.ts` on resumed runs, a path executors do not take, so it changed nothing here.

The raw push stderr is discarded by the classifier, so the exact hook message is not on record. The developer must reproduce it before choosing the fix. Candidates to check first: the hook's freshness check against the Step 10.6 envelope under ship's `pushEnv` (AISDLC-1155 changed how the workflow state reaches the sign and push spawns), and whether the hook's "signed, re-push" exit is distinguishable from a refusal.

**Five-step review (requirements first).**
1. Requirement questioned: must ship sign in-process and the hook also be able to sign? The hook must keep signing for pushes outside the pipeline. A push that ship has already signed must not be signed twice, and a push failure must be reported as what it is.
2. Delete: the second signature on a ship push, and the `rejected` alternative in the non-fast-forward classifier.
3. Simplify: one signer per push. Either the hook recognises a fresh envelope at HEAD and exits 0, or ship tells it signing is done. Classify non-fast-forward only from git's own non-fast-forward rejection line, after a fetch shows `origin/<branch>` is not an ancestor of HEAD. When the remote is an ancestor, push plainly, as AISDLC-1154 does for step 11.
4. Accelerate: a reviewed, signed task becomes a ready PR in the same run, with no operator noticing and no planner push.
5. Automate: a ship test that runs the real pre-push signing path after Step 10.6 and asserts one envelope commit and a successful first push. A classifier test asserts a hook refusal is reported as a hook refusal, with its stderr.

Velocity impact: this is the single largest source of stranded drafts on 2026-11-02 (12 PRs). Each one cost an operator report and a manual planner repair.

## Acceptance Criteria

- [x] AC-1: Reproduce the failure in a test. After Step 10.6 signs, ship's push through the real pre-push hook produces a second auto-sign commit and a non-zero exit. Record the hook's message in the PR body.
- [x] AC-2: After the fix, a ship run that signs at Step 10.6 pushes on the first attempt with exactly one auto-sign commit at HEAD. The test from AC-1 asserts this.
- [x] AC-3: Ship reports `cause: push-non-fast-forward` only when git's output names a non-fast-forward and a fetch shows `origin/<branch>` is not an ancestor of HEAD. When it is an ancestor, ship pushes plainly without a lease, matching AISDLC-1154 in step 11.
- [x] AC-4: Any other push failure is reported with its own cause and the last stderr lines in the stop reason, so the verdict names the real failure. Tests cover a hook refusal and a real divergence.
- [x] AC-5: A ship run whose developer pass already pushed the branch and opened the draft ends with the draft marked ready, as on a fresh branch.

## Notes

Evidence: failed verdicts in `.ai-sdlc/dispatch/failed/AISDLC-{1156..1163}.verdict.json`, all `cause: push-non-fast-forward` after approvals; worktree reflogs under `.worktrees/aisdlc-{1156,1157,1162,1163}`. Repairs done by the planner 2026-11-03: fast-forward pushes to #2301, #2303, #2304, #2305, #2307, #2308 and `gh pr ready` on #2301 to #2308.

Related: AISDLC-1154 (fixed the same symptom in step 11 only), AISDLC-1098 (lease push after a step 10.5 rebase), AISDLC-1155 (workflow state env passed to sign and push spawns), AISDLC-1156 (dispatch finishes a repaired push), AISDLC-1149 and DEC-0290 (task PRs open ready).

## Final Summary

## Summary
The security reviewer's major finding is fixed in `ship.ts`. A remote ref that did not exist before the push now aborts the lease push instead of pinning it to the tip this run's own fetch just created. A failed fetch after a rejection is now reported as `push-failed`, not `push-non-fast-forward`.

## Changes
- pipeline-cli/src/next-step/ship.ts
- pipeline-cli/src/next-step/ship.test.ts

## Design decisions
The first version of the fix (setting the pre-fetch ref to '' only inside the rejection branch) still failed the new test. Attempt 1's own fetch created the ref, so attempt 2 read it as 'seen' and ran the lease push. I moved the `rev-parse` of `refs/remotes/origin/<branch>` out of the loop, so it runs once before the first push. The `rev-parse` fallback is '', and `leasePushOwnRebaseShip` then returns null. Two tests were added. One asserts no `--force-with-lease` push is issued when the ref was never seen. The other asserts a failed fetch gives `push-failed` with no lease push. I rebased onto origin/main and pushed with `--force-with-lease`. PR #2314 already existed and is currently not a draft, so I did not open a new one. If `/ai-sdlc execute` expects the PR to stay a draft until reviewers sign, that status needs checking.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

