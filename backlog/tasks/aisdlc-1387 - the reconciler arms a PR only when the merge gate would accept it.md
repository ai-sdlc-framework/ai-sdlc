---
id: AISDLC-1387
title: 'The reconciler arms a PR only when the merge gate would accept it'
status: To Do
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - pipeline-cli
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/cli/merge-if-eligible.ts
priority: medium
---

## Description

**Gap.** The reconciler decides to own and arm a PR with its own tests, and `cli-merge-if-eligible` then applies different ones:

- Trust: the reconciler matches the PR author against `AI_SDLC_RECONCILE_AUTHORS` (`reconcile.ts:1505-1518`, `:1702-1708`). The gate also requires the head commit author to be in `spec.governance.mergeAuthors` (`merge-if-eligible.ts:843-849`).
- Task id: the reconciler derives `ctx.taskId` itself (`reconcile.ts:510-519`). The gate uses `deriveTaskId` (`merge-if-eligible.ts:624-639`: branch `ai-sdlc/<ID>-...` or trailing `(<ID>)` in the title).

**Failure.** arcana-website PRs by `akillies` (#184, #207, #214, #219) have head commits authored by `Akillies2099`. With akillies on the reconcile allow-list, dispatch owns and arms them, every arm is refused, and each PR loops on `arm failed x2` and routes to the planner. arcana-website #226 (branch `ai-sdlc/file-dec-0012-*`, no id in the title) did the same with the task-id refusal, until `(ARC-56)` was added to the title.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the reconciler needs to know whether the gate will accept the PR, not to keep its own copy of the gate's rules. 2. Deleted: arming on the reconciler's own judgement. 3. Simplified: ask the gate itself with the existing `--dry-run` (`cli/merge-if-eligible.ts:180-184`), so there is one trust test and one id derivation. 4. Accelerated: the dry run runs only on the `arm` path, which is rare. 5. Automated: tests below.

- Before the `arm` action (`reconcile.ts:275`, command at `:526-540`), run `cli-merge-if-eligible <pr> --source-kind <kind> --dry-run`. On a refusal, do not arm: route the PR to the planner once per head sha with the gate's own refusal reason.
- On `dry-run` success, arm as today.
- No change to the gate's rules.

## Acceptance Criteria

- [ ] #1 A test: a PR whose head commit author is not in `mergeAuthors` is not armed and is routed once with the gate's reason.
- [ ] #2 A test: a task-kind PR with no derivable id is not armed and is routed once with the gate's reason.
- [ ] #3 A test: an eligible PR is armed as before.
- [ ] #4 No PR produces `arm failed` twice for the same head sha because of a gate refusal.
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
