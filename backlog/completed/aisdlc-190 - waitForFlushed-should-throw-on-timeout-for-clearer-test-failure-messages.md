---
id: AISDLC-190
title: waitForFlushed should throw on timeout for clearer test failure messages
status: Done
assignee: []
created_date: '2026-05-04 21:12'
labels:
  - enhancement
  - tests
  - developer-experience
  - rfc-0023
  - tui
  - reviewer-finding
dependencies: []
references:
  - pipeline-cli/src/tui/sources/events-tail.test.ts
  - pipeline-cli/src/tui/sources/backlog-walker.test.ts
  - pipeline-cli/src/tui/sources/gh-pr-cache.test.ts
  - pipeline-cli/src/tui/sources/dep-snapshot-reader.test.ts
  - pipeline-cli/src/tui/sources/orchestrator-status.test.ts
priority: low
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Source

Reviewer follow-up from AISDLC-188 (suggestion-severity, code-reviewer + test-reviewer both flagged).

## Problem

The `waitForFlushed(predicate, attempts=50)` helper introduced in AISDLC-188 returns silently when the predicate is never satisfied within 50 setImmediate round-trips. The next `expect()` then fires with the stale value and produces an assertion error like `expected 0 to be 1` — diagnostic, but one step removed from the actual root cause (predicate timeout).

If a future contributor passes a never-true predicate (typo, refactored hook signature, etc.), the failure message will be cryptic. A clean `Error: waitForFlushed: predicate not satisfied after 50 attempts` would point straight at the helper rather than the downstream assertion.

## Fix

Update `waitForFlushed` in all 5 sibling files (events-tail.test.ts, backlog-walker.test.ts, gh-pr-cache.test.ts, dep-snapshot-reader.test.ts, orchestrator-status.test.ts) to throw on timeout:

```ts
async function waitForFlushed(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitForFlushed: predicate not satisfied after ${attempts} attempts`);
}
```

## Why this matters

The 5 test files run on every PR's Coverage workflow. Improving the error message reduces operator time-to-diagnosis when a future test is mis-written. ~10 LOC across 5 files. Trivial fix; deferred from AISDLC-188 because the original task scope was the race-condition fix, not helper UX.

## Optional companion

If a 6th hook test ever lands, lift `waitForFlushed` to a shared utility under `pipeline-cli/src/tui/sources/__test-helpers__/` (test-reviewer also flagged this as a "consider when N≥6" suggestion). Don't pre-emptively extract per the project's "three similar lines beat one wrong abstraction" rule.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 waitForFlushed in all 5 modified test files (events-tail, backlog-walker, gh-pr-cache, dep-snapshot-reader, orchestrator-status) throws on timeout instead of returning silently
- [ ] #2 Test failure message names the helper + attempts-exhausted condition (verifiable: temporarily pass `() => false` and run; assert error message contains 'waitForFlushed' + '50 attempts')
- [ ] #3 All 63 existing pipeline-cli/src/tui/sources/* tests still pass after the change
- [ ] #4 No coverage regression on the 5 files
<!-- AC:END -->
