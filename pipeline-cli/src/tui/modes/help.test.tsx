/**
 * Help-screen tests — RFC-0023 §7.6 / AISDLC-178.5 AC#3.
 *
 * Asserts the help screen lists every keymap binding (no drift between
 * footer + help).
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';

import { HelpScreen } from './help.js';
import { KEYMAP } from '../keymap.js';

afterEach(() => {
  cleanup();
});

describe('HelpScreen', () => {
  it('renders every keymap binding', () => {
    const { lastFrame } = render(<HelpScreen />);
    const frame = lastFrame() ?? '';
    for (const b of KEYMAP) {
      expect(frame).toContain(`[${b.key}]`);
    }
  });

  it('renders descriptions sourced from the keymap', () => {
    const { lastFrame } = render(<HelpScreen />);
    const frame = lastFrame() ?? '';
    // Spot-check a few — full description text from keymap.ts.
    expect(frame).toContain('Open Blockers full-screen');
    expect(frame).toContain('Open this help screen');
  });

  it('has a return-to-overview hint', () => {
    const { lastFrame } = render(<HelpScreen />);
    expect(lastFrame() ?? '').toContain('return to overview');
  });
});
