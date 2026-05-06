---
id: AISDLC-192
title: >-
  auto-enable-auto-merge.yml: pass --squash so auto-merge method differs from
  queue's REBASE
status: Done
assignee: []
created_date: '2026-05-04 21:45'
labels:
  - bug
  - ci
  - merge-queue
  - workflows
  - framework-bug
dependencies: []
references:
  - .github/workflows/auto-enable-auto-merge.yml
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem (root cause confirmed 2026-05-04)

`.github/workflows/auto-enable-auto-merge.yml` runs `gh pr merge --auto "${{ github.event.pull_request.number }}"` with no merge method flag. PR #292 dropped `--rebase` from this workflow under the assumption that "no method" would let the queue choose. **It doesn't.**

Empirically observed on PRs #311 + #312 (both opened AFTER #292 merged):
- Workflow ran, `gh pr merge --auto` succeeded
- Result: `autoMergeRequest.mergeMethod = REBASE` (not null)
- PRs sat stuck at `mergeStateStatus: UNSTABLE`, never entered the queue
- Fix: manually `gh pr merge --disable-auto && gh pr merge --auto --squash` → entered queue immediately

## Why "no method" still results in REBASE

When `gh pr merge --auto` is invoked without an explicit method, gh CLI falls back to the **viewer's default merge method** (`repository.viewerDefaultMergeMethod` GraphQL field). For the GitHub Actions bot on this repo, that value is **REBASE** because:

```
mergeCommitAllowed: false
rebaseMergeAllowed: true     ← ONLY method allowed on the repo
squashMergeAllowed: false
```

The repo policy "only REBASE merges allowed" cascades into every viewer's default. So `gh pr merge --auto` always sets REBASE → conflicts with the queue's REBASE config (per the failure mode #292 documented) → queue silently rejects the PR.

## Fix

Update `.github/workflows/auto-enable-auto-merge.yml` to pass `--squash` explicitly:

```yaml
run: gh pr merge --auto --squash "${{ github.event.pull_request.number }}"
```

The `--squash` is set in the auto-merge state, but **the merge queue's `mergeMethod: REBASE` config overrides it** at merge time (verified empirically on PRs #311 + #312 just now). Net effect:
- Auto-merge state: `mergeMethod: SQUASH` (non-conflicting with queue)
- GitHub recognizes the mismatch and falls through to the queue
- Queue rebases per its own config
- Linear history is preserved (no squash actually happens)

## Why not enable SQUASH on the repo settings instead?

Would conflict with the project policy of "always rebase, keep linear history" by exposing the SQUASH option in the merge button to humans. Keeping squash off at the repo level + passing `--squash` only at the auto-merge arming layer is the right scope (it's a workaround for GitHub's "method must differ from queue" semantic, not a policy change).

## Verification plan

After the workflow update lands:
1. Open a trivial docs-only PR
2. Verify `gh pr view <pr> --json autoMergeRequest --jq .autoMergeRequest.mergeMethod` returns `SQUASH`
3. Verify the PR enters the queue automatically once required checks pass (no manual intervention)
4. Verify the merge commit on main has a single parent (rebase, not squash)

## Composes with AISDLC-189

AISDLC-189 (Auto-rebase workflow uses GITHUB_TOKEN) covers a different workflow (`auto-rebase-open-prs.yml`) but related symptom (PRs stuck BLOCKED). Both should ship together to fully unbreak the auto-merge path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 auto-enable-auto-merge.yml passes `--squash` explicitly in the gh pr merge invocation
- [ ] #2 Comment block in the workflow updated to explain WHY --squash is needed (point at viewerDefaultMergeMethod + REBASE-only repo policy + queue method-mismatch fall-through)
- [ ] #3 Test plan: open a trivial new PR, verify autoMergeRequest.mergeMethod reports SQUASH, then verify the PR enters the merge queue without manual disable+re-enable
- [ ] #4 Test plan: verify the merged commit on main is single-parent (rebase happened, squash did not)
- [ ] #5 CHANGELOG entry under [Unreleased] noting the fix
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped via PR #329 (ci flip auto-merge flag to --rebase after queue switched to SQUASH). This lifecycle close was missed by the original PR (per AISDLC-203 — Codex/automation workflow doesn't atomically complete tasks); batched into chore/backlog-sync 2026-05-05.
<!-- SECTION:FINAL_SUMMARY:END -->
