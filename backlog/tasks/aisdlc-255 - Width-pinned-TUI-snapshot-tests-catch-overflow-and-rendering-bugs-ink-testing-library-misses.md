---
id: AISDLC-255
title: 'Width-pinned TUI snapshot tests — catch overflow + rendering bugs ink-testing-library misses'
status: To Do
assignee: []
created_date: '2026-05-10 09:30'
labels:
  - tui
  - testing
  - rfc-0023
  - infrastructure
dependencies:
  - AISDLC-254
priority: medium
references:
  - pipeline-cli/src/tui/
  - pipeline-cli/src/tui/__test-helpers/no-fixed-dividers.test.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`ink-testing-library` captures the LOGICAL render tree as plain strings without enforcing a fixed terminal width or simulating the real terminal renderer. This misses an entire class of visual bugs:

- **Width overflow** — a hardcoded `<Text>───────...</Text>` line passes any logical content assertion because the text IS correct; the failure mode is purely about the line being wider than the rendered pane (caught by AISDLC-254 only by operator screenshot, after 4+ days of broken UI).
- **Emoji width miscalculation** — emoji are 2 cells in most monospace terminals but Ink may count them as 1; a title with emoji that fits in the test renderer may overflow at runtime.
- **Border continuity** — Ink's `borderStyle` rendering vs content that LOOKS like a border (the AISDLC-254 incident exactly).
- **Layout drift** — content that wraps when the terminal is narrower than expected.
- **Color / style rendering** in the actual terminal vs the AST.

## Goal

Add width-pinned snapshot tests that catch the broader class of visual bugs.

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Helper `renderAtWidth(component, width)` that wraps `ink-testing-library` and ASSERTS no captured line exceeds `width` columns (using `string-width` for accurate Unicode/emoji measurement)
- [ ] #2 Snapshot tests for every top-level pane (PRs, BLOCKERS, CRITICAL PATH, OPERATOR THROUGHPUT, EVENTS, CONFIG BROWSER) at 80, 120, and 160 cols
- [ ] #3 Each snapshot test asserts: (a) no line wider than the pinned width, (b) outer border closes (top + bottom + left + right characters present in expected positions), (c) title row contains the expected emoji + label
- [ ] #4 Width-overflow regression test: deliberately put a too-wide string in a pane and assert the test fails (proves the harness catches the bug class, not just the cosmetic snapshot)
- [ ] #5 Documented in `pipeline-cli/docs/tui-testing.md` so future pane authors know to use the helper instead of raw `ink-testing-library`
- [ ] #6 Existing AISDLC-254 lint-style guard kept — width-pinned tests are defense-in-depth, not a replacement
<!-- SECTION:ACCEPTANCE:END -->

## Composes with

- **AISDLC-254** — the immediate fix that prompted this longer-term defense
- **AISDLC-178.x** (RFC-0023 TUI) — every new pane added under that family should use `renderAtWidth`

## Optional later (deferred until needed)

- **Pty-based screenshot tests** — `node-pty` + spawn the actual TUI binary + capture the framebuffer + assert against baseline images. Heavyweight (slow, OS-dependent, baseline maintenance burden) but catches everything including emoji width in the real terminal. Defer until width-pinned snapshots prove insufficient.
- **Storybook for Ink** (`ink-stories` or similar) — visual catalog of every pane rendered at multiple widths, manually reviewed during PR review.
<!-- SECTION:DESCRIPTION:END -->
