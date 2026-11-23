---
id: AISDLC-1346
title: 'A parent with a tracked change is reported once with its files and does not use up task retries'
status: Done
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - hierarchy
  - dispatch
  - adopter
dependencies: []
references:
  - pipeline-cli/src/steps/00-parent-upkeep.ts
  - pipeline-cli/src/steps/00-parent-upkeep.test.ts
  - pipeline-cli/src/next-step/init.ts
  - pipeline-cli/src/next-step/next-step.ts
  - pipeline-cli/src/dispatch/requeue.ts
  - pipeline-cli/src/dispatch/requeue.test.ts
  - pipeline-cli/src/hierarchy/playbook.ts
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to one refusal message and cause, the retry count rule and their tests.'
---

## Description

**Gap.** When the parent checkout has an uncommitted change to a tracked file, Step 0 refuses every task. The refusal does not say which file changed, and each refused task is counted against its requeue limit as if the task itself had failed. With a limit of 2, a few ticks use up the retries of every queued task for a fault that is not theirs.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-19, project `amplified-career-site`): an operator edit to the tracked file `.ai-sdlc/agent-role.yaml` in the parent checkout made Step 0 refuse four tasks at once, and each refusal counted against the requeue limit of 2.

**Cause (read from the source).**

- `assertParentClean` (`pipeline-cli/src/steps/00-parent-upkeep.ts:111-138`) returns the refusal "Step 0 parent check refused: the parent has tracked changes; the dispatch tick repairs the parent ..." (text at `00-parent-upkeep.ts:106-108` and `:131-135`). It does not name the changed files. `pipeline-cli/src/next-step/init.ts:79-80` passes the reason on as the stop reason.
- The tick-side repair skips its reset and exits 0 for any tracked change outside `backlog/tasks` and `backlog/completed` (`ai-sdlc-plugin/scripts/check-orchestrator-state.sh:246-255`), so the parent stays dirty and every claim is refused again.
- `DEFAULT_REQUEUE_RETRY_LIMIT` is 2 (`pipeline-cli/src/dispatch/session-reaper.ts:273`). `requeueFailed` (`pipeline-cli/src/dispatch/requeue.ts:106-165`) adds one to the count per requeue whatever the cause (`requeue.ts:148`).
- The refusal returns outcome `aborted` through `early` (`pipeline-cli/src/next-step/next-step.ts:536-538`) with no `cause`, although `StopInstruction` has a `cause` field (`pipeline-cli/src/next-step/types.ts:237-238`). The playbook escalates a causeless failure (`pipeline-cli/src/hierarchy/playbook.ts:105-111`).
- Not verified in the code: that the text of the requeue grant refusal tells the operator to edit `.ai-sdlc/agent-role.yaml`. The facts came from the adopter report; the developer must find the text and check it.

**Shape.** The refusal names the changed tracked files and carries a cause such as `parent-dirty`. That cause is an environment cause: it never counts against a task's retry limit. Dispatch stops claiming while the parent is dirty and reports it once, not once per task. The message says to commit the change through a pull request.

**Control.** No control changes. The clean-parent rule stays as strict as it is: no path is exempted and the check is not loosened.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: should the parent stay clean? Yes; that rule protects the dispatch checkout and stays. 2. Deleted: the charge of an environment fault to a task's retries. 3. Simplified or optimised: add the file list and a cause to the existing refusal rather than a new check. 4. Accelerated: the operator sees the one file to commit at once. 5. Automated: tests dirty a tracked file and check the message, the cause and the retry count.

- **Message.** Include the changed tracked paths (a short list) and the commit-through-a-pull-request advice in the refusal of `assertParentClean`.
- **Cause.** Return the cause `parent-dirty` on the stop instruction for that refusal.
- **Retry rule.** In `requeueFailed`, a failure record with the cause `parent-dirty` does not raise the retry count.
- **Claim and report.** Stop claiming while the parent is dirty and report it once. The developer finds the claim site in the dispatch tick (`pipeline-cli/src/hierarchy/dispatch-loop.ts` is the likely place); this was not traced.
- **Tests.** Dirty a tracked file and check the refusal text, the cause, an unchanged retry count after requeue, and a single report for several queued tasks.

Out of scope: exempting any path from the clean-parent rule, changing the repair script, and repairing task records already charged.

## Acceptance Criteria

- [ ] #1 A test dirties a tracked file and the refusal names that file and advises committing it through a pull request.
- [ ] #2 The same refusal carries the cause `parent-dirty`.
- [ ] #3 A test requeues a task failed with `parent-dirty` and its retry count is unchanged; a task failed with another cause still gains one.
- [ ] #4 A test with four queued tasks and a dirty parent shows no claim and exactly one report.
- [ ] #5 A test shows a dirty tracked file is still refused, for any path including `.ai-sdlc/agent-role.yaml`.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
