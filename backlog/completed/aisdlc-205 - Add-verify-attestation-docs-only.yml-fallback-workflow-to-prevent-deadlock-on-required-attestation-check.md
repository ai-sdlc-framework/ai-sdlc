---
id: AISDLC-205
title: >-
  Add verify-attestation-docs-only.yml fallback workflow to prevent deadlock on
  required attestation check
status: Done
assignee: []
created_date: '2026-05-05 21:50'
labels:
  - bug
  - ci
  - attestation
  - framework-bug
  - urgent
dependencies: []
references:
  - .github/workflows/verify-attestation.yml
  - >-
    backlog/completed/aisdlc-193 -
    Re-enable-attestation-as-required-merge-gate-design-rebase-stable-HEAD-content-binding.md
priority: high
drift_log:
  - date: '2026-05-06'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      .github/workflows/ai-sdlc-review-docs-only.yml
    resolution: flagged
drift_checked: '2026-05-06'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

On 2026-05-05 (incident on PR #333) `ai-sdlc/attestation` was added as a required status check on `main` (per AISDLC-193 stage 1 + the operator's directive: "the attestation should be required for PR's to merge if it changes any code paths"). But `verify-attestation.yml` has `paths-ignore` that skips the workflow on docs-only PRs:

```yaml
paths-ignore:
  - 'spec/rfcs/**'
  - 'docs/**'
  - 'backlog/tasks/**'
  - 'backlog/completed/**'
  - '*.md'
```

Net: docs-only PRs (RFC drafts, backlog edits, READMEs, task lifecycle moves) DO NOT post the `ai-sdlc/attestation` status. With the gate now required, these PRs are permanently UN-MERGEABLE without manual `gh api repos/.../statuses/<sha>` intervention to post the success status by hand.

## Reproducer

PR #333 (AISDLC-180 lifecycle close — single file rename from `backlog/tasks/` to `backlog/completed/`):
- All non-attestation required checks pass: `codecov/patch`, `Backlog Drift`, `ai-sdlc/pr-ready`
- `verify-attestation.yml` skipped (paths-ignore matches `backlog/completed/**`)
- `ai-sdlc/attestation` status never posted → required check stays missing → PR `mergeStateStatus: BLOCKED`
- Operator unblocked manually via:
  ```bash
  gh api "repos/ai-sdlc-framework/ai-sdlc/statuses/<sha>" -X POST \
    -f state=success \
    -f context="ai-sdlc/attestation" \
    -f description="docs-only PR — attestation N/A, manual fallback"
  ```

## Fix

Mirror the existing AISDLC-136 pattern (`.github/workflows/ai-sdlc-review-docs-only.yml`) with a new workflow that:

1. Triggers on every `pull_request` (NO paths-ignore — it must fire for both code AND docs PRs)
2. Detects whether all changed files match the docs-only `paths-ignore` predicate (same pattern as `verify-attestation.yml`'s ignore list)
3. If docs-only: posts `ai-sdlc/attestation: success` directly via `repos/.../statuses/<sha>` — same recovery the existing `Post Review Results (docs-only)` workflow does for its analogous required check
4. If mixed (any non-docs file): exits cleanly. The regular `verify-attestation.yml` will fire and post the real attestation result.

Suggested filename: `.github/workflows/verify-attestation-docs-only.yml`

## Why this exists separately

The pattern is identical to AISDLC-136's `ai-sdlc-review-docs-only.yml` and the rationale text in that workflow header is the canonical reference. It can be near-verbatim copy with two changes:
- Status context: `ai-sdlc/attestation` (not `Post Review Results`)
- Description text: clarify "docs-only PR — attestation N/A"

## Related

- AISDLC-193 — re-enable attestation as required merge gate (this task closes the docs-only deadlock that AISDLC-193 stage 1 created)
- AISDLC-136 — analogous docs-only fallback for `Post Review Results` (reference implementation)

## Severity

**High / urgent.** Every docs-only PR going forward will deadlock until this lands. That includes every backlog task lifecycle close (status flip + file move), every RFC update, every CLAUDE.md tweak, every operator runbook edit. The operator can manually post the status as a one-off escape hatch but doing this on every doc PR is unsustainable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 New workflow `.github/workflows/verify-attestation-docs-only.yml` exists, triggered on `pull_request: [opened, synchronize, reopened]` against `main` with NO `paths-ignore` filter
- [ ] #2 Workflow detects docs-only changesets using the same pattern as `verify-attestation.yml`'s `paths-ignore` (`spec/rfcs/`, `docs/`, `backlog/tasks/`, `backlog/completed/`, root `*.md`)
- [ ] #3 For docs-only PRs: posts `ai-sdlc/attestation: success` via `repos/.../statuses/<sha>` API call with description `"docs-only PR — attestation N/A"`
- [ ] #4 For mixed PRs (any non-docs file): exits cleanly without posting (lets `verify-attestation.yml` handle it)
- [ ] #5 Concurrency group shares with `verify-attestation.yml` so the two don't race on mixed PRs
- [ ] #6 Permissions: `statuses: write`, `contents: read`, `pull-requests: read`
- [ ] #7 Smoke test: open a docs-only test PR, verify `ai-sdlc/attestation: success` posts within 60s and PR becomes mergeable without manual intervention
- [ ] #8 Smoke test: open a code PR (e.g., touching a `.ts` file), verify this workflow exits cleanly and `verify-attestation.yml` runs as before
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped via PR #334 (ci: add verify-attestation-docs-only.yml fallback to prevent docs-only deadlock). This lifecycle close was missed by the original PR (per AISDLC-203 — Codex/automation workflow doesn't atomically complete tasks); batched into chore/backlog-sync 2026-05-05.
<!-- SECTION:FINAL_SUMMARY:END -->
