---
id: AISDLC-1154
title: 'Step 11 resume push falls back to a plain fast-forward push when the recorded lease is stale and the remote head is an ancestor of HEAD: signed task PRs stop stranding as drafts after a developer push mid-run'
status: To Do
assignee: []
created_date: '2026-11-02'
labels:
  - pipeline
  - push
  - incident
dependencies: []
references:
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - pipeline-cli/src/execute-pipeline.ts
  - pipeline-cli/src/hierarchy/playbook.ts
  - docs/operations/cli-hierarchy.md
priority: critical
dispatchable: true
---

## Description

Twice in two days a task re-entry completed verify, review and signing and then failed at Step 11 with `cause: push-non-fast-forward`, leaving a reviewed, signed head unpushed and the PR as an unreviewed draft: AISDLC-1136 (#2246, 2026-11-01) and AISDLC-1153 (#2282, 2026-11-02 15:36Z). In both cases the remote branch was a plain ancestor of the local signed head (two commits behind: mark-complete and auto-sign), so a normal fast-forward push was safe and the planner did it by hand.

Cause, by code reading: on a resumed run Step 11 (`pipeline-cli/src/steps/11-push-and-pr.ts`, around line 599) pushes with `--force-with-lease=<branch>:<resumeRemoteSha>` where `resumeRemoteSha` is the remote head recorded at Step 3 (`execute-pipeline.ts` line 646, AISDLC-738: a mid-run fetch must not widen the lease). The developer subagent pushes its fix round during the run, so by Step 11 the remote has moved past the recorded lease and git rejects the push as stale. The retry `leasePushOwnRebase` (line 331) only covers the own-rebase shape (remote head an ancestor of the pre-rebase sha) and returns null here. The run then aborts with the "cleanup is to delete the remote branch" reason (line 620), which is wrong for this shape: nothing needs deleting.

**Five-step review (requirements first).**
1. Requirement questioned: does a fast-forward push need a lease at all? No. A push whose remote head is an ancestor of the pushed commit cannot clobber anything: every remote commit is contained in what is pushed. The lease exists to protect against foreign commits; a fast-forward has none. The AISDLC-738 rule (never widen the lease mid-run) is about force pushes and stays intact.
2. Delete: the misleading "delete the remote branch and rerun" wording for the fast-forward shape.
3. Simplify: after a stale-lease rejection on a resumed run, fetch `origin/<branch>` and, when it is an ancestor of HEAD, push without any force flag (`git push -u origin HEAD:refs/heads/<branch>`). No new policy, no new option: a plain push is already permitted everywhere a lease push is.
4. Accelerate: one extra fetch only on the rejection path.
5. Automate: a Step 11 test with a runner that rejects the lease push as stale, reports the remote head as an ancestor of HEAD, and asserts a plain push follows and `pushed: true`; a second test asserts that a remote head that is NOT an ancestor still aborts with the existing reason.

Velocity impact: removes the last manual step from a successful re-entry; the two incidents each cost a planner lease push, a manual mark-ready and a dispatch reclaim.

## Acceptance Criteria

- [ ] AC-1: In `11-push-and-pr.ts`, when a resumed run's lease push is rejected (`non-fast-forward|rejected|stale info` in stderr), the step fetches `origin/<branch>` and, if `git merge-base --is-ancestor <remote> HEAD` succeeds, retries with a plain `git push -u origin HEAD:refs/heads/<branch>` (no force flag). The existing `leasePushOwnRebase` retry stays for its own shape.
- [ ] AC-2: When the remote head is not an ancestor of HEAD, the step still aborts with `pushed: false`; its reason no longer suggests deleting the remote branch but states the remote head sha, the local head sha and that a human must reconcile.
- [ ] AC-3: Tests cover both branches of AC-1/AC-2 with a scripted runner; the mark-ready and PR-create steps run after the fast-forward retry exactly as after a first-try push.
- [ ] AC-4: `docs/operations/cli-hierarchy.md` (push section) states that a fast-forward push needs no lease and names the stale-lease shape; `playbook.ts` keeps `PUSH_NON_FAST_FORWARD_CAUSE` for the real conflict shape only.

## Notes

Origin: planner triage 2026-11-02 ~15:40Z of `.ai-sdlc/dispatch/failed/AISDLC-1153.verdict.json` (notes: "origin/branch (1d54ea55) is an ancestor of local HEAD 72293f30"), operator report "the executor finished but the PR is still in draft mode". Precedent #2246 (AISDLC-1136) 2026-11-01 ~04:11Z, same shape, same manual repair. Related: AISDLC-1016 (own-rebase lease retry), AISDLC-1138 (first-push lease), AISDLC-738 (lease fixed at Step 3).
