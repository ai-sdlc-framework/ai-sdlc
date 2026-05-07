/**
 * ModeRouter integration tests — RFC-0023 §7.6 / AISDLC-178.5 AC#1-2.
 *
 * Drives the rendered router via ink-testing-library's stdin shim — works
 * for printable-character keys (mode switches) but NOT for special keys
 * like Esc/Enter (those go through the pure `routeKey` tests in
 * router.test.ts).
 */

import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Box, Text } from 'ink';

import { ModeRouter } from './router.js';
import { TUI_TELEMETRY_FLAG } from '../analytics/feature-flag.js';

// AISDLC-178.6 — the router now logs every mode transition to
// `_operator/interactions.jsonl`. Suppress those writes here so the
// integration test stays hermetic.
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

const overview = (
  <Box>
    <Text>OVERVIEW SLOT</Text>
  </Box>
);

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('ModeRouter render lifecycle', () => {
  it('renders the overview slot when mode === overview (default)', async () => {
    const { lastFrame } = render(<ModeRouter overviewSlot={overview} />);
    await flush();
    expect(lastFrame() ?? '').toContain('OVERVIEW SLOT');
  });

  it('? swaps to the help screen', async () => {
    const { stdin, lastFrame } = render(<ModeRouter overviewSlot={overview} />);
    await flush();
    stdin.write('?');
    await flush();
    expect(lastFrame() ?? '').toContain('HELP — operator-tui');
    // The overview slot should no longer render.
    expect(lastFrame() ?? '').not.toContain('OVERVIEW SLOT');
  });

  it('c swaps to the config browser', async () => {
    const { stdin, lastFrame } = render(<ModeRouter overviewSlot={overview} />);
    await flush();
    stdin.write('c');
    await flush();
    expect(lastFrame() ?? '').toContain('CONFIGURATION');
  });

  it('a swaps to the analytics full-screen pane', async () => {
    const { stdin, lastFrame } = render(<ModeRouter overviewSlot={overview} />);
    await flush();
    stdin.write('a');
    await flush();
    expect(lastFrame() ?? '').toContain('LAST 24H');
  });

  it('/ opens the search overlay', async () => {
    const { stdin, lastFrame } = render(<ModeRouter overviewSlot={overview} />);
    await flush();
    stdin.write('/');
    await flush();
    expect(lastFrame() ?? '').toContain('type to filter');
  });
});
