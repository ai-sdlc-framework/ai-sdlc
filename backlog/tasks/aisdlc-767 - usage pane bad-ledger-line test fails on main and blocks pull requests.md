---
id: AISDLC-767
title: >-
  Usage pane bad-ledger-line test fails on main and blocks pull requests
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - ci
  - tui
  - rfc-0050
dependencies: []
references:
  - pipeline-cli/src/tui/panes/usage.test.tsx
  - pipeline-cli/src/tui/panes/usage.tsx
  - reference/src/usage/store.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

`pipeline-cli/src/tui/panes/usage.test.tsx` > "shows only the fixed error line when the real reader meets a bad ledger line" fails in CI Build & Test on PRs #1278, #1279 (both docs-only) and #1281, and it failed the main-health monitor at 19441b66 on 2026-10-07 while passing at ca24d313. Locally on clean main it fails 3 of 3 runs. The assertion is:

```
AssertionError: expected '┌────…' to contain 'Usage ledger could not be read'
```

The pane renders the normal table, so `loadUsagePaneData` resolved instead of rejecting when the ledger file holds a line that is the JSON literal `null`. `JSON.parse('null')` does not throw, and the reader in `reference/src/usage/store.ts` tolerates lines it cannot use, so no error reaches the pane. The test expects the real reader to surface an error for that input.

Likely root cause: the loader in `pipeline-cli/src/usage/pane-data.ts` reads records from `now` minus the window backwards and stops once the window is covered. The test writes its only record and the bad line to the ledger file for the fixed timestamp 2026-09-10. While that date sat inside the window the bad file was opened and the read threw; as the clock moved past the window the loader stopped opening that file, nothing threw, and the pane rendered a table. This is a clock-dependent test, which is why it passed on 2026-09-1x, was intermittent around 2026-10-07 and fails every run now. The fix should pin `now` in the test through the `deps.now` seam, and the reader's behaviour for a non-object JSON line should be stated separately.

## Scope

1. Decide which contract is right: the reader rejects a ledger line that is not an object (then the pane shows the fixed error line), or the reader skips it (then the test must use an input that the reader does reject, such as a line that is not valid JSON, and the "skipped bad line" behaviour gets its own test).
2. Make the test deterministic: pass a fixed `now` through `deps.now` so the window always covers the test data, and keep `waitForFrame` free of real-time dependence.
3. Confirm `pnpm --filter @ai-sdlc/pipeline-cli test` passes 3 runs in a row.

Sequencing: none. Unblocks every code PR until fixed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] AC-1: The test passes on clean main locally and in CI, 3 consecutive runs each.
- [ ] AC-2: The reader's behaviour for a non-object JSON line is stated in a test with the chosen contract.
- [ ] AC-3: The pane shows USAGE_ERROR_TEXT for every input the reader rejects, and no raw error text or path.
- [ ] AC-4: New and existing tests pass.
<!-- AC:END -->
