---
id: AISDLC-1091
title: 'reconciler owns every open PR: no skip lane for unowned, dependabot, chore or draft-of-done PRs; each gets a deterministic next action'
status: To Do
assignee: []
created_date: '2026-10-28'
labels:
  - orchestrator
  - hierarchy
priority: high
dispatchable: true
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - pipeline-cli/src/hierarchy/mark-ready.ts
  - pipeline-cli/src/cli/merge-if-eligible.ts
  - docs/operations/cli-hierarchy.md
---

## Description

Workflow audit 2026-10-28 (operator: "we still have open PRs from two weeks ago"). Of 15 open PRs, 6 are invisible to the reconciler by design, so no automation will ever act on them:

- `gatherFacts` in `pipeline-cli/src/hierarchy/reconcile.ts` drops a PR whose author is not in `AI_SDLC_RECONCILE_AUTHORS` (dependabot, PR #1705, open 12 days) and a task PR that `prBelongsToTask` cannot tie to the board. A `done/` verdict without `prUrl` (AISDLC-855, PR #1652) or a board record moved to `landing/<pr>/history/` by reenter (AISDLC-906, PR #1663) breaks the tie, and both docs PRs have sat DIRTY since 2026-10-16.
- A `chore/*` branch with no task id (PR #2020 pin sync) is classified as docs; `arm` returns `null` and `land-eligible` refuses it ("no backlog task id"), so it waits for a person.
- A draft whose task is already done gets action `none`, owner `executor:unknown` (PRs #2024, #2025, #2027). The `executorDead` takeover branch in the classifier is never set anywhere; it is dead code. Drafts are flipped only by the CodeQL body marker in `mark-ready.ts`.
- A green, CLEAN, unarmed task PR is `no-match` and routed to the planner even though `land-eligible` can arm it.

Every one of these is a PR nobody owns. The product claim is "tell it what you want, it ships"; a PR with no owner is the opposite.

## Fix

**Five-step review (requirements first).** The requirement questioned is "the reconciler acts only on PRs it can tie to a board task, by a trusted author": the real requirement is "every open PR in this repository has exactly one deterministic next action or a named owner", and author and board ties are inputs to the lane, never reasons to skip. Deleted: the `executorDead` dead branch, the `none`/`executor:unknown` owner, and the author-filter skip (the author becomes a lane input; trust still gates arming through `merge-if-eligible`). Simplified: one ownership resolver that derives the task id from the head branch, the PR title suffix, a `Closes`/`References AISDLC-n` line in the body, or the `landing/<pr>/history/` records, in that order. Accelerated: a draft of a done task flips to ready and arms within one tick when green, attested and approved; a dependabot PR is rebased, rerun and armed without a ruling. Automated: a reconciler test fixture per lane (unowned, dependabot, chore-no-task, draft-of-done, green-unarmed) and the `unowned` lane surfaced in `cli-hierarchy status` so a skipped PR is a visible count, never silence.

1. `reconcile.ts`: replace the skip in `gatherFacts` with a lane: `prBelongsToTask` becomes `resolveOwner(pr)` returning `{ taskId | null, lane: task|docs|dependabot|release|chore|unowned }`. The task id derivation order above; a `landing/<pr>/history/` record with a task id counts.
2. `pr-state.ts`: delete `executorDead`. New rows: draft + task done or landed + green + attested + approved → `mark-ready` then `arm`; green + CLEAN + unarmed task PR → `arm` (not `route-to-planner`); dependabot + green → `arm --source-kind deps`; dependabot + BEHIND/DIRTY → `update-branch` once per head, then `rerun-once`; chore with no task id + green → `arm --source-kind docs` when the author is in `mergeAuthors`, else `unowned`.
3. `merge-if-eligible.ts`: accept `--source-kind deps` for dependabot authors (the dependency-review gate ruling DEC-0262 stays the only gate), and `--source-kind docs` for a trusted-author branch with no task id.
4. `unowned` lane: the reconciler writes `notes/unowned-<pr>.txt` with the derivation it tried and routes ONE line to the planner per head; `cli-hierarchy status` prints `unowned PRs: n`.
5. Tests: one fixture per lane in `reconcile.test.ts` and `pr-state.test.ts`, using the five live PRs above as data.
6. `docs/operations/cli-hierarchy.md`, reconciler section: the lane table replaces the "skipped PRs" paragraph.

## Acceptance Criteria

- [ ] With the 2026-10-28 open-PR set as a fixture, no PR gets action `none` with owner `executor:unknown`; each row has a lane and an action or `unowned` with a written reason.
- [ ] A draft of a done task that is green, attested and approved is flipped to ready and armed by the reconciler alone.
- [ ] A dependabot PR that is green is armed with `--source-kind deps`; one that is BEHIND is updated once per head and rerun.
- [ ] A PR whose task verdict lacks `prUrl` is still owned via the branch or title derivation.
- [ ] `cli-hierarchy status` prints the unowned count; a fixture with one unowned PR makes it `1`.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
