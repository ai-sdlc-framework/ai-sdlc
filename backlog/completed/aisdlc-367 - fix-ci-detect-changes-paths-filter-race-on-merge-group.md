---
id: AISDLC-367
title: 'fix(ci): Detect Changes paths-filter races merge_group ephemeral branch deletion'
status: Done
assignee: []
created_date: '2026-05-18'
labels:
  - ci
  - merge-queue
  - critical
  - hotfix
dependencies: []
priority: critical
references:
  - .github/workflows/ci.yml
---

## Problem

Operator observation 2026-05-18: every merge-queue probe for code PRs has been failing CI for ~2 hours with NO visible test failures. Investigation showed the failure is at the very first job, **Detect Changes** (paths-filter@v3 step), not at any test.

paths-filter runs `git fetch --no-tags --depth=100 origin main gh-readonly-queue/main/pr-XXX-<sha>` to get the diff base. The ephemeral queue branch (`gh-readonly-queue/...`) is deleted by GitHub the instant the queue advances to the next PR — which often happens BEFORE paths-filter's fetch completes. Result: `fatal: couldn't find remote ref gh-readonly-queue/main/pr-XXX-<sha>` → exit 128 → CI job fails → queue marks the PR UNMERGEABLE → operator has to re-arm → repeat.

This locked the queue for 8 PRs (#543, #544, #546, #547, #548, #549, #550) over a 2-hour window with only 1 docs-only PR (#545) able to land between dequeue/rearm cycles.

## Fix

In `.github/workflows/ci.yml`'s `changes` job:

1. **Skip paths-filter on `merge_group` events** — the ephemeral branch deletion race is unique to merge_group. Pull-request + push events still get filtered normally.
2. **Add a `fallback` step** that fires only on merge_group and force-sets `python=true` + `go=true`, so downstream `Test Python SDK` / `Test Go SDK` jobs run unconditionally on merge_group probes (same effective behavior as a paths-changed=true result; no test gets silently skipped).
3. **Add `fetch-depth: 0`** to `actions/checkout@v4` so paths-filter can diff locally on push/PR events without remote fetches (defense-in-depth even though the merge_group path skips the action entirely).

## Acceptance criteria

- [ ] `Detect Changes` job no longer fails on `merge_group` events (queue probes complete the changes step in <5s without git-fetch)
- [ ] `Test Python SDK` + `Test Go SDK` continue to run on merge_group regardless of paths-changed status (no silent skip)
- [ ] On `pull_request` + `push` events, paths-filter still runs and gates SDK tests correctly
- [ ] All 8 stuck PRs (#543, #544, #546, #547, #548, #549, #550) merge through the queue once this lands

## Source

Operator session 2026-05-18: investigated "flaky worktree-pool tests" hypothesis, discovered the actual root cause was paths-filter racing the queue branch deletion.
