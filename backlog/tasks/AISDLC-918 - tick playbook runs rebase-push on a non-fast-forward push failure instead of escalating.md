---
id: AISDLC-918
title: 'fix: tick playbook runs rebase-push on a non-fast-forward push failure instead of escalating'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [hierarchy, dispatch, velocity]
references: [pipeline-cli/src/hierarchy/playbook.ts, pipeline-cli/src/hierarchy/operational.ts, ai-sdlc-plugin/commands/operator-dispatch.md, ai-sdlc-plugin/hooks/lib/trusted-policy.js, docs/operations/cli-hierarchy.md]
priority: medium
dispatchable: true
---

## Description

On 2026-10-15 an executor finished a task (both review rounds approved, envelope signed) and its `next-step` push was refused as non-fast-forward: the remote tip held the pre-rebase copy of the same patch, the local branch held the rebased, signed copy. The executor wrote a failed verdict whose notes described the shape in prose but carried no cause code. The `tick` playbook (`pipeline-cli/src/hierarchy/playbook.ts`, `classify`) therefore escalated with "the failure record names no cause" instead of running its `rebase-push` step, which exists exactly for this shape and is the only place the dispatch role's `lease-push-own-branch` grant (`.ai-sdlc/agent-role.yaml`, `spec.governance.operational`) is exercised.

The escalation then cost three planner round-trips: the planner verified the branches by hand, ruled "lease-push", dispatch typed the push in Bash, and the PreToolUse guard (`trusted-policy.js` `inspectInflightClaim`, `hierarchy-env`) refused it because only an executor holding the single inflight claim may push from a task worktree. That refusal was correct. The gap is upstream: a failure shape the playbook already knows how to handle reached the playbook without the cause code that selects the step, and dispatch has no way to run a granted operational action for a named task outside an automatic tick classification.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that dispatch (or the planner) ever types a git push. It must not; the playbook's guarded runner is the sanctioned path for `rebase-own-branch` and `lease-push-own-branch`, and the hook's executor-only predicate stays as it is. 2. Deleted: the prose expectation in `operator-dispatch.md` and in operator memory that a "lease push" is something dispatch can run by hand; the command body says instead that the grant is exercised only through the playbook. 3. Simplified: the push step of the pipeline writes a cause code when the push is refused as non-fast-forward (`push-non-fast-forward`, alongside the existing codes the playbook recognises), so `classify` selects `rebase-push` deterministically and no prose parsing is needed. 4. Accelerated: `cli-hierarchy playbook --task <id> --action rebase-push --board-dir <dir>` runs one named playbook step for one task through the same guarded runner and the same operational grant check, so a ruling that says "rebase-push this task" is one command for dispatch rather than a message to an executor it may not address. 5. Automated: the tick already runs the playbook on every failed verdict; with the cause code present nothing more is needed, and the manual subcommand is the fallback for the shapes the classifier does not know yet.

## Acceptance Criteria

- [ ] When the pipeline push step fails with git's non-fast-forward rejection, the failed verdict carries a cause code (`push-non-fast-forward`) and the playbook's `classify` maps it to `rebase-push`; a playbook test covers the mapping and a push-step test covers the code being written.
- [ ] `rebase-push` on that shape rebases the task branch onto `origin/main`, drops a stale-subject envelope when the hook would re-sign, and lease-pushes through the playbook's guarded runner only when the role holds both `rebase-own-branch` and `lease-push-own-branch`; test asserts the refusal when either grant is missing.
- [ ] `cli-hierarchy playbook --task <id> --action <step>` runs one named step for one task, records the outcome on the board like a tick-driven step, and refuses an action not in the role's operational list; test covers success, refusal and an unknown task id.
- [ ] `ai-sdlc-plugin/commands/operator-dispatch.md` states that the lease-push grant is exercised only through the playbook (tick or the named-step command), never a typed push; its command test asserts the sentence. `docs/operations/cli-hierarchy.md` documents the subcommand.
- [ ] The PreToolUse lease-push guard is unchanged.
- [ ] Task file moved to `backlog/completed/` in the PR.
