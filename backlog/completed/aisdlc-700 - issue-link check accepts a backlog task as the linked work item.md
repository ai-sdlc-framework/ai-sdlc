---
id: AISDLC-700
title: >-
  require-issue-link: a pull request tied to a backlog task passes without a GitHub issue
status: Done
assignee: []
created_date: '2026-10-03'
labels:
  - ci
  - dx
dependencies: []
references:
  - .github/workflows/require-issue-link.yml
  - CONTRIBUTING.md
priority: low
finalSummary: |-
  ## Summary
  The require-issue-link check now passes a pull request tied to a backlog task. The decision logic lives in scripts/issue-link-decision.mjs (tested under pnpm test); the workflow runs it from the base checkout with PR text only via env.

  ## Changes
  - `scripts/issue-link-decision.mjs` (new): bypass, linked issue, backlog task by diff, backlog task by title id.
  - `scripts/issue-link-decision.test.mjs` (new): each case, plus shell-metacharacter title.
  - `.github/workflows/require-issue-link.yml` (modified): sparse base checkout, API file list, delegates to the script.
  - `CONTRIBUTING.md` (modified): one sentence on the backlog-task rule.

  ## Verification
  - `pnpm test:require-issue-link` - 58 pass
  - `pnpm lint`, `pnpm format:check`, dark-code check - clean

  ## Follow-up
  (none)
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`require-issue-link.yml` posts `ai-sdlc/issue-link: failure` on every pull request whose
body has no `Closes #N` style reference. Internal work in this repository is tracked as
backlog tasks, not GitHub issues, so every internal pull request shows a red check. It
is not a required check, but on 2026-10-03 it was red on every pull request of the day,
which hides real failures. The operator asked for this to be filed.

The check exists for external contributors (issue-first workflow). That purpose stays.

## Conventions
- Workflow change: this is internal, operator-overseen work, so editing
  `.github/workflows/` is in scope for the developer on this task.
- Never interpolate pull request text into a `run:` block; bind it to an environment
  variable and treat it as data. The workflow already reads the body this way; keep it.
- The decision logic moves to a small script with `node --test` tests, so it is testable
  without running the workflow.

## Scope
1. The check passes when the pull request is tied to a backlog task: its diff adds,
   modifies or moves a file under `backlog/tasks/` or `backlog/completed/`, or its title
   carries a task id in the form the commit convention uses, for a task id that exists
   as a file on the head or base ref.
2. The status description says which rule passed (linked issue, backlog task, or the
   existing bypass label).
3. A pull request with neither an issue reference nor a backlog task keeps failing, with
   the existing pointer to the contributing guide.
4. `CONTRIBUTING.md` says in one sentence that maintainers' pull requests reference a
   backlog task instead.

## Acceptance Criteria
- [x] A pull request that only adds a file under `backlog/tasks/` passes with a description naming the backlog-task rule.
- [x] A pull request whose title carries an existing task id passes; one whose title carries an id with no task file fails.
- [x] A pull request with `Closes #N` passes as before, and the bypass label still works.
- [x] A pull request with none of these fails as before.
- [x] The decision script has tests for each case, including a title containing shell metacharacters, and they run under `pnpm test`.
<!-- SECTION:DESCRIPTION:END -->
