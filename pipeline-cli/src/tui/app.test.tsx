/**
 * App component tests for the operator TUI (RFC-0023 Phase 1 / AISDLC-178.1).
 *
 * Uses `ink-testing-library` to render the App and assert on `lastFrame()`.
 * Phase 1 surface is purely visual placeholders, so coverage focuses on:
 *   - All five RFC-0023 §7 panes render their title text
 *   - Footer renders all 9 keystroke bindings (b/p/d/c/a///r/?/q)
 *   - Blockers placeholder shows the OQ-9 affirming empty-state copy
 */

import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { App, handleAppKey } from './app.js';
import { BLOCKERS_EMPTY_STATE } from './panes/blockers.js';
import { FOOTER_KEYS } from './footer.js';
import { TUI_TELEMETRY_FLAG } from './analytics/feature-flag.js';

// AISDLC-178.6 — the App's ModeRouter now logs interactions on mount.
// Suppress those writes here so app.test.tsx stays hermetic (no writes
// to <cwd>/artifacts/_operator/interactions.jsonl).
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

describe('App (Overview Mode layout)', () => {
  it('renders all five RFC-0023 §7 pane titles', () => {
    const { lastFrame } = render(<App />);
    const frame = lastFrame() ?? '';

    // Title text from each pane component (icons are decorative; assert on the words).
    expect(frame).toContain('BLOCKERS');
    expect(frame).toContain('PRs IN FLIGHT');
    expect(frame).toContain('CRITICAL PATH');
    expect(frame).toContain('LAST 24H');
    expect(frame).toContain('EVENTS');
  });

  it('renders the Blockers OQ-9 affirming empty-state copy', () => {
    const { lastFrame } = render(<App />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain(BLOCKERS_EMPTY_STATE);
    // Spot-check the literal RFC §15 OQ-9 phrasing too.
    expect(frame).toContain('No decisions pending');
    expect(frame).toContain('pipeline self-driving');
  });

  it('footer renders all 10 keystroke bindings', () => {
    const { lastFrame } = render(<App />);
    const frame = lastFrame() ?? '';

    const expectedKeys = ['b', 'p', 'd', 'c', 'a', 'n', '/', 'r', '?', 'q'];
    expect(FOOTER_KEYS.map(([k]) => k)).toEqual(expectedKeys);

    for (const key of expectedKeys) {
      expect(frame).toContain(`[${key}]`);
    }
  });

  it('footer renders descriptive labels for each key', () => {
    const { lastFrame } = render(<App />);
    const frame = lastFrame() ?? '';

    // Sample several labels — ensures the footer wired them, not just the bracketed keys.
    expect(frame).toContain('blockers');
    expect(frame).toContain('PRs');
    expect(frame).toContain('quit');
    expect(frame).toContain('analytics');
  });
});

describe('App (keystroke handling)', () => {
  it('handleAppKey: `q` invokes exit() and is consumed', () => {
    const exit = vi.fn();
    const consumed = handleAppKey('q', { exit });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(consumed).toBe(true);
  });

  it('handleAppKey: unrelated keystrokes do not invoke exit() and are not consumed', () => {
    const exit = vi.fn();

    expect(handleAppKey('x', { exit })).toBe(false);
    expect(handleAppKey('Q', { exit })).toBe(false); // case-sensitive — uppercase Q is reserved for future
    expect(handleAppKey('1', { exit })).toBe(false);
    expect(handleAppKey('', { exit })).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('renders without crashing when stdin receives unrelated keystrokes', () => {
    const { stdin, lastFrame, unmount } = render(<App />);

    stdin.write('x');
    stdin.write('Z');
    stdin.write('1');

    expect(lastFrame()).toBeDefined();
    expect(lastFrame()).toContain('BLOCKERS');

    unmount();
  });
});
