---
id: AISDLC-259
title: Fix TUI panel border misalignment on CRITICAL PATH + OPERATOR THROUGHPUT row
status: To Do
assignee: []
created_date: '2026-05-12 09:55'
labels:
  - tui
  - ui-bug
  - rfc-0023
dependencies: []
priority: low
references:
  - pipeline-cli/src/tui/critical-path/pane.tsx
  - pipeline-cli/src/tui/panes/analytics.tsx
  - pipeline-cli/src/tui/app.tsx
  - pipeline-cli/src/tui/__test-helpers/pane-width-snapshot.test.tsx
---

## Bug

The two side-by-side panels in the middle row of the TUI overview layout (`CRITICAL PATH` left, `OPERATOR THROUGHPUT` right) render with **misaligned borders** at their shared column boundary:

- The right edge of `CRITICAL PATH` shows a **doubled vertical bar** (`||`) instead of a single `│`.
- The right edge of `OPERATOR THROUGHPUT` also shows an extra `|` artifact in the rightmost column.
- A small visible gap appears between the two panels' right-side borders.

The **top row** (`BLOCKERS` + `PRs IN FLIGHT`) on the same screen lays out cleanly under identical parent layout (`<Box width="50%">` × 2 inside a `flexDirection="row"` parent — see `app.tsx:53-60`), so the bug is panel-local, not parent-layout-wide.

## Hypothesis (root cause)

Both middle-row panels carry **wide-grapheme emoji** as the first character of their bold title text:

- `pipeline-cli/src/tui/critical-path/pane.tsx:147` — `🛤️ CRITICAL PATH ({rows.length} tasks)`
  - `🛤️` is U+1F6E4 (railway track) + U+FE0F (variation selector). Two codepoints; visual width 2.
- `pipeline-cli/src/tui/panes/analytics.tsx:31` — `'👥 OPERATOR THROUGHPUT'`
  - `👥` is U+1F465 (busts in silhouette). One codepoint; visual width 2.

The top row uses `✓` (single-width) on the left and `📦` (double-width) on the right; only the right one is wide, and that asymmetry happens to land cleanly. The middle row has wide emojis on **both** sides, doubling whatever per-side width drift Ink's flex layout produces.

Likely culprit: Ink's Yoga-backed flexbox uses `string-width` (or its own variant) to compute child intrinsic widths. Wide emojis — especially those with variation selectors (`🛤️`) — are inconsistently sized between the layout pass and the render pass on some terminals, causing the right border to overshoot by 1 column. With both panels overshooting toward the shared boundary, the borders overlap visibly.

Fix candidates (developer to choose; pick the smallest change that satisfies the ACs):

1. **Strip variation selector** from `🛤️` (use bare U+1F6E4) — cheapest test if this alone fixes it.
2. **Add explicit space** between emoji and title text on `🛤️` (matches the `👥 OPERATOR` style which already has one space; current `🛤️ CRITICAL` has the variation selector glued to the space).
3. **Wrap emoji in its own `<Text>` with explicit width** to take it out of the layout-width calculation.
4. **Replace emojis with ASCII glyphs** for these two panel titles (e.g. `>` or `*`) — most defensive but trades fidelity for correctness.

Whatever option ships should also extend `pipeline-cli/src/tui/__test-helpers/pane-width-snapshot.test.tsx` (or add a new sibling test) with a snapshot that catches this exact misalignment going forward.

## Acceptance criteria

- [ ] Right edge of `CRITICAL PATH` panel renders a single `│` (or `║` if `borderStyle="double"`) — no doubled `||` artifact.
- [ ] Right edge of `OPERATOR THROUGHPUT` panel renders cleanly — no overshoot into the gutter.
- [ ] The two panels' shared column boundary is a single visual gutter, matching the top row's `BLOCKERS`/`PRs IN FLIGHT` boundary.
- [ ] New or extended snapshot test in `pane-width-snapshot.test.tsx` (or co-located test) renders the overview frame and asserts both middle-row panels have matching frame widths and no duplicated border characters at the shared boundary column.
- [ ] All pre-push gates pass: `pnpm build && pnpm test && pnpm lint && pnpm format:check`.
- [ ] No regression on the TOP row layout (`BLOCKERS` + `PRs IN FLIGHT`).

## Out of scope

- Redesigning the Overview layout (`app.tsx OverviewLayout`).
- Touching the Events pane or footer.
- Changing emoji choices for the BLOCKERS / PRs panels — they render correctly today.

## Verification

- Build the TUI and run `node pipeline-cli/bin/cli-tui.mjs` in a terminal.
- Visual inspection: middle-row panel borders match top-row clean alignment.
- `pnpm --filter @ai-sdlc/pipeline-cli test` — green.
