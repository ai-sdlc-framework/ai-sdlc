---
id: AISDLC-189
title: Auto-rebase workflow uses GITHUB_TOKEN — rebased PR SHAs never trigger CI
status: To Do
assignee: []
created_date: '2026-05-04 20:20'
labels:
  - bug
  - ci
  - merge-queue
  - workflows
dependencies: []
references:
  - .github/workflows/auto-rebase-open-prs.yml
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The `Auto-rebase open PRs on main push` workflow (`.github/workflows/auto-rebase-open-prs.yml`) rebases open PR branches when `main` advances and force-pushes the rebased SHAs. These pushes use the default `GITHUB_TOKEN`, and per GitHub's [recursive-workflow-prevention rule](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow), pushes made by `GITHUB_TOKEN` do NOT trigger downstream workflows.

The result: every Auto-rebase pass leaves the PR's new head SHA with **zero CI runs**. Since `ai-sdlc/pr-ready` is a required status check, the PR sits BLOCKED forever, even though it's MERGEABLE and has auto-merge armed.

## Observed on 2026-05-04

After the history rewrite + PR recreation batch, 11 PRs (#296, #297, #298, #299, #300, #302, #303, #304, #306, #309, #310) all sat BLOCKED with auto-merge armed because Auto-rebase fired ~5 times on main pushes between 19:33 and 20:17 and each pass invalidated their CI without re-firing it. Required manual empty-commit kicks to re-trigger workflows. Cost ~30 min of merge throughput plus operator time.

## Symptom matrix

For each affected PR:
- `mergeStateStatus = BLOCKED` even though `mergeable = MERGEABLE`
- `autoMergeRequest != null` (auto-merge armed)
- `statusCheckRollup` is empty array on the current head SHA
- Older SHAs (from the original PR open / push) have full check history with everything passing
- `gh run list --branch <branch>` shows no runs created after the most recent Auto-rebase push timestamp

## Fix options

1. **Switch token (preferred)**: have Auto-rebase use a GitHub App token (e.g. `actions/create-github-app-token` with a bot installed on the repo) or a fine-scoped PAT stored as a secret. Pushes made with App/PAT credentials DO trigger downstream workflows.

2. **Empty-commit pattern**: have Auto-rebase append a `chore(rebase): empty marker (skip ci marker)` commit (paren-quoted to defeat skip-ci parser) AFTER the rebase, so the second push triggers workflows. Less clean — leaves noise in history.

3. **Workflow_dispatch fan-out**: after rebasing, explicitly invoke `gh workflow run ai-sdlc-gate.yml --ref <branch>` per affected workflow. Brittle (have to enumerate workflows).

Recommend option 1 — it's the GitHub-recommended pattern and one-time setup.

## Risk if unfixed

The merge queue is currently functional only when no PRs need rebasing. As soon as main moves while N PRs are armed-but-not-yet-queued, those N PRs all break and require manual intervention. With the dogfood pipeline targeting unattended ops, this scales badly.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Auto-rebase workflow uses GitHub App token or PAT (not GITHUB_TOKEN) for force-push to PR branches
- [ ] #2 After Auto-rebase fires, all expected workflows (CI, AI-SDLC PR Ready Gate, AI-SDLC Post Review Results, etc.) re-run on the new SHA within 60 seconds
- [ ] #3 Test: open 2 trivial docs-only PRs, queue both, watch one merge → verify the second auto-rebases AND CI re-fires AND it merges without manual intervention
- [ ] #4 Document the App/PAT setup in docs/operations/auto-rebase-token-setup.md including required scopes (contents:write, pull-requests:write) and rotation policy
- [ ] #5 If choosing PAT path: secret added to repo with name AUTO_REBASE_TOKEN, expiration set to 1 year, calendar reminder for rotation
<!-- AC:END -->
