---
id: AISDLC-1140
title: 'Reconciler classifies a Backlog Drift failure whose missing file belongs to a task outside the PR diff as behind-or-dirty (rebase-in-place), not real-failure'
status: To Do
assignee: []
created_date: '2026-10-31'
labels:
  - pipeline-cli
  - hierarchy
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/reconcile.test.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

Filing PR #2202 (AISDLC-1133) failed Backlog Drift on 2026-10-31 with "AISDLC-1132 ✗ Referenced file no longer exists: pipeline-cli/src/usage/transcript-inspect.ts". The PR does not touch AISDLC-1132; its branch simply predates the main commit that deleted that file and the later PR that moved AISDLC-1132 to `backlog/completed/`. The gate checks out the PR head, so the only fix is a rebase, which the docs lane already has as `rebase-in-place` (`DOCS_ACTIONS['behind-or-dirty']`). Instead the classifier read the red check as `real-failure` and routed the row to the planner.

**Five-step review (requirements first).**
1. Requirement questioned: should Backlog Drift run against the merge result instead of the PR head? That is a CI change with wider blast radius and the gate is correct to flag a head that would be red on main; the requirement that stands is "a red that a rebase fixes is a rebase action, not a planner route".
2. Delete: nothing.
3. Simplify: when the failing check is Backlog Drift and every error line names a task id whose task file is not in the PR's changed files, classify the PR `behind-or-dirty`. Any error naming a task the PR does touch stays `real-failure` (for example #2213, whose own task references a file that does not exist on main).
4. Accelerate: nothing; the failing line is already fetched for the developer-round note.
5. Automate: reconcile tests for both cases; `docs/operations/cli-hierarchy.md` names the rule.

Velocity impact: filing PRs stop stalling on a stale base after a drift-affecting landing on main.

## Acceptance Criteria

- [ ] AC-1: A docs or task PR whose only failing check is Backlog Drift, with every error line naming a task file absent from the PR's changed files, decides `rebase-in-place` (docs) or `land-prep` (task) through the `behind-or-dirty` state.
- [ ] AC-2: A Backlog Drift failure naming a task file the PR adds or edits still decides the `real-failure` action for its lane.
- [ ] AC-3: `docs/operations/cli-hierarchy.md` documents the rule; `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Notes

Origin: planner PR-pressure survey 2026-10-31 (#2202 stale base vs #2213 real drift). Sibling tasks: AISDLC-1137, AISDLC-1138, AISDLC-1139.
