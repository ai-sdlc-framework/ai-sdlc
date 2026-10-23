---
id: AISDLC-1046
title: 'Dependency: upgrade ink from 6 to the current 8 line and fix the Escape key handling it breaks in four TUI panes'
status: Done
assignee: []
created_date: '2026-10-22'
labels:
  - dependencies
  - pipeline-cli
dependencies: []
references:
  - pipeline-cli/package.json
  - pipeline-cli/src/tui/panes/blockers.tsx
  - pipeline-cli/src/tui/prs/pane.tsx
  - pipeline-cli/src/tui/critical-path/pane.tsx
  - pipeline-cli/src/tui/config-browser/pane.tsx
  - pnpm-lock.yaml
priority: low
dispatchable: true
---

## Description

Dependabot PR #1922 (ink 6.8.0 to 8.0.0, head 03d2e96d2) is red on Build & Test and on the macOS pipeline-cli tests with the same four failures:

```
FAIL src/tui/prs/pane.test.tsx > PrsPaneContent — keyboard navigation > closes detail view on Escape
FAIL src/tui/panes/blockers.test.tsx > BlockersPane > detail view keyboard handling > closes detail view on Esc
FAIL src/tui/critical-path/pane.test.tsx > CriticalPathPaneContent — keyboard navigation > closes detail view on Escape
FAIL src/tui/config-browser/pane.test.tsx > ConfigBrowserPane — detail view (AC#5) > Esc returns to list view from detail
Tests 4 failed | 11962 passed | 13 skipped
```

Every failing test drives a detail view and sends the Escape byte through ink-testing-library; the pane handlers check `key.escape` in `useInput`. ink 8 changed how a lone Escape is parsed (it is no longer reported immediately, because it may start a longer sequence), so `key.escape` is not set on the synchronous write the tests make. Upgrade ink in one PR and adapt either the test harness (flush the Escape timeout) or the handlers, whichever the ink 8 release notes prescribe, so that a real Escape key press still closes the detail view. The operator TUI is retired (no feature investment), so the fix is limited to keeping the existing behaviour and tests green under the new major; no redesign.

**Five-step review (requirements first).** Requirement questioned: does the repository need ink 8 at all, given the TUI is retired? The dependency stays until the TUI is removed, and an unlanded major keeps a red bot PR open for weeks, so the bump is taken now at the minimum cost. Deletion: nothing to delete here; removing the TUI is a separate decision for the operator. Simplified: one PR that bumps the package and adapts the Escape handling, instead of pushing fixes onto a bot branch. Accelerated: the fix is scoped to the four quoted tests, no refactor. Automated last: nothing new; the existing Dependabot group and auto-merge keep working after this lands.

## Acceptance Criteria

- [ ] ink 8.x in `pnpm-lock.yaml` for pipeline-cli; `pnpm build` green.
- [ ] The four quoted tests pass without being skipped or weakened: each still asserts the detail view closes on Escape.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green locally; `ai-sdlc/pr-ready` green.
- [ ] PR body names Dependabot PR #1922 as superseded; nobody closes it by hand.
