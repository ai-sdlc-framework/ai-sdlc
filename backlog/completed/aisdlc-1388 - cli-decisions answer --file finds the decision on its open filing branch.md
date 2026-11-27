---
id: AISDLC-1388
title: 'cli-decisions answer --file finds the decision on its open filing branch'
status: Done
assignee: []
created_date: '2026-11-22'
labels:
  - bug
  - pipeline-cli
  - decisions
dependencies: []
references:
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/cli/decisions.ts
priority: medium
---

## Description

**Gap.** `cli-decisions add --file` without `--pr` publishes branch `ai-sdlc/file-<dec>-add-<hhmm>` (`pipeline-cli/src/cli/file.ts:811-823`) and opens no PR. `answer <id> --file` builds from origin/main and looks for the `decision-opened` event only in the local log and origin/main (`file.ts:733-773`), so it refuses with `no decision-opened event for DEC-NNNN`.

**Failure.** arcana-website DEC-0010 and DEC-0011: both answers had to be written by hand in the add worktree and opened as manual PRs (#216, #217).

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a branch with no PR is a dead end; nothing lands it, so `add --file` without `--pr` has no use that `--pr` does not cover. 2. Deleted: `add --file` without `--pr` publishing an orphan branch. 3. Simplified: `add --file` without `--pr` refuses, naming `--pr`; and `answer --file` looks for an open `ai-sdlc/file-<dec>-add-*` filing PR and, if its decision is not yet on main, appends the answer to that branch instead of refusing. 4. Accelerated: none. 5. Automated: tests below.

- `add --file` without `--pr` refuses: `add --file needs --pr: a filing branch without a PR never lands`.
- `answer --file` for a decision whose `decision-opened` event is on an open filing PR branch commits the answer to that branch and reports its PR URL.
- The refusal text for a decision found nowhere stays as today.

## Acceptance Criteria

- [ ] #1 A test: `add --file` without `--pr` refuses with the message above.
- [ ] #2 A test: `answer --file` after `add --file --pr` whose PR is still open appends to that branch and succeeds.
- [ ] #3 A test: `answer --file` for a decision on main behaves as today.
- [ ] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
