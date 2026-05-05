---
id: AISDLC-197
title: >-
  DoR ingress workflow uses 2-dot diff causing ENOENT on
  file-renamed-by-sibling-PR
status: To Do
assignee: []
created_date: '2026-05-05 02:44'
labels:
  - bug
  - ci
  - workflows
  - framework-bug
dependencies: []
references:
  - .github/workflows/ai-sdlc-dor-ingress.yml
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Source

Surfaced on PR #325 (AISDLC-183 frontier filter) at 2026-05-05 02:33:44.

## Problem

The `Evaluate backlog tasks changed by PR` step in `ai-sdlc-dor-ingress.yml` (or wherever the DoR ingress evaluator lives) uses 2-dot diff to enumerate changed files:

```
git diff --name-only $BASE $HEAD
```

When a sibling PR moves a backlog task file (e.g., AISDLC-186 task moved from `backlog/tasks/` → `backlog/completed/` after #322 merged), the 2-dot diff includes that move in the file list — even when the PR under evaluation didn't touch the file.

The workflow then tries to read the OLD path (`backlog/tasks/aisdlc-186 - ...md`) which no longer exists on either side → `ENOENT: no such file or directory` → workflow fails.

## Reproduction
1. Open PR A that doesn't touch backlog/
2. Sibling PR B merges, moving a backlog file from `tasks/` → `completed/`
3. PR A's `Evaluate backlog tasks changed by PR` step fails with ENOENT on the OLD path

## Fix

Use 3-dot diff to scope to PR-side changes only:

```
git diff --name-only $BASE...$HEAD   # 3-dot — only changes on the PR side
```

OR filter the resulting list to files that exist on HEAD before iterating:

```bash
for f in $(git diff --name-only ...); do
  [ -f "$f" ] || continue   # skip deleted/renamed
  evaluate "$f"
done
```

Either approach prevents the ENOENT crash. 3-dot is the cleaner semantic fix.

## Composes with
AISDLC-189 (auto-rebase token) — without auto-rebase firing CI on rebased SHAs, PRs sit BEHIND longer + this race condition is more likely. Now that AISDLC-189 + AI_SDLC_PAT are working, PRs rebase faster and this bug should fire less often, but the underlying workflow gap remains.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 DoR ingress workflow uses 3-dot diff (`$BASE...$HEAD`) OR filters file list to existing files before iterating
- [ ] #2 Test: open a no-op PR + merge a sibling PR that moves a backlog file; verify the no-op PR's DoR step doesn't fail with ENOENT on the moved path
- [ ] #3 Workflow comment block updated with the 2-dot vs 3-dot rationale so future contributors don't re-introduce the bug
<!-- AC:END -->
