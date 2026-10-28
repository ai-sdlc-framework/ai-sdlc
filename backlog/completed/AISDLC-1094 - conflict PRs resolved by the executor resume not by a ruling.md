---
id: AISDLC-1094
title: 'DIRTY task PRs: the reenter manifest runs the rebase-resolver step inside the executor resume, keeps the board tie after reenter, and escalates only a semantic conflict'
status: Done
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/next-step/next-step.ts
  - docs/operations/ci-conflict-resolver.md
  - docs/operations/cli-hierarchy.md
---

## Description

Workflow audit 2026-10-28. Five open PRs are DIRTY (#2027, #1731, #1677, #1663, #1652), two of them for twelve days. For a task PR the reconciler's answer is a queue manifest saying "resolve the merge conflict" (`pipeline-cli/src/hierarchy/reenter.ts`), which then needs an executor to claim it and a developer to notice the conflict. The `ci-conflict-resolver` agent that knows mechanical conflicts (test additions, prettier drift, lockfile, CHANGELOG removal per AISDLC-401) is reachable only through the manual `/ai-sdlc resolve-conflicts` command (`docs/operations/ci-conflict-resolver.md`); no code path calls it. Reenter also moves the task's `done/` verdict to `landing/<pr>/history/`, after which `prBelongsToTask` can no longer tie the PR to the board, so the PR drops out of the reconciler on the next tick (AISDLC-906, #1663).

## Fix

**Five-step review (requirements first).** The requirement questioned is "a conflict is developer work, so queue it for an executor": most conflicts here are mechanical and the resolver already exists; the real requirement is "a mechanical conflict is resolved by the first process that sees it, and only a semantic one costs a model turn". Deleted: the prose manifest note "resolve the merge conflict" and the manual-only reach of the resolver. Simplified: one conflict step in the executor resume: rebase, run the mechanical resolver, verify, lease-push; semantic → escalation record with the diff. Accelerated: a DIRTY PR is rebased within one executor claim instead of one planner ruling plus one claim. Automated: the reenter keeps a copy of the verdict's `prUrl` on the board so the tie never breaks, with a test on the live #1663 history layout.

1. `reenter.ts`: for `DIRTY` write the manifest with `resume.conflict: true` and keep a `landing/<pr>.json` field `taskId` so `prBelongsToTask` resolves from it (fixes the history-move gap).
2. `next-step.ts`: a `conflict` resume step before the developer: `git rebase origin/main`; on conflict apply the mechanical rules of `ai-sdlc-plugin/agents/rebase-resolver.md` through the existing `cli-fix-ci` helpers where they exist (lockfile regenerate, prettier, CHANGELOG diff drop, test-addition both-sides); on a remaining conflict write `escalations/<task>.conflict.json` with the file list and diff hunks and return `prUrl: null` with the semantic reason. Then verify, re-sign if the hash changed, lease-push.
3. The `ci-conflict-resolver` agent stays for the manual command; the step above reuses its documented rule list, not a model call.
4. Tests: fixture repos for lockfile, prettier, CHANGELOG, test-addition, and one semantic conflict (modify vs delete) → escalation; reconciler test that a PR with `landing/<pr>.json.taskId` and no `done/` verdict is still owned.
5. `docs/operations/ci-conflict-resolver.md` and `docs/operations/cli-hierarchy.md`: the conflict step and the escalation shape.

## Acceptance Criteria

- [x] A DIRTY task PR with only a lockfile and prettier conflict is rebased, verified, re-signed and lease-pushed by one executor claim, with no planner ruling.
- [x] A modify-vs-delete conflict produces an escalation record naming the files and leaves the PR untouched.
- [x] After reenter moves a verdict to history, the PR is still listed by the reconciler with its task id.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Final Summary

## Summary
Addressed all round 1 review findings. I shortened the conflict resume note to 295 characters so the abort and escalate clause survives the 400-character prose cap. I added a reenter test asserting the note contains 'rebase --abort', 'escalate' and 'naming the files'. In prBelongsToTask I moved the landing-record read to the last check.

## Changes
- pipeline-cli/src/hierarchy/reenter.ts
- pipeline-cli/src/hierarchy/reenter.test.ts
- pipeline-cli/src/hierarchy/reconcile.ts

## Design decisions
I ran pnpm build && pnpm test && pnpm lint && pnpm format:check as one chained command, and all four passed (exit 0). The output I captured was only the tail, so it has no test summary line to quote. The rebase onto origin/main was a no-op because the branch was already current. The first commit attempt failed commitlint on scope 'pipeline-cli', so the commit uses scope 'orchestrator'.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

