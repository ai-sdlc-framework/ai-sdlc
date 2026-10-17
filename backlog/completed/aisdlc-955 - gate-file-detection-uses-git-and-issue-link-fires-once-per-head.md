---
id: AISDLC-955
title: >-
  Gate file detection uses git instead of the API, and require-issue-link fires
  once per head with a concurrency group
status: In Progress
assignee: []
created_date: '2026-10-16'
labels:
  - ci
  - cost
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
drift_log:
  - date: '2026-10-17'
    type: ref-deleted
    detail: 'Referenced file no longer exists: .github/workflows/require-issue-link.yml'
    resolution: flagged
drift_checked: '2026-10-17'
---

## Description

Two smaller consumers of the Actions GITHUB_TOKEN bucket run on every PR event. The `Detect Changes` job of `ai-sdlc-gate.yml` runs `dorny/paths-filter` three times, and each invocation lists the PR files through the API (3 or more calls per run) although the job checks out with `fetch-depth: 0`. `require-issue-link.yml` runs on seven `pull_request_target` types including `labeled`, `unlabeled` and `edited`, has no concurrency group, pages the file list 30 at a time, and posts a status: every label flip or body edit by an agent costs another run.

**Five-step review (requirements first).**
1. Requirement questioned: does file detection need the API? No, the checkout already has the history; dorny diffs with git when given `token: ""` (or a `base:`). Does the issue-link check need to run on label and edit events? No, the linked-issue line lives in the body; a body `edited` event is the only non-head event that can change the verdict.
2. Delete: the API token on the three dorny steps; the `labeled` and `unlabeled` trigger types.
3. Simplify: one concurrency group per PR on `require-issue-link.yml` with cancel-in-progress; `per_page=100` on its file listing.
4. Accelerate: nothing further; each gate run drops at least 3 calls and each label change drops a run.
5. Automate: the workflow lint test that already reads trigger types asserts the two workflows carry a concurrency group and that no dorny step passes a token.

## Acceptance Criteria

- [ ] The three `paths-filter` steps diff with git; the job log shows no `pulls/<n>/files` request.
- [ ] `require-issue-link.yml` runs on `opened`, `synchronize`, `reopened`, `ready_for_review`, `edited` only, under a per-PR concurrency group, with 100 files per page.
- [ ] `docs/operations/quality-gate.md` notes both changes.
