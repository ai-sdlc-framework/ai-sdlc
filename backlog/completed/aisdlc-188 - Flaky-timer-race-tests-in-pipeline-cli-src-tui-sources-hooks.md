---
id: AISDLC-188
title: Flaky timer-race tests in pipeline-cli/src/tui/sources/* hooks
status: Done
assignee: []
created_date: '2026-05-04 20:10'
labels:
  - bug
  - tests
  - flake
  - rfc-0023
  - tui
dependencies: []
references:
  - pipeline-cli/src/tui/sources/events-tail.test.ts
  - pipeline-cli/src/tui/sources/backlog-walker.test.ts
  - pipeline-cli/src/tui/sources/gh-pr-cache.test.ts
  - spec/rfcs/RFC-0023-operator-tui-pipeline-monitoring.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Three TUI data-source hook tests in `pipeline-cli/src/tui/sources/` race on cold CI runners. They were added in PR #255 (AISDLC-178.2 — RFC-0023 Phase 2 TUI data sources). The same test code passes on `main` but fails reliably on freshly-created PR runs that share the same CI runner pool capacity (observed during the post-history-rewrite PR-recreation batch on 2026-05-04, where 7 of 14 recreated PRs failed CI on these tests until reruns).

## Failing tests + observed assertions

1. **`pipeline-cli/src/tui/sources/events-tail.test.ts:184`** — `useEvents (hook) > fetches once on mount + every intervalMs tick`
   - `AssertionError: expected +0 to be 1` (timer didn't fire within poll window)

2. **`pipeline-cli/src/tui/sources/backlog-walker.test.ts:268`** — `useBacklogTasks (hook) > surfaces walker errors via state.error`
   - `AssertionError: expected null to be 'source-permission-denied'` (error promise hadn't resolved into state by assertion)

3. **`pipeline-cli/src/tui/sources/gh-pr-cache.test.ts:?`** — `useGhPrs (hook) > surfaces fetcher errors via state.error`
   - `AssertionError: expected null to be 'source-unavailable'` (same shape — error not yet propagated to hook state)

## Hypothesis

All three are React-hook tests that use `vi.useFakeTimers()` + `act(...)` to drive timer ticks and rely on Promise microtasks resolving before the next assertion. On cold CI runners (especially when 14+ workflow jobs spin up at once and contend for CPU), the microtask flush after `vi.advanceTimersByTime(...)` takes longer than the test expects, leaving state in its initial null/0 form when the assertion fires.

The fix is one of:
- Switch from `vi.advanceTimersByTime` to `await vi.advanceTimersByTimeAsync(...)` so the test awaits the microtask flush
- Wrap assertions in `await waitFor(() => ...)` from `@testing-library/react`
- Use `act(async () => { ... })` around the timer advance and await it

## Recreation steps

```bash
cd pipeline-cli
# Run the three test files in a tight loop on a CPU-constrained machine:
for i in 1 2 3 4 5; do
  pnpm test:coverage src/tui/sources/events-tail.test.ts src/tui/sources/backlog-walker.test.ts src/tui/sources/gh-pr-cache.test.ts || echo "FAIL on iter $i"
done
```

## Why this matters

The three tests are required-status-check inputs (Coverage workflow → `ai-sdlc/pr-ready` rollup). When they flake, the entire merge gate fails and PRs sit BLOCKED until someone manually re-runs CI. With the merge queue enabled, this multiplies the cost: every queued PR re-runs the same flaky tests against the queue tip.

The 2026-05-04 PR-recreation batch lost ~30 min of merge throughput to manual reruns specifically on these tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All three test files (events-tail.test.ts, backlog-walker.test.ts, gh-pr-cache.test.ts) pass reliably across 50 consecutive CI runs (use the rerun loop in the description to confirm locally)
- [ ] #2 Root cause documented in the test file as a one-line comment explaining why awaiting the microtask flush is required (so future contributors don't re-introduce the bug)
- [ ] #3 If the fix uses `vi.advanceTimersByTimeAsync` or `waitFor`, all other timer-driven hook tests in pipeline-cli are audited for the same pattern and updated for consistency
- [ ] #4 No coverage regression on the three test files (each must still cover the timer-tick + error-state branches)
<!-- AC:END -->
