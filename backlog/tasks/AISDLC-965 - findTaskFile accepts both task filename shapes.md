---
id: AISDLC-965
title: 'cli-file refuses a task filename that is not the Backlog.md shape'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - hierarchy
  - dispatch
dependencies: []
references:
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/cli/dispatch.ts
priority: high
dispatchable: true
---

## Description

Both resolvers, `findInDir` in `pipeline-cli/src/steps/01-validate.ts` and `findTaskFile` in `pipeline-cli/src/cli/dispatch.ts`, match a task file by the Backlog.md prefix `<id> - ` (id, space, dash, space). `cli-file task <path>` keeps the basename of its source file unchanged, so a source named `aisdlc-954-<slug>.md` lands on `main` under that name and the task can never be claimed: the validate step stops with "no task file" and `brief --notify` ingestion reports no-match. This hit the eleven tasks AISDLC-954..964 (renamed by hand in PR #1731; AISDLC-954 and AISDLC-955 each burned an executor round first).

**Five-step review (requirements first).**
1. Requirement questioned: should the resolvers accept a second filename shape? No; one shape (`<id> - <slug>.md`, 101 existing files) and one place that enforces it at filing time is simpler than two matchers that each tolerate two shapes.
2. Delete: the by-hand `write-manifest` workaround in the dispatch session and the by-hand rename PR become unnecessary.
3. Simplify: `cli-file` validates the basename against `^<id> - .+\.md$` (id case-insensitive) BEFORE anything is committed, next to the existing ASCII and duplicate-id checks, and refuses with the expected name in the message. No resolver change.
4. Accelerate: a mis-named filing fails in seconds on the planner's machine instead of after a PR, a merge and a failed executor round.
5. Automate: a unit test in `file.test.ts` covers a slug-shaped basename (refused, message names the expected shape), the canonical shape (accepted) and an upper-case id (accepted).

## Acceptance Criteria

- [ ] `cli-file task` refuses a source whose basename does not match `<id> - <anything>.md` with a `FileRefusal` that prints the expected name, before the worktree is created.
- [ ] The canonical shape with a lower- or upper-case id is accepted unchanged.
- [ ] `file.test.ts` covers the three cases above.
- [ ] `findInDir` and `findTaskFile` are untouched.

## Affected surface

`pipeline-cli/src/cli/file.ts` and `file.test.ts`; no workflow, hook or config change.
