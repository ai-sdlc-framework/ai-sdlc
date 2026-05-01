---
id: AISDLC-119
title: Tighten backlog-drift husky pre-commit hook to FAIL on errors (not advisory)
status: To Do
assignee: []
created_date: '2026-05-01 16:47'
labels:
  - backlog-drift
  - husky
  - ci
  - tooling
  - task-quality
dependencies: []
references:
  - .husky/pre-commit
  - 'https://github.com/ReliableGenius/backlog.md-drift'
  - >-
    backlog/tasks/aisdlc-117 -
    Compute-backlog-task-dependency-graph-integrate-into-dispatch-frontier.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

The `.husky/pre-commit` hook already runs `npx backlog-drift hook-run` (line 5). It's been in place — but `hook-run` is an advisory mode that warns without exiting non-zero. Result: 223 drift issues accumulated across 152 tasks despite the hook running on every commit (incl. all 12 task creations I did this morning for AISDLC-110-118 + AISDLC-115.x).

## Why this matters

Operator (and Claude) productivity is bottlenecked on accurate task references. Every drift-creating commit costs:
- Future automation cycles (e.g., dependency graph computer in AISDLC-117 needs accurate refs)
- Stakeholder confusion (Alex couldn't find RFC-0011 → because RFCs themselves had drift)
- Operator triage cycles (this morning I duplicated AISDLC-104 dispatch because the dep graph wasn't computed)

A strict pre-commit hook would have failed each of my morning's commits with a clear "fix this" message, forcing me to clean up at the moment of creation rather than accumulating debt.

## Implementation hints

- `backlog-drift check --task <id>` is the strict-mode equivalent of `hook-run` (per CLI help). Use `git diff --cached --name-only --diff-filter=AM 'backlog/tasks/*.md'` to find newly-added/modified task files in the staging area.
- Iterate over each staged task; run `check --task <id>` per task; aggregate exit codes.
- The CI gate (separate from pre-commit) runs `backlog-drift check` on the FULL backlog so post-merge drift is caught at PR time.

## Two follow-up tasks (filed separately when this lands)

- **One-time cleanup of the existing 223 drift issues** — needs human review since some "deleted references" are intentional annotations (e.g., `pipeline-cli/README.md (new)` was a forward-looking placeholder in AISDLC-100.7).
- **Sync project-root bare-repo snapshot to origin/main** — the underlying issue causing many false-positive drift reports today (local snapshot at HEAD `296b7d5` predates many merged PRs).

## Why high-priority

This is the kind of meta-tooling that compounds. Every day without it adds new drift. The fix is small (~10 lines of bash in the husky hook + a CI step) but the leverage is enormous.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `.husky/pre-commit` runs `backlog-drift check` (or equivalent strict mode) on staged backlog/tasks/*.md changes — NOT just `hook-run` advisory mode
- [ ] #2 Hook FAILS the commit (exit non-zero) when a newly-staged or modified task has dangling references (path doesn't exist), invalid dependency IDs, or orphan annotations like `(new)` placeholders that were never replaced
- [ ] #3 Hook output gives a clear actionable error message + the auto-fix command (`backlog-drift fix --task <id>`) so the operator can resolve in one shot
- [ ] #4 Hook performance budget: < 500ms for typical 1-task commit (full repo scan only on `pre-push` or CI, not pre-commit)
- [ ] #5 False-positive escape hatch: `git commit --no-verify` still works (existing behavior); operator can also disable via env var `AI_SDLC_SKIP_DRIFT_GATE=1` for emergencies
- [ ] #6 Add a CI step (in `.github/workflows/ci.yml`) that runs `backlog-drift check` against the FULL backlog so PRs that introduce drift via merge conflicts also fail
- [ ] #7 Existing 223-issue drift backlog requires a one-time human cleanup pass first (file as separate follow-up task; this hook only prevents NEW drift)
- [ ] #8 Documentation in CLAUDE.md `Backlog Workflow` section explaining the hook's strict mode + escape hatches
<!-- AC:END -->
