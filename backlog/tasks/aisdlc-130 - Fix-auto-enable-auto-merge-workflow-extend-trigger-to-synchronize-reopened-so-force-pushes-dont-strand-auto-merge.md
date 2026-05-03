---
id: AISDLC-130
title: >-
  Fix auto-enable-auto-merge workflow: extend trigger to synchronize/reopened so
  force-pushes don't strand auto-merge
status: To Do
assignee: []
created_date: '2026-05-01 23:41'
updated_date: '2026-05-03 00:24'
labels:
  - ci
  - infrastructure
  - auto-merge
  - follow-up
milestone: m-3
dependencies: []
references:
  - .github/workflows/auto-enable-auto-merge.yml
  - spec/rfcs/RFC-0015-autonomous-pipeline-orchestrator.md
priority: high
drift_log:
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      https://github.com/ai-sdlc-framework/ai-sdlc/pull/159
    resolution: flagged
  - date: '2026-05-03'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      https://github.com/ai-sdlc-framework/ai-sdlc/pull/159
    resolution: flagged
drift_checked: '2026-05-03'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Concrete operator-felt gap**: PRs the AI-SDLC pipeline opens have auto-merge enabled at PR creation time, but EVERY subsequent force-push (rebase onto main, attestation re-sign, conflict resolution) silently dismisses GitHub's auto-merge enablement. The existing `auto-enable-auto-merge.yml` workflow only fires on `pull_request: opened`, so the dismissal is never recovered. Result: maintainer must manually merge most pipeline PRs even after CI is green.

**Verified live on PR #159** (AISDLC-123):
- Auto-merge workflow ran successfully when PR was opened (`gh run list --workflow=auto-enable-auto-merge.yml` shows `[success]`)
- After the orchestrator's force-push during finalization, `gh pr view 159 --json autoMergeRequest` returns `null`
- PR sits BLOCKED waiting for human merge despite auto-merge being the operator's intent

**Two-part fix per RFC-0015 Q12 Option C (lean: defense in depth)**:

1. **Workflow trigger extension** (this task): change `.github/workflows/auto-enable-auto-merge.yml` `on.pull_request.types` from `[opened]` to `[opened, synchronize, reopened]`. The `gh pr merge --auto` call is idempotent — no-op if already enabled.
2. **Orchestrator-side call** (deferred to RFC-0015 implementation): the orchestrator's finalize sequence (per RFC-0015 §5.2 state machine FINALIZING transition) calls `gh pr merge --auto --rebase <pr>` after every push. Catches edge cases the workflow misses (force-push from a worktree the workflow can't see, restart-recovery, etc.).

**Important policy note**: setting `--auto` is NOT merging. Per CLAUDE.md "Never merge PRs", the rule is about the merge actor (must be GitHub once preconditions are met, never Claude clicking the button). `gh pr merge --auto --rebase` sets the flag; GitHub merges. This is fine.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `.github/workflows/auto-enable-auto-merge.yml` `on.pull_request.types` extended to `[opened, synchronize, reopened]`
- [ ] #2 Workflow body verified idempotent — no error on already-enabled auto-merge (test by manually re-running on a PR that already has auto-merge)
- [ ] #3 Verify on a fresh PR: open → workflow enables auto-merge → force-push → workflow re-fires → auto-merge re-enabled (no manual action needed)
- [ ] #4 Update CLAUDE.md "Auto-merge" section (or add one if missing) noting the workflow now self-heals after force-pushes; clarify the policy distinction between setting the flag (allowed) and merging (forbidden)
- [ ] #5 If gh CLI's `--auto` exits non-zero on already-enabled (rather than no-op), wrap the call to swallow the specific exit code so the workflow doesn't false-fail
<!-- AC:END -->
