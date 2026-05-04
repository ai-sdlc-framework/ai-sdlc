---
id: AISDLC-187
title: >-
  Reviewer follow-up: AISDLC-178.2 gh-pr-cache pins source-unavailable for 60s
  on transient gh failures
status: To Do
assignee: []
created_date: '2026-05-04 18:36'
labels:
  - bug
  - tui
  - ux
  - reviewer-finding
dependencies: []
references:
  - pipeline-cli/src/tui/sources/gh-pr-cache.ts
  - pipeline-cli/src/tui/sources/gh-pr-cache.test.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Source
Code reviewer on PR #255 (AISDLC-178.2, retro review 2026-05-04) flagged that gh-pr-cache.ts caches errors identically to successful payloads.

## Failure mode
A transient `gh` failure (auth blip, network hiccup, rate-limit) caches the error result with the standard 60s TTL. The TUI shows `source-unavailable` for the full 60s before the next poll retries — even after the underlying issue resolves.

The `r` invalidate keystroke works as escape hatch, so this is more UX nice-to-have than correctness bug.

## Fix
When `result.error` is non-null on a fetch, set `fetchedAt: -Infinity` (or otherwise mark cache as immediately-stale) so the next poll retries immediately rather than waiting for TTL expiry.

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- SECTION:DESCRIPTION:END -->

- [ ] #1 pipeline-cli/src/tui/sources/gh-pr-cache.ts: error results NOT cached for full TTL; next poll retries
- [ ] #2 Test: simulate transient gh failure, verify cache clears + next poll re-fetches
- [ ] #3 Test: successful fetch still respects 60s TTL (no regression)
<!-- AC:END -->
