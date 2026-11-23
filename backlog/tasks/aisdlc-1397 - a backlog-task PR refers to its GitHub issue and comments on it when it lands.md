---
id: AISDLC-1397
title: 'A backlog-task PR refers to its GitHub issue and comments on it when it lands'
status: To Do
assignee: []
created_date: '2026-11-23'
labels:
  - enhancement
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/src/steps/11-push-and-pr.ts
  - docs/operations/backlog-and-execution-reference.md
priority: medium
---

## Description

**Gap.** When a backlog task names a GitHub issue (an issue URL or `#N` of this repository in its `references` or body), the PR it produces says only `References AISDLC-N` (`11-push-and-pr.ts:213`), and nothing tells the issue's reporter that work landed. An adopter reported this as "the PR doesn't close the issue" (GitHub #2754, item 3).

**Ruling.** Operator, 2026-11-23, via the decision rubric (planner session): a backlog-task PR writes `Refs #N` for each referenced issue and, when the PR lands, the CLI comments on each issue with the PR number and merge sha. A human closes the issue. Rejected: a `closes:` field writing `Closes #N` (loosens the "never close issues" rule and fires on partial fixes; #2754 itself spans eight items across several PRs) and closing every referenced issue (closes issues that were only cited). The gh-issue execution path (`sourceKind: gh-issue`, `Closes #N` at `:168`/`:213`) is unchanged by this task.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: the reporter needs to know work landed; closing is a separate human judgement. 2. Deleted: nothing. 3. Simplified: issue numbers come from the task file once, at PR creation, and are stored in the PR body; the landing step reads them back from the body. 4. Accelerated: none. 5. Automated: the landing comment.

- At PR creation, collect GitHub issue references of this repository from the task (`references` entries and body links to an issue URL of this repository (path `/issues/N`) or `gh:N`), and add one `Refs #N` line per issue to the body. Never write `Closes`, `Fixes` or `Resolves` on this path.
- When a backlog-task PR is retired as landed (the step that marks a task landed after merge), post one comment per referenced issue: `Landed in #<pr> (<short sha>): <task title>.` Idempotent: skip when a comment with that PR number already exists on the issue.
- Update `docs/operations/backlog-and-execution-reference.md` (the note added by AISDLC-1369) to describe the new behaviour.

## Acceptance Criteria

- [ ] #1 A test: a task whose `references` lists this repository's issue 2754 by URL produces a PR body with `Refs #2754` and no closing keyword.
- [ ] #2 A test: landing posts exactly one comment per referenced issue, and a second landing pass posts none.
- [ ] #3 A test: an issue URL of another repository is ignored.
- [ ] #4 The gh-issue path still writes `Closes #N` (existing tests unchanged).
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
