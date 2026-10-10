---
id: AISDLC-801
title: >-
  `cli-file` for the planner: validate (drift, DoR, ASCII filename, task-id title) and push a backlog task or decision record in one step, so filing PRs land first time
status: To Do
assignee: []
created_date: '2026-10-10'
labels:
  - planner
  - backlog
  - decisions
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/cli/decisions.ts
  - pipeline-cli/bin/cli-dor-check.mjs
  - scripts/check-backlog-ascii.sh
  - ai-sdlc-plugin/commands/planner.md
  - pipeline-cli/src/cli/merge-if-eligible.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Incident (2026-10-10).** Of the planner's eleven filing PRs that day, four had to be replaced and closed (#1324, #1325, #1237's content, and an earlier duplicate): one failed DoR gate 3 on a bare task id with no file, one failed the drift gate on a reference to a file the task itself creates, two conflicted on the single decision event log once main moved. A planner session cannot lease-push a filing branch (it is not a task worktree, by design), so every red or conflicting filing PR becomes a new PR plus an operator close. Decision-record PRs also cannot be armed by `cli-merge-if-eligible` (governance path) and depend on the auto-enable workflow firing on open.

**Root cause.** Filing is done by hand (write file, commit, push, `gh pr create`) with the validators run only when the author remembers, and the events log makes every record PR conflict-prone until AISDLC-719 lands.

**Fix.**
1. `node pipeline-cli/bin/cli-file.mjs task <path> [--pr]` and `cli-file decision <id> --answer <option> [--pr]`: run the ASCII filename check, `backlog-drift check` scoped to the new file, `cli-dor-check`, and (for decisions) a JSONL parse of the whole log; refuse with the exact finding before anything is committed. On success it creates a branch `ai-sdlc/file-<id>` from `origin/main` in `.worktrees/file-<id>`, commits with a conventional `chore(docs)`/`chore(decisions)` subject ending in `(<TASK-ID>)`, pushes as a plain fast-forward, and opens the PR with the body it generates. It never force-pushes.
2. If the branch exists and is behind main with a conflict only in `.ai-sdlc/_decisions/events.jsonl` (append-only), `cli-file rebase <id>` rebuilds the branch from `origin/main` plus the branch's own new lines and pushes to a NEW branch `ai-sdlc/file-<id>-r<n>`, opening a replacement PR and commenting on the old one; the planner never needs a lease push. With one file per decision event on main this path is rarely taken.
3. The planner command body uses `cli-file` for every filing; the "run drift and DoR before pushing" rule becomes unnecessary because the tool enforces it.

**Velocity impact.** Positive: filing PRs stop bouncing; no governance change (the planner still cannot force-push).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] `cli-file task` refuses, before committing, on a non-ASCII filename, any error-severity drift on the new file, or a DoR verdict other than ready, printing the finding.
- [ ] `cli-file decision` appends an opened and/or answered event only after the whole log parses, and refuses a duplicate `(decisionId, type)` pair.
- [ ] Both open a PR whose title ends with the owning task id and whose branch is fast-forward pushed, with hermetic tests over a temp git remote.
- [ ] `cli-file rebase` produces a replacement branch and PR without any force push; tested.
- [ ] `planner.md` uses `cli-file` for filings.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- AC:END -->

## Notes

Family 5 of the 2026-10-10 root-cause set. Complement: AISDLC-719 (#1243) removes the events-log conflict class. A separate class (b) decision on letting the planner lease-push `ai-sdlc/file-*` branches is for the operator; this task is independent of that decision.
