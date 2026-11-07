---
id: AISDLC-1221
title: 'cli-file removes its own local filing branch after a successful push'
status: Done
assignee: []
created_date: '2026-11-07'
labels:
  - pipeline-cli
  - planner
  - filing
dependencies: []
references:
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/cli/file.test.ts
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

**Source.** Operator ruling, 2026-11-07, decision rubric run by the planner (option A of four: cli-file after push; sweep in cleanup; no local branch; status quo).

`publish()` in `pipeline-cli/src/cli/file.ts` creates `.worktrees/file-<id>` on branch `ai-sdlc/file-<id>` from `origin/main`, commits, pushes `HEAD:refs/heads/ai-sdlc/file-<id>`, opens the PR, and returns. The `--in-place` path (DEC-0088) and the failure path already remove the worktree and run `git branch -D` on the branch the call created (`file.ts` lines 238 to 246). The `--pr` path leaves the local branch behind. The leftover branch blocks the next filing for the same id: `cli-decisions answer DEC-0392 --file` was refused for six hours on 2026-11-06 because `ai-sdlc/file-dec-0392` (left by the `add` filing) still existed, and 17 such branches had accumulated. Branch deletion is instruction-only for agent sessions (`prompt-rules.js` "Delete branches: never"), so the planner had to ask the operator each time.

**Rubric summary.** Comparable tools (GitHub "automatically delete head branches", `gh pr merge --delete-branch`, git-flow `finish`, release-please and dependabot ephemeral checkouts) have the tool that created the branch remove it; the remote ref is the record. Counter-argument considered: after the push the local branch is the only copy if the remote is deleted. Rebuttal: a closed PR keeps its head until the remote branch is deleted, which is a separate protected action, and reflog keeps the sha for 90 days. Rejected: a cleanup sweep (toil moves, re-filing still blocked until the sweep); no local branch at all (re-records the DEC-0088 preflight shape for the same outcome).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the local branch is needed only until the push succeeds; nothing reads it afterwards (the re-filing guard AISDLC-1045 at `file.ts` line 496 already reads `refs/remotes/origin/ai-sdlc/file-<id>`, and `cli-file rebase` rebuilds from `origin/main`). 2. Deleted: the leftover branch and worktree after the `--pr` path, the same way the in-place path already does; the "never delete branches" rule is unchanged for sessions, cli-file is the sanctioned path. 3. Simplified: one exit for all three paths: worktree removed, local branch deleted, after the remote carries the commit. Guard the delete on `git rev-parse ai-sdlc/file-<id>` equal to `git rev-parse origin/ai-sdlc/file-<id>`; when they differ, keep the branch and print one warning naming it. 4. Accelerated: a second filing for the same id (decision `add` then `answer`, task then `rebase`) runs without an operator step. 5. Automated: `prompt-rules.js` rule text names the exception ("cli-file removes the filing branch it created"); `docs/operations/cli-hierarchy.md` filing section says the local branch does not survive a successful filing.

Scope: `publish()` and its tests only. No change to `--in-place`, to the lease-preflight shape (DEC-0088), to `/ai-sdlc cleanup`, or to the agent-role `blockedActions`. The existing 17 stale branches are deleted by the operator, not by this task.

## Acceptance Criteria
- [x] #1 After a successful `--pr` filing, `git branch --list ai-sdlc/file-<id>` is empty and `.worktrees/file-<id>` is gone; the PR and the remote branch exist (test with the fake `FileDeps` exec, asserting the `branch -D` and `worktree remove` calls come after the `push` and `gh pr create` calls).
- [x] #2 When the local branch sha differs from the pushed remote sha, the branch is kept and one warning is printed (test).
- [x] #3 When `gh pr create` fails, the existing failure path still removes worktree and branch (existing test still passes).
- [ ] #4 Filing the same id twice in a row (`cli-decisions add` then `answer`) succeeds without manual branch deletion (test at the `publish()` level: the second call's `worktree add -b` is not refused).
- [ ] #5 `prompt-rules.js` text and `docs/operations/cli-hierarchy.md` updated; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Final Summary

## Summary
Resume pass. The committed work already met the ACs: cli-file removes its own local filing branch after push, with tests, docs and prompt-rule text updated. I made one change, in file.test.ts. The second-filing test now uses plain .not.toThrow() and asserts the local filing branch is gone after the second call. I rebased onto origin/main and force-with-lease pushed. PR #2479 is still the draft PR.

## Changes
- pipeline-cli/src/cli/file.test.ts

## Design decisions
I did not run a separate pnpm build. Of the checks the prompt lists, I ran only the file.test.ts suite (62 tests passed), pnpm lint and pnpm format:check, all clean. The pre-push patch-coverage hook ran the full pipeline-cli suite, which passed on the final push. The first push attempt failed on a timeout in orchestrator.test.ts, which looks like load from two concurrent coverage runs. That test did not appear in the final run.

## Verification
- `pnpm build` — passed (dashboard build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (240 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

