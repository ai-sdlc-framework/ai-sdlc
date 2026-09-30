---
id: AISDLC-652
title: >-
  RFC-0050 Part A: operator TUI usage pane (window view and top consumers)
status: To Do
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
- [ ] The pane renders the window view and top consumers from a synthetic ledger in a render test.
- [ ] An empty ledger renders the empty state, and an unreadable ledger renders an error line without crashing the app.
- [ ] The pane is reachable from the keymap and listed in the footer like the other panes.
- [ ] Narrow terminal widths truncate columns without wrapping rows.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
