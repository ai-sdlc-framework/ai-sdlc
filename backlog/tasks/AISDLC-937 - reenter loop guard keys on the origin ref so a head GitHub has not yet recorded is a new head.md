---
id: AISDLC-937
title: 'reenter loop guard keys on the origin ref so a head GitHub has not yet recorded is a new head'
status: To Do
assignee: []
created_date: '2026-10-16'
labels: [bug, dispatch, hierarchy, pipeline-cli, velocity]
dependencies: []
references: [pipeline-cli/src/hierarchy/reenter.ts, pipeline-cli/src/hierarchy/reenter.test.ts]
priority: critical
dispatchable: true
---

## Description

`cli-dispatch reenter` takes the head it guards on from GitHub's pull-request record (`view.headRefOid`, `pipeline-cli/src/hierarchy/reenter.ts` line 164) and refuses when the same `(route, headSha)` pair was taken before (lines 203-211). On 2026-10-15 22:58Z GitHub stopped recording synchronize events for one pull request: the branch on `origin` moved to a rebased, re-signed head at 23:15Z and again on 2026-10-16, but the pull-request record kept the old head for 18 hours. Every re-entry was refused with `loop guard: executor@<old> x2 ... the head has not changed`, the task sat in `done/` with no owner, no executor could claim it, and the planner role cannot push. The pull request blocked a downstream consumer project for a day. The guard's own escape hatch (route it to the planner) led back to the same dead end.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that "the head" means what GitHub's pull-request record says. The requirement is that the same code is never re-entered twice; the code is what `origin` holds, and the pull-request record is a cache of it that can lag. 2. Deleted: the dependence on `headRefOid` for the guard key. 3. Simplified: one `git ls-remote origin refs/heads/<headRefName>` read gives the real head; the pull-request record is used only for the branch name and the check facts. 4. Accelerated: a pushed branch is re-enterable the moment the push lands, not when GitHub's record catches up. 5. Automated: a test with a pull-request record that lags `origin` proves the guard accepts the new head and records it.

- The guard key is the tip of `refs/heads/<headRefName>` on `origin` (`git ls-remote`), falling back to `headRefOid` only when the remote read fails (print the fallback on stderr).
- When the two differ, print one line: `pull request #N: GitHub records <old>, origin holds <new>; guarding on origin`.
- The `rerun` route still passes GitHub's recorded head to `gh run rerun --commit` (the runs belong to that head); the `executor` route passes the origin head in the resume note.

## Acceptance Criteria

- [ ] `reenter` on a pull request whose record lags `origin` is accepted and the guard entry carries the origin head.
- [ ] `reenter` twice on the same origin head and route is still refused by the loop guard.
- [ ] When `git ls-remote` fails, the guard falls back to the recorded head and says so on stderr.
- [ ] A test covers each of the three cases above.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
