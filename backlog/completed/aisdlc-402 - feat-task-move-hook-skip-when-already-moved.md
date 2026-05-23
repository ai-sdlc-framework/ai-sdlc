---
id: AISDLC-402
title: 'fix(hooks): check-task-moved.sh skip silently when file already in backlog/completed/'
status: In Progress
labels: [hooks, operator-merge, throughput]
references:
  - scripts/check-task-moved.sh
  - .husky/pre-push
priority: medium
permittedExternalPaths: []
---

## Description

`scripts/check-task-moved.sh` runs on every push, detects `(AISDLC-N)` in commit subjects, and moves `backlog/tasks/aisdlc-N.md` → `backlog/completed/`. Even when the dev subagent already moved the file (the `/ai-sdlc execute` path), the hook still generates a chore commit (with "already in backlog/completed/ — skipping" message) AND returns exit 1 so operator must re-push. Operator architectural review (2026-05-23) chose option B: skip silently when file is already moved, eliminating the double-push for 95%+ of PRs.

## Acceptance criteria

- [x] AC-1: `scripts/check-task-moved.sh` checks `git ls-files backlog/completed/aisdlc-${TASK_ID}.md` (or equivalent) BEFORE attempting the move. If the file is already tracked under `backlog/completed/`, exit 0 silently (no chore commit, no exit-1, no log noise).
- [x] AC-2: External contributor path (file still in `backlog/tasks/`) continues to work unchanged — hook detects + moves + commits chore + exits 1 to force re-push.
- [x] AC-3: Hermetic test at `scripts/check-task-moved.test.mjs` — add cases: (a) file already in completed/ → silent no-op, exit 0; (b) file in tasks/ → moved, chore committed, exit 1; (c) no AISDLC-N in commits → no-op.
- [x] AC-4: Update CLAUDE.md "Hooks" section to note the silent-skip behavior.
- [ ] AC-5: Verify the integration: push a worktree where the dev already moved the file — confirm zero chore commits + push proceeds first-try (no re-push needed).

## Out of scope

- Removing the hook entirely (operator chose B over D; keep safety net for external contributors).
- Refactoring the hook's other behaviors.

## References

- Operator architectural review 2026-05-23 (OQ-3)
- AISDLC-220 (original hook ship)

## Estimated effort

30 min - 1 hour.
