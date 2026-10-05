---
id: AISDLC-727
title: >-
  CI runs once per pull request: retire the duplicate workflow on PRs and the auto-rebase cascade
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - ci
  - governance
dependencies: []
references:
  - .github/workflows/ci.yml
  - .github/workflows/auto-rebase-open-prs.yml
  - .github/workflows/auto-rebase-on-queue-kick.yml
  - .github/workflows/auto-rearm-on-dequeue.yml
  - docs/operations/merge-without-queue.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two workflow files run the same lint, build, test, coverage and integration jobs on every pull request; one feeds the required `ai-sdlc/pr-ready` check, the other (`.github/workflows/ci.yml`) produces a non-required result. Separately, `.github/workflows/auto-rebase-open-prs.yml` rebases the other open pull requests after every merge; each rebase restarts CI, cancels runs in flight and disarms auto-merge. The up-to-date requirement on main is already off, so those rebases are not needed to merge. Sample of 50 pull requests: about 37 workflow runs each, 343 cancelled runs, auto-merge enabled 392 times and disabled 353 times. Decided in DEC-0056 (rows 1 and 5).

The workflow edits in this task land after the operator's agent-role config edit is on main.

## Conventions
- Hermetic tests; temporary directories come from `mkdtemp`.
- CLAUDE.md edits are authorized for the CI behaviour section only.

## Acceptance Criteria
- [ ] `ci.yml` no longer runs on pull request events and keeps running on pushes to main. Before the change, the jobs in both files are listed in the PR; any job that exists only in `ci.yml` is moved into the gate workflow first.
- [ ] `auto-rebase-open-prs.yml` is deleted. A pull request is rebased only when it conflicts, by its executor or the conflict-resolver agent. Agent and command instructions that rely on the automatic rebase are updated.
- [ ] `auto-rebase-on-queue-kick.yml` and `auto-rearm-on-dequeue.yml` are checked against the fact that the merge queue was dropped; each is deleted if nothing can trigger it, or kept with a one-line reason in the PR.
- [ ] Workflow tests under `.github/workflows/__tests__/` are updated; a test asserts that exactly one workflow runs the suite on pull request events.
- [ ] `scripts/check-skip-ci-marker.sh` and `scripts/check-backlog-ascii.sh` are documented as enforced but are not called from any hook or workflow: either wire each into the commit-msg or pre-commit hook (they are fast) or correct the documentation; say which and why in the PR.
- [ ] Docs (`docs/operations/merge-without-queue.md`, CLAUDE.md CI behaviour section; this task authorizes that CLAUDE.md edit, limited to that section) describe the result.
- [ ] PR body carries a "Velocity impact" section with workflow runs per pull request before and after, measured on at least five pull requests.

## Out of scope
- The cancelled-duplicate display issue filed separately.
- Required-check changes other than those decided elsewhere.
<!-- SECTION:DESCRIPTION:END -->
