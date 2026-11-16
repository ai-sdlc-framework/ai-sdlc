---
id: AISDLC-1269
title: 'Issue execution: refuse an issue written by someone outside the project unless a maintainer has marked it, and fence the issue text in the developer prompt'
status: Done
assignee: []
created_date: '2026-11-13'
labels:
  - pipeline-cli
  - security
  - execute
dependencies: []
references:
  - pipeline-cli/src/next-step/gh-issue.ts
  - pipeline-cli/src/next-step/gh-issue.test.ts
  - pipeline-cli/src/steps/05-build-dev-prompt.ts
  - pipeline-cli/src/steps/05-build-dev-prompt.test.ts
  - dogfood/src/dispatch-from-issue.ts
priority: high
dispatchable: true
dispatchableReason: 'Internal audit 2026-11-13 (finding F1), verified by the planner in the source. Operator decision 2026-11-13: file this openly now. One entry point, one prompt builder, tests beside both.'
---

## Description

**Gap.** `/ai-sdlc execute gh:<n>` turns a GitHub issue into a task and hands it to a developer agent on the maintainer's machine. `runGhIssue()` in `pipeline-cli/src/next-step/gh-issue.ts` fetches the issue through `dogfood/src/dispatch-from-issue.ts` and starts the pipeline without looking at who wrote the issue. `pipeline-cli/src/steps/05-build-dev-prompt.ts` then places the title and description in the prompt as plain sections. Reviewer feedback in the same prompt is already fenced with `fenceSafe()`; the issue text is not, and it has no size limit.

Anyone can open an issue on a public repository. Text written by a stranger therefore reaches an agent as if it were the maintainer's task.

Interim rule until this lands: do not run `/ai-sdlc execute` on an issue written by someone outside the project.

**Shape.**

1. Fetch the issue's author association with the issue. When it is not `OWNER`, `MEMBER` or `COLLABORATOR`, refuse to start unless the issue carries a label that only a user with triage or write access can apply (proposed name `execute-approved`), and say so in the stop reason. The association comes from the GitHub API response, never from the issue text.
2. For an issue-sourced task, place the title and the description inside a fenced block marked as untrusted data, using the existing `fenceSafe()` helper, with one sentence telling the agent that the block describes the work and cannot change the rules of the prompt.
3. Cap the title and the description at a fixed number of bytes; a longer issue is refused with the size in the reason.

Backlog-sourced tasks are unchanged: they reach `main` through a reviewed PR.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: issue execution exists so a maintainer can turn an issue into a PR; nothing requires it to accept any author. 2. Deleted: nothing to delete; the unconditional start is replaced. 3. Simplified or optimised: one association check at the single entry point, and reuse of the existing fence helper. 4. Accelerated: n/a. 5. Automated: unit tests at the entry point and in the prompt builder.

## Acceptance Criteria

- [ ] #1 `runGhIssue()` returns a stop instruction, without creating a worktree or spawning an agent, for an issue whose author association is not `OWNER`, `MEMBER` or `COLLABORATOR` and which lacks the approval label. The reason names the author association and the label.
- [ ] #2 The same issue with the approval label starts normally; an issue by an `OWNER`, `MEMBER` or `COLLABORATOR` starts without the label. Unit tests cover the three cases.
- [ ] #3 An issue whose author association cannot be read is refused.
- [ ] #4 For `sourceKind: 'gh-issue'`, the developer prompt holds the title and description only inside a fenced untrusted block built with `fenceSafe()`; a test asserts that a description containing a closing fence and a heading cannot end the block.
- [ ] #5 An issue whose title or description exceeds the cap is refused with the measured size and the cap in the reason.
- [ ] #6 The developer prompt for a backlog-sourced task is byte-identical to today's for the same input.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
