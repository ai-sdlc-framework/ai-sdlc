---
id: AISDLC-213
title: 'AISDLC-211 #4 — auto-rebase-open-prs.yml re-arms auto-merge after force-push'
status: In Progress
assignee: []
created_date: '2026-05-06 13:54'
labels:
  - bug
  - ci
  - merge-queue
  - auto-rebase
  - framework-bug
dependencies: []
permittedExternalPaths:
  - '.github/workflows/'
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Decomposed from AISDLC-211 (root cause #4)

When `auto-rebase-open-prs.yml` force-pushes a rebased PR head, GitHub clears the `autoMergeRequest` field. The workflow does NOT re-arm. So even if the rebased SHA passes all checks, the PR sits CLEAN-but-not-queued forever. AISDLC-189 fixed the GITHUB_TOKEN trigger issue but did NOT add the re-arm.

## Fix

Add a step to `auto-rebase-open-prs.yml` after the force-push that re-arms auto-merge IF the PR previously had it armed:

```yaml
- name: Re-arm auto-merge (cleared by force-push)
  if: steps.had_auto_merge.outputs.was_armed == 'true'
  env:
    GH_TOKEN: ${{ secrets.AI_SDLC_PAT }}
  run: gh pr merge ${{ matrix.pr_number }} --auto --rebase
```

The workflow needs to capture the auto-merge state BEFORE the rebase (in a "had_auto_merge" step), then re-arm conditionally after the push. Use `--rebase` per the queue-method-must-differ rule (queue is SQUASH).

## permittedExternalPaths
This task edits `.github/workflows/auto-rebase-open-prs.yml`. Frontmatter needs `permittedExternalPaths: ['.github/workflows/']`.

## Acceptance Criteria
- [ ] #1 `.github/workflows/auto-rebase-open-prs.yml` captures pre-rebase auto-merge state per PR
- [ ] #2 After force-push, re-arms auto-merge with `--auto --rebase` if it was armed before
- [ ] #3 No regression for PRs that did NOT have auto-merge armed (don't accidentally enable it)
- [ ] #4 Comment in the workflow explains the queue-method-must-differ rule + links to AISDLC-211 + feedback memory
<!-- SECTION:DESCRIPTION:END -->
