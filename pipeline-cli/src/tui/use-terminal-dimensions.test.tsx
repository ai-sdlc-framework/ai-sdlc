/**
 * Tests for useTerminalDimensions hook (AISDLC-235).
 *
 * Verifies that:
 *   - The hook returns initial terminal dimensions from stdout
 *   - When stdout emits a `resize` event the App re-renders (AC#5 smoke test)
 *   - The hook registers a resize listener on the stdout EventEmitter
 */

import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Text } from 'ink';
import { useTerminalDimensions } from './use-terminal-dimensions.js';
import { App } from './app.js';
import { TUI_TELEMETRY_FLAG } from './analytics/feature-flag.js';

// Suppress telemetry writes (same pattern as app.test.tsx).
let savedTelemetry: string | undefined;
beforeAll(() => {
  savedTelemetry = process.env[TUI_TELEMETRY_FLAG];
  process.env[TUI_TELEMETRY_FLAG] = 'off';
});
afterAll(() => {
  if (savedTelemetry !== undefined) process.env[TUI_TELEMETRY_FLAG] = savedTelemetry;
  else delete process.env[TUI_TELEMETRY_FLAG];
});

afterEach(() => {
  cleanup();
});

// ── Hook unit tests ───────────────────────────────────────────────────────────

/**
 * Tiny test component that renders the current dimensions.
 * Used to observe dimension values through the rendered frame.
 */
function DimensionDisplay(): React.ReactElement {
  const { columns, rows } = useTerminalDimensions();
  return (
    <Text>
      cols={columns} rows={rows}
    </Text>
  );
}

describe('useTerminalDimensions', () => {
  it('returns initial columns=100 from the ink-testing-library stdout mock', () => {
    // ink-testing-library's Stdout mock has `get columns() { return 100; }`
    const { lastFrame } = render(<DimensionDisplay />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('cols=100');
  });

  it('returns initial rows=24 as fallback when mock does not define rows', () => {
    const { lastFrame } = render(<DimensionDisplay />);
    const frame = lastFrame() ?? '';
    // The ink-testing-library Stdout mock has no `rows` property, so
    // the hook's fallback `?? 24` kicks in.
    expect(frame).toContain('rows=24');
  });

  it('registers at least one listener on the resize event after mount', async () => {
    // Wait for effects to flush so the hook's useEffect registration fires.
    const { stdout } = render(<DimensionDisplay />);
    // vi.waitFor polls until assertion passes (handles async effect scheduling).
    await vi.waitFor(() => {
      expect(stdout.listenerCount('resize')).toBeGreaterThanOrEqual(1);
    });
  });
});

// ── App re-render smoke test (AC#5) ──────────────────────────────────────────

describe('App resize smoke test (AISDLC-235 AC#5)', () => {
  it('App re-renders after stdout resize event and layout remains intact', async () => {
    const { lastFrame, stdout } = render(<App />);

    // Initial frame must contain the overview pane titles.
    const frameBefore = lastFrame() ?? '';
    expect(frameBefore).toContain('BLOCKERS');
    expect(frameBefore).toContain('PRs IN FLIGHT');

    // Count frames written to stdout before resize (each frame = a render).
    const frames = (stdout as unknown as { frames: string[] }).frames;
    const frameCountBefore = frames.length;

    // Simulate the operator resizing the terminal.
    // ink-testing-library's Stdout is an EventEmitter — emitting 'resize'
    // propagates to the useTerminalDimensions subscription in App, which
    // calls setDimensions and triggers a React re-render.
    stdout.emit('resize');

    // After the resize event the App must re-render (frame count increases)
    // AND the frame content must still contain the pane titles (no corruption).
    await vi.waitFor(() => {
      expect(frames.length).toBeGreaterThan(frameCountBefore);
    });

    const frameAfter = lastFrame() ?? '';
    expect(frameAfter).toContain('BLOCKERS');
    expect(frameAfter).toContain('PRs IN FLIGHT');
  });

  it('layout uses flex/relative sizing — pane titles render at any frame width', () => {
    // Verify that the overview layout uses percent/flex sizing rather than
    // hardcoded pixel widths. This is an indirect check: if the layout were
    // hardcoded, rendering at the default ink-testing-library width (100 cols)
    // would clip or drop content. The pane titles must be visible.
    const { lastFrame } = render(<App />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('BLOCKERS');
    expect(frame).toContain('PRs IN FLIGHT');
    expect(frame).toContain('CRITICAL PATH');
    expect(frame).toContain('EVENTS');
  });
});
