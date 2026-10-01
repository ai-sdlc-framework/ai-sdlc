---
id: AISDLC-652
title: >-
  RFC-0050 Part A: operator TUI usage pane (window view and top consumers)
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - usage-ledger
  - tui
dependencies:
  - AISDLC-651
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - pipeline-cli/src/tui/app.tsx
  - pipeline-cli/src/tui/panes/analytics.tsx
  - pipeline-cli/src/tui/keymap.ts
priority: low
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Adds a usage pane to the operator TUI so the allotment and its largest consumers are
visible without running a command. RFC-0050 section A5.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- The ledger stores counts, ids and attribution only. No prompt, response, file content
  or tool output is ever written, logged or put in a fixture.
- Fixtures are synthetic. Never commit a real transcript or a real ledger file.
- Tests never read the real home directory: every path is injected or taken from
  `AI_SDLC_USAGE_DIR` pointing at a temporary directory created with `mkdtemp`.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Scope
1. **Pane** under `pipeline-cli/src/tui/panes/`, registered in
   `pipeline-cli/src/tui/app.tsx` and the keymap like the existing panes. It reads the
   ledger through the reader from AISDLC-648 and the report functions from AISDLC-651;
   it does not shell out.
2. **Content:** the session and weekly windows with units used, implied allotment and
   projected time to the limit; the top five consumers by role and by model for the
   current weekly window, each with its five token classes; the most recent limit
   event and any suspected allotment change.
3. **Behaviour:** refreshes on the pane's existing interval mechanism; renders an
   explanatory empty state when the ledger has no records; honours terminal width the
   way the existing panes do; never throws into the app when the ledger is unreadable.

## Acceptance Criteria
- [x] The pane renders the window view and top consumers from a synthetic ledger in a render test.
- [x] An empty ledger renders the empty state, and an unreadable ledger renders an error line without crashing the app.
- [x] The pane is reachable from the keymap and listed in the footer like the other panes.
- [x] Narrow terminal widths truncate columns without wrapping rows.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
Added a full-screen usage pane to the operator TUI, opened with `u` and listed in the footer and help. It shows the session and weekly windows (units used, implied allotment, projected time to the limit), the top five consumers of the current weekly window by role and by model with their five token classes, the most recent limit event and any suspected allotment change.

## Changes
- `pipeline-cli/src/usage/pane-data.ts` (new): composes the existing ledger reader, window, report and snapshot functions into the pane's data; `allSnapshots` in `commands.ts` is now exported and reused
- `pipeline-cli/src/tui/panes/usage.tsx` (new): the pane, with empty, loading and error states and per-row truncation
- `pipeline-cli/src/tui/keymap.ts`, `modes/router.tsx`: `u` key and `usage` mode; footer and help derive from the keymap
- Tests for the data module and the pane, plus updated keymap, router and app footer tests

## Design decisions
- The pane reads the usage config from the machine file or defaults and skips the base-ref `git show`, so it never shells out.
- Refresh uses a 15 second poll interval plus the router's refresh key; the interval is cleared on unmount.
- A failed read renders one fixed error line; the underlying error text and paths are never shown.
- Rows are single strings with end truncation, so a narrow terminal never wraps a row.

## Verification
- `pnpm build`, `pnpm lint`, `pnpm dark-code:check`, the rfc, docs, follow-up and adopter-string gates clean; `pnpm format:check` reports only the two dashboard files that are also flagged without this change
- About 100% line coverage on the pane and 97% on the data module
- AC 5 left unchecked: root `pnpm test` is not fully green locally; the verify-runtime, bin-invocation `pnpm exec` probes and the App-level TUI render timeouts (app.test, use-terminal-dimensions) fail the same way on a clean origin/main checkout

## Follow-up
- (none)
- declined: showing the pane in the overview grid is left out because the overview layout has no free slot and the task scopes the pane to a mode
