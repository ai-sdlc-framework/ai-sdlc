---
id: AISDLC-828
title: >-
  requeue past the retry cap when the failed task has an open pr, so pr follow-up never needs a planner ruling
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - dispatch
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/dispatch/requeue.ts
  - ai-sdlc-plugin/commands/operator-dispatch.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Problem.** `cli-dispatch requeue --task-id <id>` refuses after 2 retries (`pipeline-cli/src/dispatch/requeue.ts`, `DEFAULT_REQUEUE_RETRY_LIMIT`, `--retry-limit` capped at 2 as a mistake guard). `cli-dispatch resume` works only on `done/` tasks. A task in `failed/` whose PR already exists and needs only a mechanical finish (rebase onto main, re-sign, lease push, ready flip) therefore has NO sanctioned path back to an executor, and the board is the only channel to executors (planner and dispatch never message executors by hand). On 2026-10-13 this parked three open PRs at once: #1407 (AISDLC-549, 29 unpushed commits, missing test-reviewer round), #1248 (AISDLC-742, DoR drift), #1389 (AISDLC-799). DEC-0127 makes "PR on main" the definition of done, so finishing an existing PR is follow-up work, not a retry.

**Five-step review (requirements first).** Requirement questioned: the retry cap of 2 (set as a mistake guard in `requeue.ts`, help text "mistake guard, limit at most 2") was written to stop retry churn on tasks that never produced a PR; it was never meant to count PR follow-ups. Deleted: nothing in the cap itself (it stays for PR-less failures); the `resume`-only-on-`done/` restriction is deleted for tasks with an open PR. Simplified: one rule, a requeue of a task whose failure record or verdict names an open PR URL is a follow-up and does not consume a retry. Accelerated: dispatch requeues on its own playbook instead of escalating to the planner. Automated: nothing new.

**Fix.**
- `requeue.ts`: when the task's `failed/<id>.verdict.json` or manifest carries a `prUrl` (or `pr` number) and `gh pr view <n> --json state` is OPEN, skip the retry-count check and record `followUp: true` with the note; retryCount is not incremented. Without an open PR the existing cap applies unchanged.
- `cli-dispatch requeue` gains `--note <s>` (same semantics as `resume --note`): written to the resume signal so the executor's resume path reads it.
- Dispatch playbook (`ai-sdlc-plugin/commands/operator-dispatch.md`, or wherever the operational list lives): add "failed task with open PR -> requeue --note, no escalation".

**Velocity impact.** Positive: removes a planner round trip for every parked PR follow-up.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 Requeue of a failed task with an open PR succeeds at retryCount 2 and 3, logs followUp, and does not increment retryCount (hermetic test with a stubbed PR-state reader)
- [ ] #2 Requeue of a failed task with no PR, or a MERGED/CLOSED PR, still refuses past the cap with the existing message
- [ ] #3 `--note` is stored and `read-resume-signal` returns it
- [ ] #4 The dispatch playbook names the shape; the executor resume path honors the note (existing behavior, covered by a test)
- [ ] #5 Tests live in `pipeline-cli/src/dispatch/requeue.test.ts`; `pnpm build && pnpm test && pnpm lint && pnpm format:check` clean
<!-- AC:END -->

## Follow-up

(none)
