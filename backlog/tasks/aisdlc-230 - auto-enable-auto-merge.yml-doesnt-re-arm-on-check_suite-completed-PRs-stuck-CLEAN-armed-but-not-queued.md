---
id: AISDLC-230
title: >-
  auto-enable-auto-merge.yml doesn't re-arm on check_suite.completed — PRs stuck
  CLEAN+armed but not queued
status: To Do
assignee: []
created_date: '2026-05-07 21:30'
labels:
  - bug
  - ci
  - merge-queue
  - framework-bug
  - dogfood
dependencies: []
priority: medium
references:
  - .github/workflows/auto-enable-auto-merge.yml
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`auto-enable-auto-merge.yml` only triggers on `pull_request` events (`opened`, `synchronize`, `reopened`, `ready_for_review`). It does NOT trigger on check-completion events (`check_suite.completed`, `status`).

Failure mode witnessed empirically by operator over multiple sessions (2026-05 dogfood):

1. PR opens → workflow fires → `gh pr merge --auto` arms auto-merge while CI is still BLOCKED
2. GitHub records auto-merge with current head SHA, but the PR isn't mergeable yet
3. CI eventually completes → PR transitions to CLEAN
4. **No event re-triggers GitHub's queue-admission logic** — auto-merge state goes stale
5. PR sits CLEAN+armed indefinitely, never enters the merge queue
6. Operator must manually run `gh pr merge --disable-auto && gh pr merge --auto` to force fresh evaluation, after which the PR queues immediately

This is most reproducible after force-pushes (attestation re-sign, rebase) or after a check transitions through fail→pass→fail→pass — the auto-merge state caches stale and only a fresh arm operation recovers it.

## Why this matters

The framework's autonomous pipeline goal (RFC-0015 + the operator-TUI vision) requires hands-off PR landing. With this gap, operators must babysit PRs after each push, manually re-arming auto-merge to nudge them into the queue. That defeats automation.

## Proposed fix

### 1. Add `check_suite.completed` (and optionally `status`) triggers to the workflow

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  check_suite:
    types: [completed]
  status: {}
```

When a check_suite completes (CI batch finishes), the workflow re-fires. It then re-evaluates the PR and re-arms auto-merge if needed.

### 2. Use disable+re-enable cycle instead of bare `--auto` arm

The bare `gh pr merge --auto` is idempotent ("already enabled"), so calling it again does nothing if state is stale. The disable+re-enable cycle forces GitHub to re-evaluate from scratch:

```yaml
- name: Refresh auto-merge (force re-evaluation)
  run: |
    gh pr merge --disable-auto "$PR_NUMBER" 2>/dev/null || true
    gh pr merge --auto "$PR_NUMBER"
```

### 3. Discover the PR number when triggered by `check_suite` / `status`

These events don't directly include a PR number. Need a lookup step to find the PR(s) associated with the head SHA:

```yaml
- name: Find PR for head SHA
  id: find-pr
  run: |
    PR=$(gh api "/repos/${{ github.repository }}/commits/${{ github.event.check_suite.head_sha || github.sha }}/pulls" --jq '.[] | select(.state == "open") | .number' | head -1)
    echo "pr=$PR" >> "$GITHUB_OUTPUT"
```

If multiple PRs share a head SHA (rare), iterate.

### 4. Maintain the existing same-repo guard

```yaml
if: >-
  github.event.pull_request.draft == false &&
  github.event.pull_request.head.repo.full_name == github.repository
```

Adapt for the new event types — check_suite events need a different shape (look up the PR's draft/fork state via the API after finding the PR number).

## Acceptance Criteria

- [ ] #1 Workflow triggers expanded to include `check_suite.completed` and `status` events
- [ ] #2 `enable-auto-merge` job uses `--disable-auto && --auto` cycle to force GitHub re-evaluation, not just bare `--auto`
- [ ] #3 PR number is correctly discovered when triggered by check_suite/status (using `/repos/.../commits/<sha>/pulls` lookup)
- [ ] #4 Same-repo guard (no fork PRs) and non-draft guard preserved across all trigger paths
- [ ] #5 Hermetic test or integration test verifies the workflow re-fires on check_suite completion (can be a dogfood observation: open a PR, wait for CI, verify queue admission happens automatically)
- [ ] #6 Operator runbook updated at `docs/operations/quality-gate.md` (or equivalent) describing the auto-arming behavior + the manual disable+re-enable workaround as a fallback for any remaining edge cases
- [ ] #7 No regression on the existing happy path: PR opens → CI passes → queue admits

## References

- `.github/workflows/auto-enable-auto-merge.yml` (the workflow this fixes)
- AISDLC-221 (drop --rebase flag — closely related auto-merge work)
- AISDLC-130 (idempotent --auto invocation rationale — still valid, but doesn't address the staleness issue this task tackles)
- Witnessed dogfood incidents 2026-05-07: PR #392 sat CLEAN+armed during PR #391's queue processing; the operator reported needing the disable+re-enable workaround across multiple PRs in earlier sessions
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Workflow triggers expanded to include check_suite.completed + status events
- [ ] #2 enable-auto-merge job uses --disable-auto && --auto cycle to force re-evaluation
- [ ] #3 PR number correctly discovered when triggered by check_suite/status
- [ ] #4 Same-repo + non-draft guards preserved across trigger paths
- [ ] #5 Hermetic / integration test verifies workflow re-fires on check_suite completion
- [ ] #6 Operator runbook updated describing auto-arming behavior + manual fallback
- [ ] #7 No regression on the existing happy path (PR open → CI → queue admit)
<!-- SECTION:ACCEPTANCE:END -->
