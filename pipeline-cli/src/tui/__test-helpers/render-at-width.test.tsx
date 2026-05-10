/**
 * Tests for the `renderAtWidth` helper — AISDLC-255.
 *
 * AC#4 (width-overflow regression): the "AC#4" describe block deliberately
 * renders a component with a fixed-width hard-coded divider that is wider
 * than the pinned terminal width. It asserts that `hasLongRun()` detects the
 * wrapped-divider symptom (the divider string cannot appear as a contiguous
 * run once the terminal is too narrow for it). This proves the harness
 * catches the overflow / visual-wrapping bug class rather than just adding
 * cosmetic snapshot assertions that never fail.
 *
 * The `assertNoOverflow()` helper targets a different mode: scenarios where
 * Ink produces a line wider than `stdout.columns` (e.g. components that
 * bypass Ink's layout and write raw byte sequences, or where an upstream Ink
 * bug regresses wrapping). Tests for that mode use narrower pinned widths
 * and still verify the harness is wired end-to-end.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Box, Text } from 'ink';

import {
  cleanup,
  countContentLines,
  hasBorderRun,
  hasLongRun,
  renderAtWidth,
} from './render-at-width.js';

afterEach(() => cleanup());

/** Render a trivially simple Box with a title and border. */
function SimplePane({ title, content }: { title: string; content?: string }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>{title}</Text>
      {content && <Text>{content}</Text>}
    </Box>
  );
}

/**
 * Render a component with a fixed-width hard-coded divider line.
 * This simulates the AISDLC-254 incident pattern.
 */
function FixedDividerPane({ dividerWidth }: { dividerWidth: number }): React.ReactElement {
  const divider = '─'.repeat(dividerWidth);
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>SECTION HEADER</Text>
      {/* This raw-text divider is exactly what AISDLC-254 + AISDLC-255 guard against. */}
      <Text color="gray">{divider}</Text>
      <Text>Content goes here.</Text>
    </Box>
  );
}

// ── Basic rendering ───────────────────────────────────────────────────────────

describe('renderAtWidth — basic rendering', () => {
  it('renders a component and captures the last frame', () => {
    const { lastFrame } = renderAtWidth(React.createElement(SimplePane, { title: 'Hello' }), 80);
    expect(lastFrame()).toContain('Hello');
  });

  it('returns frames array with at least one entry', () => {
    const { frames } = renderAtWidth(React.createElement(SimplePane, { title: 'Test' }), 80);
    expect(frames.length).toBeGreaterThan(0);
  });

  it('stdout.columns equals the requested width', () => {
    const { stdout } = renderAtWidth(React.createElement(SimplePane, { title: 'Cols' }), 120);
    expect(stdout.columns).toBe(120);
  });
});

// ── assertNoOverflow — passing cases ─────────────────────────────────────────

describe('renderAtWidth — assertNoOverflow passes on well-behaved components', () => {
  const WIDTHS = [80, 120, 160] as const;

  for (const w of WIDTHS) {
    it(`no overflow at ${w} cols for a simple short-content pane`, () => {
      const result = renderAtWidth(
        React.createElement(SimplePane, { title: `Pane at ${w}`, content: 'A short line.' }),
        w,
      );
      // Must not throw.
      expect(() => result.assertNoOverflow()).not.toThrow();
    });
  }
});

// ── Width-overflow / wrapping regression (AC#4) ────────────────────────────────

/**
 * AC#4: prove the harness catches the fixed-divider overflow bug class.
 *
 * The symptom: a fixed-width `─`.repeat(N) divider rendered inside an Ink Box
 * is WIDER than the terminal column count. Ink wraps the divider across
 * multiple lines, breaking the visual appearance (a "torn" divider line
 * instead of a clean horizontal separator).
 *
 * At 80 cols, a 60-char divider fits (border=2, padding=2, content area=76).
 * At 30 cols, a 60-char divider wraps (content area=26 < 60).
 *
 * Detection approach: `hasLongRun()` checks whether the rendered frame
 * contains a contiguous run of the divider character longer than the maximum
 * that could fit in the content area. When the divider wraps, the longest
 * contiguous run in the frame equals the content-area width (26 chars in the
 * example) — far shorter than the original 60-char run. When it does NOT wrap
 * (correct behaviour), the 60-char run is present in full.
 *
 * The test asserts:
 *   - Wide terminal: full divider run IS present (no wrapping).
 *   - Narrow terminal: full divider run is NOT present (wrapping detected).
 */
describe('renderAtWidth — fixed-divider wrapping detection (AC#4)', () => {
  const DIVIDER_LEN = 60;

  it('at 80 cols: 60-char divider is not wrapped (run present in full)', () => {
    const result = renderAtWidth(
      React.createElement(FixedDividerPane, { dividerWidth: DIVIDER_LEN }),
      80,
    );
    // The 60-char run must be present in the 80-col frame (content area = 76).
    expect(hasLongRun(result.lastFrame(), '─', DIVIDER_LEN - 1)).toBe(true);
  });

  it('at 30 cols: 60-char divider IS wrapped (run NOT present in full)', () => {
    const result = renderAtWidth(
      React.createElement(FixedDividerPane, { dividerWidth: DIVIDER_LEN }),
      30,
    );
    // At 30 cols (content area = 26), the divider wraps.
    // The longest contiguous ─ run in the frame should be <= 26, NOT 60.
    // `hasLongRun(frame, '─', DIVIDER_LEN - 1)` returns true iff a run of
    // DIVIDER_LEN chars is present. At 30 cols it must be FALSE.
    expect(hasLongRun(result.lastFrame(), '─', DIVIDER_LEN - 1)).toBe(false);
  });

  it('ink-testing-library (100 cols) misses the wrapping bug; renderAtWidth at 30 cols catches it', () => {
    // This is the core insight of AISDLC-255: the testing-library defaults to
    // 100 cols, so a 60-char divider inside a standard pane never wraps there.
    // renderAtWidth(30) catches it.
    //
    // "ink-testing-library missing the bug" = hasLongRun returns true at 100 cols.
    // "renderAtWidth catching it" = hasLongRun returns false at 30 cols.
    const atDefault = renderAtWidth(
      React.createElement(FixedDividerPane, { dividerWidth: DIVIDER_LEN }),
      100,
    );
    const atNarrow = renderAtWidth(
      React.createElement(FixedDividerPane, { dividerWidth: DIVIDER_LEN }),
      30,
    );

    // At 100 cols, divider fits — same result as ink-testing-library.
    expect(hasLongRun(atDefault.lastFrame(), '─', DIVIDER_LEN - 1)).toBe(true);

    // At 30 cols, divider wraps — renderAtWidth catches the bug.
    expect(hasLongRun(atNarrow.lastFrame(), '─', DIVIDER_LEN - 1)).toBe(false);
  });

  it('countContentLines increases when a divider wraps', () => {
    const atWide = renderAtWidth(
      React.createElement(FixedDividerPane, { dividerWidth: DIVIDER_LEN }),
      80,
    );
    const atNarrow = renderAtWidth(
      React.createElement(FixedDividerPane, { dividerWidth: DIVIDER_LEN }),
      30,
    );

    const wideLines = countContentLines(atWide.lastFrame());
    const narrowLines = countContentLines(atNarrow.lastFrame());

    // Narrower terminal → divider wraps → more content lines in the frame.
    expect(narrowLines).toBeGreaterThan(wideLines);
  });
});

// ── hasBorderRun ─────────────────────────────────────────────────────────────

describe('hasBorderRun', () => {
  it('returns true when the frame contains a horizontal border run', () => {
    const { lastFrame } = renderAtWidth(React.createElement(SimplePane, { title: 'Bordered' }), 80);
    // Ink's single border renders ┌───…───┐ lines; hasBorderRun checks for ───.
    expect(hasBorderRun(lastFrame())).toBe(true);
  });

  it('returns false for undefined frame', () => {
    expect(hasBorderRun(undefined)).toBe(false);
  });

  it('returns false for a frame with no border chars', () => {
    expect(hasBorderRun('Hello World\nNo borders here')).toBe(false);
  });

  it('returns true when a line contains 3+ repeated border chars', () => {
    expect(hasBorderRun('┌───────┐\n│ body │\n└───────┘')).toBe(true);
  });
});

// ── hasLongRun ───────────────────────────────────────────────────────────────

describe('hasLongRun', () => {
  it('returns true when frame contains a run longer than maxRunLength', () => {
    const frame = 'line1\n──────────────────────\nline3';
    expect(hasLongRun(frame, '─', 5)).toBe(true);
  });

  it('returns false when no run exceeds maxRunLength', () => {
    const frame = 'line1\n────\nline3';
    expect(hasLongRun(frame, '─', 5)).toBe(false);
  });

  it('returns false for undefined frame', () => {
    expect(hasLongRun(undefined, '─', 5)).toBe(false);
  });
});

// ── countContentLines ────────────────────────────────────────────────────────

describe('countContentLines', () => {
  it('counts non-empty lines', () => {
    expect(countContentLines('line1\nline2\nline3')).toBe(3);
  });

  it('ignores blank lines', () => {
    expect(countContentLines('line1\n\nline3')).toBe(2);
  });

  it('returns 0 for undefined', () => {
    expect(countContentLines(undefined)).toBe(0);
  });
});
