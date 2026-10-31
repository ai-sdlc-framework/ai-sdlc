---
id: AISDLC-1143
title: 'Pre-push governance gate ranges from the origin/main merge-base, not from the stale remote head, so a rebased lease push is checked over the PR diff only'
status: To Do
assignee: []
created_date: '2026-10-31'
labels:
  - governance
  - pre-push
  - incident-follow-up
dependencies: []
references:
  - scripts/check-governance-on-push.sh
  - scripts/check-governance-on-push.test.mjs
  - scripts/check-pr-governance.mjs
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

Planner finding 2026-10-31 (DEC-0285 relief pass): `scripts/check-governance-on-push.sh` computes the push range as `merge-base(REMOTE_SHA, LOCAL_SHA)..LOCAL_SHA` whenever the remote branch already exists. After a rebase onto `origin/main`, that merge-base is the branch's ORIGINAL fork point, so the range contains every main commit landed since. The `waived-tests` check then reads task files that are already on main (observed: `backlog/completed/AISDLC-1114 - ...md` blocked the AISDLC-1072 push with "ai-sdlc-plugin/hooks/dispatch-routing.test.mjs and 167 more") and refuses a push whose real PR diff is clean. The four remaining DEC-0285 branches (1072, 785, 940, 655.3) are blocked on this; 1138 and 1140 passed only because their fork points were recent.

CI (`ai-sdlc-gate.yml` governance-gate job) runs the same scripts with `--base` = the PR base, which is the merge-base with main. The pre-push copy must use the same range or it refuses pushes CI would accept (and, for a branch that moved away from main, could skip files CI checks).

## Fix

**Five-step review (requirements first).** Requirement questioned: is a separate pre-push base computation needed at all? No: the pre-push gate is documented as "same scripts, same arguments as CI" (header of the script), and CI's range is the main merge-base, so the remote-head branch of the `if` is the thing to delete. Deleted: the `else` branch that calls `git merge-base "$REMOTE_SHA" "$LOCAL_SHA"`. Simplified: one base computation, `BASE="$(git merge-base "$LOCAL_SHA" origin/main)"`, skipped (as today) when `refs/remotes/origin/main` is absent; `REMOTE_SHA` is no longer read except to skip the delete case (`LOCAL_SHA` all zeros). Accelerated: nothing (one git call either way). Automated: a test in `check-governance-on-push.test.mjs` that builds a repo with a task file carrying a `pnpm test` waiver landed on main after the branch forked, rebases the branch, feeds the hook a pre-push stdin line with the old remote sha, and asserts the push is NOT blocked; and the inverse, a waiver file added on the branch itself is still blocked.

Tightening or equal: for a plain fast-forward push the old range (`REMOTE..LOCAL`) is a subset of the new one (`merge-base(main)..LOCAL`), so no check is loosened (class (a), DEC-0039).

## Acceptance Criteria

- [ ] AC-1: `check-governance-on-push.sh` computes `BASE` from `git merge-base "$LOCAL_SHA" origin/main` in every case where `origin/main` is known; the `REMOTE_SHA` merge-base branch is removed.
- [ ] AC-2: `check-governance-on-push.test.mjs` covers a rebased branch whose original fork point predates a main commit that adds a waived-tests task file: the hook passes. A waiver task file added on the branch itself still blocks.
- [ ] AC-3: `docs/operations/quality-gate.md` pre-push section states the pre-push range is the origin/main merge-base, the same range as CI.
- [ ] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.
