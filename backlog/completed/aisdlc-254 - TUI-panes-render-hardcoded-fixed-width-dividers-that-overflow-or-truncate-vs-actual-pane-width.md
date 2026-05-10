---
id: AISDLC-254
title: 'TUI panes render hardcoded fixed-width `─` dividers that overflow or truncate vs actual pane width'
status: Done
assignee: []
created_date: '2026-05-10 09:30'
labels:
  - bug
  - tui
  - rfc-0023
  - dogfood
dependencies: []
priority: medium
references:
  - pipeline-cli/src/tui/prs/pane.tsx
  - pipeline-cli/src/tui/critical-path/pane.tsx
  - pipeline-cli/src/tui/panes/blockers.tsx
  - pipeline-cli/src/tui/__test-helpers/no-fixed-dividers.test.ts
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Operator screenshot 2026-05-10 09:01 PT showed every TUI pane (BLOCKERS, PRs IN FLIGHT, CRITICAL PATH, OPERATOR THROUGHPUT) with apparently-broken top borders — the title `📦 PRs IN FLIGHT (1) — sort: critical-path` rendered at the border row, but the dash-fill that should complete the border was missing on the right side.

## Root cause

Each pane component rendered its OWN horizontal divider as a `<Text>` content line with a hardcoded character count:

```tsx
<Text color="gray">─────────────────────────────────────────────────────────────</Text>
```

The 61 dashes were the developer's eyeball estimate of the pane's width when authored, NOT a value computed from the actual rendered width. When the operator's terminal renders the pane at any width OTHER than 61 cols (which is virtually always), the divider either overflows the right border (visible as a `─` line bleeding past the box edge) or truncates short of it (visible as a stub).

This was NOT an emoji-width bug, NOT an Ink `borderStyle` bug — purely a hardcoded-character-count bug.

12 such hardcoded dividers across 6 files:
- `prs/pane.tsx` (2)
- `critical-path/pane.tsx` (2)
- `panes/blockers.tsx` (3)
- `config-browser/pane.tsx` (2)
- `modes/help.tsx` (2)
- `modes/deps-full.tsx` (1)

## Fix

Removed all 12 hardcoded divider lines. Section visual separation comes from the existing `marginTop`/`marginBottom` on surrounding `<Box>` components plus the pane's outer `borderStyle="single"` border. No replacement needed — Ink's box border + whitespace already provides the visual frame.

Added lint-style guard test at `pipeline-cli/src/tui/__test-helpers/no-fixed-dividers.test.ts` that walks `pipeline-cli/src/tui/**/*.{ts,tsx}` and rejects any `<Text>─{5,}</Text>` content line. This prevents regressions — any future pane that re-introduces a hardcoded divider will fail CI.

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [x] #1 All hardcoded `<Text>─{5,}</Text>` dividers removed from `pipeline-cli/src/tui/**/*.tsx`
- [x] #2 Lint-style guard test added that fails when any TUI source file contains the pattern
- [x] #3 Operator-visible verification: `pnpm tui` rendering shows clean pane borders at any terminal width (no `─` bleed past borders, no truncated stubs)
- [x] #4 Snapshot tests for affected panes still pass (logical render unchanged — divider was visual noise, not semantically meaningful)
- [x] #5 Filed AISDLC-255 follow-up for width-pinned snapshot tests (longer-term defense against the broader class of width-overflow bugs that ink-testing-library doesn't catch by default)
<!-- SECTION:ACCEPTANCE:END -->

## Why ink-testing-library missed this

`ink-testing-library` captures the LOGICAL render tree as plain strings. A 61-char `─` line passes any string-content assertion because the text IS correct — the visual problem is purely about it being wider/narrower than the rendered pane width, which the testing library doesn't enforce. See AISDLC-255 for the proper width-aware test infrastructure.
<!-- SECTION:DESCRIPTION:END -->
