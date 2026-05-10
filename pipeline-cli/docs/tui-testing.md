# TUI Testing Guide

## Overview

The TUI test infrastructure introduced in AISDLC-255 provides width-pinned rendering for Ink-based components. The standard `ink-testing-library` hardcodes `stdout.columns = 100`, making width-overflow and border-continuity bugs invisible to the standard test harness. This guide explains the `renderAtWidth` helper and how to use it.

## Why width-pinned tests matter (the AISDLC-254 incident)

In AISDLC-254, a fixed-width divider string (`'─'.repeat(N)`) was rendered inside an Ink `Box`. The divider was wider than the intended terminal width, causing it to wrap across multiple lines and breaking the visual layout. The standard `ink-testing-library` harness did not catch this because it always renders at 100 columns — wide enough to accommodate the divider.

`renderAtWidth` bypasses the testing-library wrapper and calls Ink's `render()` directly with a synthetic Stdout whose `columns` is set to the requested width. This makes width-overflow bugs visible at test time.

## The `renderAtWidth` helper

Location: `pipeline-cli/src/tui/__test-helpers/render-at-width.ts`

### Basic usage

```ts
import { renderAtWidth, cleanup } from '../__test-helpers/render-at-width.js';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

it('renders at 80 cols without overflow', () => {
  const { assertNoOverflow, lastFrame } = renderAtWidth(<MyPane />, 80);
  assertNoOverflow();
  expect(lastFrame()).toContain('expected text');
});
```

### API

#### `renderAtWidth(element, width): RenderAtWidthResult`

Renders `element` inside a synthetic terminal pinned to exactly `width` columns.

Returns:
- `lastFrame()` — the last rendered frame (with ANSI sequences)
- `frames` — all captured frames
- `stdin` — synthetic stdin for simulating keystrokes
- `stdout` — synthetic stdout with `columns` set to the requested width
- `assertNoOverflow()` — throws if any line in the last frame exceeds `width` visible columns

#### `cleanup()`

Unmounts all instances created by `renderAtWidth`. Call in `afterEach`.

#### `hasBorderRun(frame, borderChar?): boolean`

Returns `true` if the frame contains a horizontal border run (3+ consecutive copies of `borderChar`, default `'─'`). Use to verify outer border continuity.

#### `countContentLines(frame): number`

Counts non-empty lines in the frame (after stripping ANSI). Useful for detecting unintended wrapping — a wrapped divider produces more lines than the component author intended.

#### `hasLongRun(frame, repeatChar, maxRunLength): boolean`

Returns `true` if the frame contains a contiguous run of `repeatChar` longer than `maxRunLength`. This is the primary detection mechanism for the AISDLC-254 bug class:

```ts
// A 60-char divider should be present at 80 cols (content area = 76)
expect(hasLongRun(frame80, '─', 59)).toBe(true);

// At 30 cols (content area = 26), the divider wraps — run NOT present
expect(hasLongRun(frame30, '─', 59)).toBe(false);
```

### How `assertNoOverflow` works

`assertNoOverflow()` strips ANSI escape sequences from each line and measures visible display width using `string-width` (the same Unicode-aware column counter used by modern terminal emulators). It throws with a human-readable message listing every offending line.

Ink wraps content at `stdout.columns`, so lines rendered by Ink's layout engine will never exceed the column count. `assertNoOverflow()` is most useful for:
- Components that render content outside Ink's layout system (raw byte writes)
- Detecting when the `string-width` vs. Ink layout discrepancy for Unicode characters causes a visible alignment problem

## Pinned widths to use

The standard test suite uses three widths that represent real-world terminal sizes:
- **80 cols** — standard 80-column terminal (the tightest common width)
- **120 cols** — wide laptop terminal
- **160 cols** — ultrawide / tiled terminal

## Writing snapshot tests for a new pane

Follow the pattern established in `pane-width-snapshot.test.tsx`:

```ts
const WIDTHS = [80, 120, 160] as const;

describe('MyPane — width-pinned rendering (AC#2, AC#3)', () => {
  for (const width of WIDTHS) {
    describe(`at ${width} cols`, () => {
      it('(a) no line exceeds pinned width', () => {
        const result = renderAtWidth(<MyPane />, width);
        expect(() => result.assertNoOverflow()).not.toThrow();
      });

      it('(b) border characters present (border continuity)', () => {
        const result = renderAtWidth(<MyPane />, width);
        expect(hasBorderRun(result.lastFrame())).toBe(true);
      });

      it('(c) title contains expected label', () => {
        const result = renderAtWidth(<MyPane />, width);
        expect(result.lastFrame()).toContain('MY PANE TITLE');
      });
    });
  }
});
```

If the pane has known wide-char overflow issues (see section below), skip assertion (a) and add an explicit `toThrow` canary instead:

```ts
it('overflow canary — wide-char layout issue (document here)', () => {
  const result = renderAtWidth(<MyPane />, 80);
  expect(() => result.assertNoOverflow()).toThrow(/exceed the pinned width/);
});
```

## Known wide-char / layout-overflow issues

`string-width` v7 treats some Unicode "Ambiguous" characters as 2 columns wide, matching modern terminal emulators. Ink v5's layout engine treats the same characters as 1 column wide for Yoga layout. This discrepancy causes `assertNoOverflow()` to report a 1-col overflow on panes that use these characters in fixed-width content:

| Character | Codepoint | string-width | Ink layout | Affected panes |
|---|---|---|---|---|
| `▶` | U+25B6 | 2 cols | 1 col | PRs pane (focus indicator), Critical Path pane (focus indicator) |
| `⚙` | U+2699 | 2 cols | 1 col | Analytics pane (PIPELINE THROUGHPUT heading), Config Browser pane (title) |

These findings are documented as explicit `toThrow()` canary tests in `pane-width-snapshot.test.tsx`. When the upstream Ink issue is fixed, the canary tests will fail and need to be converted to `not.toThrow()` assertions.

A follow-up task should audit all pane titles and row indicators for wide-char usage and either:
1. Replace the character with an ASCII or narrow-width alternative, or
2. Pad the surrounding layout to account for the 2-col width

## Detecting the AISDLC-254 bug class

The AISDLC-254 bug class is a **fixed-width string in a Text node** that is wider than the terminal. Examples:
- `'─'.repeat(80)` rendered as `<Text>{divider}</Text>` — the string is the same regardless of terminal width
- Hard-coded column widths in `padEnd()` calls that total more than the terminal width

Detection approach using `hasLongRun`:

```ts
// Symptom: a 60-char divider inside an 80-col pane
// At 80 cols (content area = 76), divider fits → run present
const frame80 = renderAtWidth(<PaneWithDivider />, 80).lastFrame();
expect(hasLongRun(frame80, '─', 59)).toBe(true);  // ✓ no bug

// At 30 cols (content area = 26), divider wraps → run absent
const frame30 = renderAtWidth(<PaneWithDivider />, 30).lastFrame();
expect(hasLongRun(frame30, '─', 59)).toBe(false);  // ✓ bug detected
```

When `hasLongRun` returns `false` at the narrow width, it means the divider string was broken across multiple lines — a visual regression.

## AISDLC-254 lint guard

`scripts/check-tui-fixed-dividers.mjs` (the AISDLC-254 lint guard) catches one variant of this bug: fixed-width strings directly embedded in JSX `Text` nodes (i.e. `<Text>{'─'.repeat(80)}</Text>`). It does NOT catch:
- Constants assigned outside JSX and then referenced in Text nodes
- `padEnd()` calls that produce oversized content
- Any indirect string construction

The `renderAtWidth` + `hasLongRun` approach is complementary: it catches the bug at render time regardless of how the string was constructed.

## Async panes and `flush()`

Some panes trigger async data fetching via hooks. After rendering, call the `flush()` helper to let microtasks settle before asserting:

```ts
async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

it('async pane at 80 cols', async () => {
  const result = renderAtWidth(<AnalyticsPane hookOpts={opts} />, 80);
  await flush();
  expect(hasBorderRun(result.lastFrame())).toBe(true);
});
```

## Files

| File | Purpose |
|---|---|
| `pipeline-cli/src/tui/__test-helpers/render-at-width.ts` | Core helper: `renderAtWidth`, `cleanup`, `hasBorderRun`, `countContentLines`, `hasLongRun` |
| `pipeline-cli/src/tui/__test-helpers/render-at-width.test.tsx` | Unit tests for the helper itself (20 tests) |
| `pipeline-cli/src/tui/__test-helpers/pane-width-snapshot.test.tsx` | Snapshot tests for all 6 top-level panes at 80/120/160 cols (50 tests) |
