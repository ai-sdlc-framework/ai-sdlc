---
id: AISDLC-818
title: >-
  Step 10.5 pre-sign rebase distinguishes a conflict from a moved base, rebases at most once per base, and names the conflicting files
status: In Progress
assignee: []
created_date: '2026-10-11'
labels:
  - pipeline
  - fix
dependencies: []
references:
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/steps/11-late-rebase.ts
priority: critical
dispatchable: true
---

## Description

Filed under the operator's 2026-10-11 PR-drain exception (a new PR only to fix an existing PR's error). AISDLC-797 (#1388) failed twice at Step 10.5 with `Step 10.5 rebase loop: main moved 3 times during rebase attempts (rebase-loop)`. Reading `preSignRebase` in `pipeline-cli/src/next-step/ship.ts`: the loop runs `git rebase origin/<target>`; on ANY non-zero exit it aborts, refetches and retries, up to `MAX_REBASE_ATTEMPTS = 3`, then reports "moved 3 times". A rebase that stops on a merge conflict also exits non-zero, so a real conflict is reported as a moved base, the executor is told to "re-resume", and the same conflict fails again. The only path that produces the `rebase-conflict` message is a refetch failure, which never happens.

**Five-step review (requirements first).**
1. Requirement questioned: "rebase until origin/main stops moving" — set when `strict=true` branch protection required an up-to-date branch. Since AISDLC-727 / DEC-0108 the repository runs `strict=false`: a PR does not need to be current with main to merge, so chasing a moving base before signing buys nothing. The attestation binds HEAD, and the pre-push hook re-signs after any later rebase (AISDLC-810).
2. Delete: the retry loop and `MAX_REBASE_ATTEMPTS`.
3. Simplify: one `git rebase origin/<target>` per run. Exit 0 → continue. Non-zero → read `git status --porcelain` / `git diff --name-only --diff-filter=U` for the conflicting files, `git rebase --abort`, and fail with `rebase-conflict` naming those files and the resume command. Compare the `origin/<target>` sha before and after; if it changed during the rebase that is not an error (the PR is still mergeable under strict=false).
4. Accelerate: a conflict is reported on the first attempt with its files, so the resume round (or the conflict-resolver agent) starts with the answer.
5. Automate: nothing new.

Velocity impact: positive; removes two wasted runs per conflicting PR and the misleading failure cause that the dispatch playbook cannot act on.

## Acceptance Criteria

- [ ] AC-1: `preSignRebase` performs at most one rebase per run; `MAX_REBASE_ATTEMPTS` and the retry loop are removed.
- [ ] AC-2: A conflicting rebase returns `kind: 'failed'` with reason code `rebase-conflict`, the list of conflicting paths, and the exact resume command; the worktree is left clean (`rebase --abort`).
- [ ] AC-3: A base that moved during the rebase is not an error; the result is `changed`/`unchanged` as today, with a log line naming the new base sha.
- [ ] AC-4: The `rebase-loop` cause code is removed from the dispatch playbook's recognised shapes (or mapped to `escalate` with the real reason) so no requeue is attempted on it.
- [ ] AC-5: Hermetic tests: conflict (named files, abort, no retry), clean rebase, base moved mid-rebase, fetch failure (skipped).
- [ ] AC-6: Resume note for 797: the verdict notes also show the developer subagent attempting the lease push ("not-task-worktree"); the executor, not the developer, pushes on a resume — confirm the resume prompt says so, or file a sub-id.

## Notes

Evidence: `.ai-sdlc/dispatch/failed/AISDLC-797.verdict.json` (2026-10-11 16:46Z) and the second identical failure at ~21:10Z. Related: AISDLC-810 (hook re-signs after rebase), AISDLC-727 / DEC-0108 (strict=false), AISDLC-762.2 (resume branch).
