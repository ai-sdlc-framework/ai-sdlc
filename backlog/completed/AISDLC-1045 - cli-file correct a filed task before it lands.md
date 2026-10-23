---
id: AISDLC-1045
title: 'cli-file: correct a filed-but-unmerged task through the sanctioned path (rebase takes a corrected source, update accepts an open filing branch)'
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - pipeline-cli
  - governance
  - velocity
dependencies: []
references:
  - pipeline-cli/src/cli/file.ts
  - docs/operations/decision-authority.md
priority: medium
dispatchable: true
---

## Description

Twice on 2026-10-22 a filing PR went red on Backlog Drift because the task body named a path that does not exist on main (a `.prettierrc` that is really `.prettierrc.json`; an `orchestrator/` path that lives under `reference/`). There is no `cli-file` path to correct such a task before it lands:

- `cli-file rebase <id>` rebuilds the filing branch from `origin/main` but copies the task file verbatim from the old branch (`git show <old>:<file>`), so the wrong content comes back and the PR stays red.
- `cli-file task <path> --update` edits only a task that already exists on `origin/main`; a task that exists only on an open filing branch is refused.

The planner fixed both by hand: edit in a throwaway worktree, commit, lease push under DEC-0264. That works but skips the ASCII, drift and DoR checks `cli-file` runs before anything is committed, which is exactly what the tool exists for.

**Five-step review (requirements first).** Requirement questioned: should a filed task be editable at all before it lands, or should a red filing PR be re-filed? Re-filing is refused (a closed PR is tracked waste, DEC-0266 keeps the never-close rule), so the edit path is required. Deletion: nothing to delete; the hand-edit procedure in the planner memory is retired once this lands. Simplified: one flag, no new subcommand: `cli-file rebase <id> --source <path>` replaces the branch's copy of the task file with the given source and otherwise keeps the in-place rebuild (DEC-0088: lease push of the SAME branch, same PR number, re-armed). Accelerated: the drift and DoR checks run on the corrected source before the commit, so the red is caught locally instead of on the next CI run. Automated last: `--update` additionally accepts a task found on `origin/ai-sdlc/file-<id>` and delegates to the same code path, so a planner that reaches for `--update` out of habit is not refused.

## Acceptance Criteria

- [ ] `cli-file rebase <id> --source <path> --pr` validates the corrected source (ASCII filename, drift, DoR), rebuilds the filing branch in place from current `origin/main` with the corrected file, lease pushes the same branch and keeps the same PR; refused when the source id does not match `<id>`.
- [ ] `cli-file task <path> --update --pr` for a task that exists only on an open filing branch behaves like the rebase above instead of refusing; a task on `origin/main` keeps today's behaviour.
- [ ] Tests cover: corrected source replaces the old content, mismatched id refused, task-on-main unchanged, task-on-branch delegated.
- [ ] `docs/operations/decision-authority.md` (filing section) documents the correction path in one paragraph.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
