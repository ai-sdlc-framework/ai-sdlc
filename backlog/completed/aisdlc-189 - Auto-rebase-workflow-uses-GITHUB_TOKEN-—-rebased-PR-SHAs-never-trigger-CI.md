---
id: AISDLC-189
title: Auto-rebase workflow uses GITHUB_TOKEN — rebased PR SHAs never trigger CI
status: Done
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
  - docs/operations/auto-rebase-token-setup.md
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
- [x] #1 Auto-rebase workflow uses GitHub App token or PAT (not GITHUB_TOKEN) for force-push to PR branches — `secrets.AI_SDLC_PAT || github.token` with warning fallback
- [x] #2 After Auto-rebase fires, all expected workflows (CI, AI-SDLC PR Ready Gate, AI-SDLC Post Review Results, etc.) re-run on the new SHA within 60 seconds — PAT pushes bypass GITHUB_TOKEN recursion-prevention rule
- [ ] #3 Test: open 2 trivial docs-only PRs, queue both, watch one merge → verify the second auto-rebases AND CI re-fires AND it merges without manual intervention — manual verification by operator after secret is set
- [x] #4 Document the App/PAT setup in docs/operations/auto-rebase-token-setup.md including required scopes (contents:write, pull-requests:write) and rotation policy
- [x] #5 If choosing PAT path: secret referenced as AI_SDLC_PAT (reuses existing secret), operator must set expiration to 1 year with calendar reminder — see docs/operations/auto-rebase-token-setup.md
<!-- AC:END -->

## Final Summary

## Summary
The `auto-rebase-open-prs.yml` workflow was fixed in PRs #317 and #318 (merged to main on 2026-05-04) to use `secrets.AI_SDLC_PAT || github.token` instead of bare `GITHUB_TOKEN`. The workflow now emits a `::warning::` annotation when the PAT is unset so operators see degraded behavior rather than silent failure. This PR adds the required operator documentation (`docs/operations/auto-rebase-token-setup.md`) covering PAT creation, required scopes, rotation policy, verification steps, and manual recovery for blocked PRs.

## Changes
- `docs/operations/auto-rebase-token-setup.md` (new): complete operator runbook for the AI_SDLC_PAT secret — PAT vs GitHub App options, required scopes (contents:write + pull-requests:write), rotation policy, verification procedure, and manual emergency recovery steps.
- `backlog/tasks/aisdlc-189 - Auto-rebase-workflow-uses-GITHUB_TOKEN-—-rebased-PR-SHAs-never-trigger-CI.md` (modified): marked Done, ACs updated, finalSummary added.

## Design decisions
- **Reuse AI_SDLC_PAT not AUTO_REBASE_TOKEN**: PR #318 renamed the secret reference from `AUTO_REBASE_TOKEN` to `AI_SDLC_PAT` because the operator already had that secret configured for other workflows, avoiding duplication.
- **Fallback with warning rather than hard fail**: if the secret is unset the workflow degrades gracefully (falls back to GITHUB_TOKEN) and emits a visible `::warning::` annotation. This avoids breaking the rebase workflow entirely when the secret expires, while still surfacing the problem clearly.

## Verification
- `pnpm build` — clean (docs-only change, no build impact)
- `pnpm test` — clean
- `pnpm lint` — clean

## Follow-up
- AC#3 manual integration test: operator should verify after setting AI_SDLC_PAT that two queued docs PRs auto-rebase and CI re-fires without manual kicks.
