---
id: AISDLC-919
title: 'fix: decisions-sync PR lands: merge-if-eligible trusts the sync commit and the docs lane arm passes the right source kind'
status: Done
assignee: []
created_date: '2026-10-15'
labels: [governance, decisions, hierarchy, velocity]
references: [pipeline-cli/src/decisions/remote-persist.ts, pipeline-cli/src/governance/merge-if-eligible.ts, pipeline-cli/src/cli/merge-if-eligible.ts, pipeline-cli/src/hierarchy/reconcile.ts]
priority: high
dispatchable: true
---

## Description

The decision-catalog sync PR (head `ai-sdlc/decisions-sync`, green and `CLEAN`) cannot land through any automated path, so every decision recorded through `cli-decisions` stays off `main` and no session may act on it (decision authority requires the record on `main`). Three defects stack:

1. `pipeline-cli/src/decisions/remote-persist.ts` builds the sync commit with `git -c user.name=ai-sdlc-decisions -c user.email=decisions@ai-sdlc.invalid commit-tree`. `.invalid` is not a domain GitHub can link, so the head commit's `author.login` is `null`.
2. `evaluatePrTrust` in `pipeline-cli/src/governance/merge-if-eligible.ts` replaces the backlog-task check with a head-branch check for `--source-kind decisions-sync`, then runs the same head-commit author check as every other kind: `fetchCommitLogins` returns a null author and the lane refuses with "the head commit author is not linked to a GitHub account — refusing (cannot be determined)". The lane refuses its own producer, every time.
3. The reconciler's docs lane (`pipeline-cli/src/hierarchy/reconcile.ts`) classifies `ai-sdlc/file-*`, `ai-sdlc/decisions-sync` and `docs/*` heads as kind `docs`, and its `arm` action always runs `cli-merge-if-eligible <pr> --source-kind backlog --arm`. For the sync PR that fails earlier ("no backlog task id could be derived from head branch"), and `commandExecutor` keeps only the first stderr line while the CLI prints its refusal reason on stdout, so the board note becomes `node failed:` with no reason. Dispatch had to re-run the CLI by hand with each source kind to find the real refusal.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the sync commit be authored by a synthetic bot identity at all. The content is already pinned by `decisionsSyncPathRefusal` (diff limited to `.ai-sdlc/_decisions/events/**`), by the exact head-branch check and by the PR-author check against `mergeAuthors`; the author identity adds nothing the lane relies on, and the trust check is NOT loosened: no exemption from the author check is added for `decisions-sync`. 2. Deleted: the `-c user.name/-c user.email` override in `remote-persist.ts`; the commit is authored with the invoking git identity (the operator's, which is on `mergeAuthors` and linked to a GitHub account), so the existing check passes as designed. 3. Simplified: `actionCommands` in `reconcile.ts` derives the source kind from the head branch (`ai-sdlc/decisions-sync` → `decisions-sync`, `ai-sdlc/file-*` and `docs/*` → `backlog` when a task id is derivable, otherwise `route-to-planner` with the reason), instead of one hard-coded kind for every docs PR. 4. Accelerated: `commandExecutor` keeps the first non-empty line of stdout + stderr in the board note, so a refusal is readable on the board without re-running the command. 5. Automated: nothing new; the single arm in the tick then lands the sync PR on its own.

## Acceptance Criteria

- [ ] `remote-persist.ts` no longer overrides `user.name`/`user.email` for the sync commit; the commit is authored by the invoking git identity. Test asserts the `commit-tree` invocation carries no `-c user.*` flags and that the commit message is unchanged.
- [ ] `evaluatePrTrust` is unchanged for `decisions-sync` (branch check + path restriction + PR author + head-commit author login on `mergeAuthors`); a test documents that a sync PR whose head commit is authored by a `mergeAuthors` member is eligible and one authored by an unlinked identity is still refused.
- [ ] `reconcile.ts` `actionCommands` passes `--source-kind decisions-sync` for a head branch exactly `ai-sdlc/decisions-sync`, `backlog` for a docs PR whose branch or title yields a task id, and routes to the planner with a reason otherwise; tests cover all three.
- [ ] `commandExecutor` records the first non-empty line of stdout or stderr on failure; test asserts a stdout-only refusal reason reaches the board note.
- [ ] The currently open sync PR lands through `cli-merge-if-eligible <pr> --source-kind decisions-sync --arm` once the next sync commit is authored by the operator identity (verified in the PR body with the command output).
- [ ] Task file moved to `backlog/completed/` in the PR.
