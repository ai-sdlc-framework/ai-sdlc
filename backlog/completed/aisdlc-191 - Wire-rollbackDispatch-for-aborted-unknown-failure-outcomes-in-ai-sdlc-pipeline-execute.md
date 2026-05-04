---
id: AISDLC-191
title: >-
  Wire rollbackDispatch for aborted + unknown-failure outcomes in
  ai-sdlc-pipeline execute
status: Done
assignee: []
created_date: '2026-05-04 21:26'
labels:
  - bug
  - pipeline-cli
  - reliability
  - reviewer-finding
  - rfc-0012
dependencies:
  - AISDLC-182
references:
  - pipeline-cli/src/cli/execute.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/execute-pipeline.ts
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Source

Reviewer follow-up from AISDLC-182 iteration 2 (code-reviewer, major-severity flagged-as-fast-follow at PR ship time). The iteration-2 wiring covers `developer-failed` + `developer-json-contract-violated` but misses two further outcomes that produce the same on-disk leftover state.

## Problem

`runExecuteCommand` in `pipeline-cli/src/cli/execute.ts` invokes `rollbackDispatch` on:
- `developer-failed`
- `developer-json-contract-violated`

But `executePipeline()` returns `outcome: 'aborted'` from the Step 11 push-failed and PR-creation-failed branches (`pipeline-cli/src/execute-pipeline.ts:229-233`). Both branches occur AFTER:
- Step 4 has flipped task status to `In Progress`
- Step 3 has created the worktree

When `outcome=aborted` lands, the umbrella returns `ok:true` with no rollback. Result: task stuck at `status=In Progress`, worktree at `.worktrees/aisdlc-x/` left on disk, branch on disk. The exact AISDLC-177 witness state — just triggered by a different outcome.

The autonomous orchestrator (`pipeline-cli/src/orchestrator/loop.ts:125-130`) gets this right via `ROLLBACK_OUTCOMES` which is a superset including `aborted` and `unknown-failure`. The umbrella should reach the same coverage.

## Concrete failure scenario

1. Operator runs `ai-sdlc-pipeline execute AISDLC-X --spawner api-key`
2. Developer succeeds, all 3 reviewers approve
3. `gh pr create` returns transient network error → `outcome: 'aborted'`
4. Umbrella returns `ok:true` with no rollback
5. Task is stuck at `In Progress`, worktree + branch persist on disk
6. Operator must hand-rollback (status flip + worktree remove + branch quarantine)

## Fix

Either:
- **Reuse `ROLLBACK_OUTCOMES` constant** from `orchestrator/loop.ts` (export it from there if not already exported; import in execute.ts). Single source of truth; the two surfaces stay in lockstep on outcome-set drift.
- OR duplicate the set locally in execute.ts with a comment cross-referencing the orchestrator's set + a test asserting both sets match (drift detector).

The reusable-export path is cleaner.

## Why deferred from AISDLC-182

The original AC #5 framing said "developer-failed → AISDLC-177 rollback" which the iteration-2 commit `ac14cd5` fully satisfied. The `aborted` + `unknown-failure` coverage is a scope expansion the reviewer flagged at ship time — file as a fast-follow rather than re-iterate (AISDLC-182 was already at iteration cap 2, and the iteration-1 ask was correctly resolved).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 runExecuteCommand invokes rollbackDispatch for `aborted` and `unknown-failure` outcomes in addition to the existing `developer-failed` + `developer-json-contract-violated` coverage
- [ ] #2 The outcome set is sourced from a SINGLE constant shared between orchestrator/loop.ts and cli/execute.ts (preferred) OR duplicated with a test asserting both sets remain in lockstep
- [ ] #3 execute.test.ts gains 2 new tests: one for `aborted` outcome triggering rollback, one for `unknown-failure` outcome triggering rollback
- [ ] #4 README comparison-table parenthetical (which AISDLC-182 said `(matching the autonomous orchestrator)`) is now accurate — the umbrella's rollback outcome set matches the orchestrator's `ROLLBACK_OUTCOMES`
- [ ] #5 No regression: developer-success outcomes still do NOT trigger rollback (covered by existing 'approved → no rollback' guard test)
<!-- AC:END -->
