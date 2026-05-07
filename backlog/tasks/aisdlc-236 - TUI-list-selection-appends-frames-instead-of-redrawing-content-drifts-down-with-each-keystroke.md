---
id: AISDLC-236
title: >-
  TUI down-arrow keystroke appends frames instead of redrawing in place —
  content drifts down with each press
status: To Do
assignee: []
created_date: '2026-05-07 22:05'
labels:
  - bug
  - tui
  - rfc-0023
  - dogfood
dependencies: []
priority: medium
references:
  - pipeline-cli/src/tui/prs/pane.tsx
  - pipeline-cli/src/tui/app.tsx
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

When the operator presses the **down arrow key** in the TUI, each keystroke renders a new frame BELOW the previous one instead of updating in place. After several arrow presses the layout has visibly drifted down — earlier content has scrolled off the top.

Witnessed empirically by operator 2026-05-07:

> "If I select PR, then go down the list the UI renders but further down with every item I select."
>
> Clarification: "it's not selection but just pressing the down arrow"

So the trigger is the literal down-arrow key (`\x1b[B`), not item selection (Enter/Space). This affects any pane where down-arrow is bound to navigation (PRs, Blockers, Config browser, etc.).

This is a classic Ink rendering issue: the React tree updates, but the stdout writer uses `\n`-appending output instead of cursor-positioning escape sequences, so each frame stacks below the previous one rather than overwriting it. Could also be that the down-arrow keystroke is being echoed to the terminal as a literal `\n` BEFORE Ink's input handler intercepts it.

## Suspected root cause

Two candidates, possibly co-occurring:

1. **Ink not in fullscreen mode** — Ink has a `enterAltScreenBuffer` option (or similar) that uses the terminal's alternate screen buffer (ANSI `\e[?1049h`). Without it, the renderer falls back to scroll-mode output. The TUI may not be entering the alt buffer.

2. **Per-keystroke `console.log` / debug output** — if any handler (keypress logger, navigation event tracker, search-overlay debug print) writes to stdout during the keystroke handling, that output is interleaved with Ink's render and disrupts the in-place update.

Likely related to the resize bug filed as **AISDLC-235** — both point at the Ink renderer not properly owning the screen.

## Proposed fix

### 1. Verify alt-screen-buffer mode

Check `pipeline-cli/src/tui/index.ts` for the Ink `render()` call. Ensure `{ patchConsole: true }` is enabled (silences spurious console.log) AND that the renderer is in fullscreen mode (alt-screen buffer). If using a custom fullscreen wrapper, verify the entry/exit sequences fire correctly.

### 2. Audit for stray writes to stdout

`grep -r "console.log\|process.stdout.write" pipeline-cli/src/tui/` to find any non-Ink output paths in TUI code. Each one is a potential source of disrupting writes.

### 3. Smoke test for in-place updates

ink-testing-library captures every render frame separately. Add a test that:
- Renders the App with a 5-item PR list
- Simulates 3 `j` keystrokes
- Asserts the FINAL frame matches the expected selection state (NOT a concatenation of intermediate frames)

If the existing test infrastructure uses snapshot-per-frame this should already work; the bug may be specific to the real terminal rendering path.

## Acceptance Criteria

- [ ] #1 Investigate root cause: alt-screen buffer mode? stray stdout writes? Other?
- [ ] #2 Fix applied to make list-selection updates render in-place (no scroll-down drift)
- [ ] #3 Manual verification: launch `pnpm tui`, press `p` to enter PRs pane, press `j` 5 times — content does NOT drift down; selection indicator moves cleanly within the same visible region
- [ ] #4 Smoke test exercises navigation in `pipeline-cli/src/tui/prs/pane.test.tsx` (or app.test.tsx) and asserts the FINAL frame is the only visible state — no stacked-frames artifact
- [ ] #5 No regression on the existing list-render tests (snapshots in pane.test.tsx)
- [ ] #6 If the fix is alt-screen-buffer mode, document that `cli-tui` now requires terminal alt-screen support (essentially universal but worth noting)
- [ ] #7 If the fix involves silencing console output, ensure error logging still surfaces in non-TUI fall-through (e.g., Ink unmounts, error reaches operator's terminal)

## Composes with

- **AISDLC-235** (resize-corrupts-layout) — likely shared root cause (Ink renderer ownership of screen). Investigate together; may be one fix.

## References

- `pipeline-cli/src/tui/index.ts` (Ink render() call site)
- `pipeline-cli/src/tui/prs/pane.tsx` (PRs pane — navigation handler)
- `pipeline-cli/src/tui/app.tsx` (root)
- Ink docs on `render()` options, alt-screen buffer, `patchConsole`
- Operator observation 2026-05-07 22:00 PT
- AISDLC-235 (sister TUI rendering bug)
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Investigate root cause (alt-screen buffer? stray stdout writes? other?)
- [ ] #2 Fix applied; list-selection updates render in-place
- [ ] #3 Manual verification: `pnpm tui` → PRs pane → 5x j → no drift
- [ ] #4 Smoke test asserts final-frame-only after navigation sequence
- [ ] #5 No regression on existing pane snapshot tests
- [ ] #6 Document terminal alt-screen requirement if applicable
- [ ] #7 Error logging path still surfaces after Ink unmount
<!-- SECTION:ACCEPTANCE:END -->
