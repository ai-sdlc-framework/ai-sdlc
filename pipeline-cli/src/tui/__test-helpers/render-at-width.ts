/**
 * Width-pinned TUI render helper — AISDLC-255.
 *
 * ## Why this exists
 *
 * `ink-testing-library`'s `render()` uses a fake Stdout whose `columns`
 * getter always returns 100, regardless of the component's Box widths or
 * any `width` prop you set. This makes width-overflow and border-continuity
 * bugs invisible to the standard test harness — a line that is, say, 140
 * characters wide passes every content assertion because the text IS there;
 * only the rendered width is wrong.
 *
 * `renderAtWidth` bypasses the testing-library wrapper and calls Ink's
 * `render()` directly with a synthetic Stdout whose `columns` is set to the
 * requested `width`. It then exposes an `assertNoOverflow()` helper that
 * checks every captured line against that width using `string-width` (the
 * same Unicode-aware column counter Ink uses internally), so emoji, CJK, and
 * combining characters are handled correctly.
 *
 * ## Usage
 *
 * ```ts
 * import { renderAtWidth } from '../__test-helpers/render-at-width.js';
 *
 * it('renders at 80 cols without overflow', () => {
 *   const { assertNoOverflow, lastFrame } = renderAtWidth(<MyPane />, 80);
 *   assertNoOverflow();
 *   expect(lastFrame()).toContain('expected text');
 * });
 * ```
 *
 * Always call `cleanup()` in `afterEach`:
 *
 * ```ts
 * import { cleanup } from '../__test-helpers/render-at-width.js';
 * afterEach(() => cleanup());
 * ```
 *
 * ## Border continuity assertion
 *
 * Use `assertBorderContinuity(lastFrame(), '─')` to verify that a single-box
 * border has an unbroken top and bottom edge across the full width.
 *
 * ## What it does NOT catch
 *
 * - Pty-level rendering differences (emoji width in real terminals vs. Ink's
 *   virtual layout). Use a pty-based screenshot test for that (deferred per
 *   AISDLC-255 task description).
 * - ANSI escape sequences: `lastFrame()` may include color codes. The line
 *   splitting logic strips ANSI before measuring, matching what a terminal
 *   would actually display.
 */

import { EventEmitter } from 'node:events';
import React from 'react';
import { render as inkRender, type Instance } from 'ink';
import stringWidth from 'string-width';

// ── ANSI strip ────────────────────────────────────────────────────────────────

// Matches VT100 / xterm escape sequences produced by Ink's ANSI output.
// Based on the well-known ansi-regex pattern (MIT — see npm:ansi-regex).
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

// ── Synthetic Stdout ──────────────────────────────────────────────────────────

class SyntheticStdout extends EventEmitter {
  readonly columns: number;
  readonly frames: string[] = [];
  private _lastFrame: string | undefined;

  constructor(columns: number) {
    super();
    this.columns = columns;
  }

  write = (frame: string): void => {
    this.frames.push(frame);
    this._lastFrame = frame;
  };

  lastFrame = (): string | undefined => this._lastFrame;
}

class SyntheticStderr extends EventEmitter {
  readonly frames: string[] = [];
  private _lastFrame: string | undefined;

  write = (frame: string): void => {
    this.frames.push(frame);
    this._lastFrame = frame;
  };

  lastFrame = (): string | undefined => this._lastFrame;
}

class SyntheticStdin extends EventEmitter {
  readonly isTTY = true;
  private data: string | null = null;

  write = (data: string): void => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}

  read = (): string | null => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

// ── Instance registry (for cleanup()) ────────────────────────────────────────

const instances: Instance[] = [];

/** Call in `afterEach` to unmount all renderAtWidth instances. */
export function cleanup(): void {
  for (const inst of instances) {
    inst.unmount();
    inst.cleanup();
  }
  instances.length = 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface RenderAtWidthResult {
  /** The last rendered frame (with ANSI sequences). */
  lastFrame: () => string | undefined;
  /** All captured frames. */
  frames: string[];
  /** Synthetic stdin — use to simulate keystrokes. */
  stdin: SyntheticStdin;
  /** Synthetic stdout — use to inspect raw output. */
  stdout: SyntheticStdout;
  /**
   * Assert that NO line in the last captured frame exceeds `width` columns
   * (measured via `string-width`, so Unicode/emoji are counted correctly).
   *
   * Strips ANSI escape sequences before measuring — the assertion is about
   * visible display width, not byte length.
   *
   * Throws with a human-readable message listing every offending line.
   */
  assertNoOverflow: () => void;
}

/**
 * Render `element` inside a synthetic terminal whose column count is exactly
 * `width`. Returns helpers equivalent to `ink-testing-library`'s `render()`
 * plus an `assertNoOverflow()` guard.
 *
 * Always call `cleanup()` in `afterEach`.
 */
export function renderAtWidth(element: React.ReactElement, width: number): RenderAtWidthResult {
  const stdout = new SyntheticStdout(width);
  const stderr = new SyntheticStderr();
  const stdin = new SyntheticStdin();

  const instance = inkRender(element, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdout: stdout as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stderr: stderr as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stdin: stdin as any,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  instances.push(instance);

  const assertNoOverflow = (): void => {
    const frame = stdout.lastFrame();
    if (!frame) {
      // No frame yet — nothing to check. Tests can call flush() first if
      // they need to assert after async renders.
      return;
    }
    const lines = frame.split('\n');
    const offenders: Array<{ lineIdx: number; visible: string; measuredWidth: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = stripAnsi(lines[i] ?? '');
      // Use `string-width` for accurate Unicode/emoji column measurement.
      // Note: `string-width` v8 counts "Ambiguous" East Asian Width
      // characters (e.g. `▶` U+25B6, `⚙` U+2699, `🛤` U+1F6E4) as 1 column,
      // matching Ink's Yoga layout engine. (v7 counted them as 2, producing
      // 1-col false-positive overflow for panes whose titles or row indicators
      // used such characters — fixed by the AISDLC-524 ink 5→6 / react 18→19
      // migration that bumped this dep to v8.)
      const w = stringWidth(stripped);
      if (w > width) {
        offenders.push({ lineIdx: i, visible: stripped, measuredWidth: w });
      }
    }
    if (offenders.length > 0) {
      const detail = offenders
        .map(
          (o) =>
            `  line ${o.lineIdx + 1}: ${o.measuredWidth} cols > ${width} limit\n    ${o.visible.slice(0, 120)}`,
        )
        .join('\n');
      throw new Error(
        `renderAtWidth(width=${width}): ${offenders.length} line(s) exceed the pinned width.\n${detail}`,
      );
    }
  };

  return {
    lastFrame: stdout.lastFrame,
    frames: stdout.frames,
    stdin,
    stdout,
    assertNoOverflow,
  };
}

// ── Utility: border continuity check ─────────────────────────────────────────

/**
 * Check that a rendered frame contains at least one line whose stripped
 * content is composed entirely of `borderChar` repeated (the top or bottom
 * border of a Box with `borderStyle="single"`).
 *
 * Ink renders single borders as lines containing `┌─…─┐` / `└─…─┘` with
 * corner characters. This helper checks for the presence of the horizontal
 * run, not the exact corner chars, so it works regardless of the border
 * style variant chosen.
 *
 * Returns `true` if any border line is found; `false` otherwise.
 */
export function hasBorderRun(frame: string | undefined, borderChar = '─'): boolean {
  if (!frame) return false;
  const lines = frame.split('\n');
  return lines.some((line) => {
    const stripped = stripAnsi(line);
    // A border run is any line that contains 3+ consecutive copies of the
    // border char — corner/intersection chars (┌┐└┘├┤) are intentionally
    // ignored so this works for both single and double borders.
    return stripped.includes(borderChar.repeat(3));
  });
}

// ── Utility: content-line count check ────────────────────────────────────────

/**
 * Count the number of non-empty lines in the rendered frame (after stripping
 * ANSI). Useful for asserting that a fixed-width divider or other known-
 * single-line content is not wrapping to extra lines.
 *
 * A wrapped divider (content too wide for the terminal) produces MORE lines
 * than the component author intended, which is the visual bug class
 * AISDLC-255 guards against.
 */
export function countContentLines(frame: string | undefined): number {
  if (!frame) return 0;
  return frame.split('\n').filter((line) => stripAnsi(line).trim().length > 0).length;
}

/**
 * Check whether the frame contains a run of `repeatChar` longer than
 * `maxRunLength`. This detects when a fixed-width divider string (e.g.
 * `'─'.repeat(80)`) is rendered as-is rather than being bounded by the
 * terminal width.
 *
 * For width-pinned tests: if `pinned width - border overhead < repeatChar
 * run length` and the pane renders the run as content (not a Ink-border),
 * the run should be split across lines. Detecting split runs can be done by
 * asserting the expected single-line run is NOT present when the terminal is
 * too narrow for it.
 *
 * Returns `true` if a contiguous run longer than `maxRunLength` is found.
 */
export function hasLongRun(
  frame: string | undefined,
  repeatChar: string,
  maxRunLength: number,
): boolean {
  if (!frame) return false;
  const stripped = stripAnsi(frame);
  const run = repeatChar.repeat(maxRunLength + 1);
  return stripped.includes(run);
}
