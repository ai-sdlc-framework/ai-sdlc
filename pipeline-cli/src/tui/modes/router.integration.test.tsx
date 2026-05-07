/**
 * ModeRouter integration tests — RFC-0023 §7.6 / AISDLC-178.5 AC#1-2.
 *
 * Drives the rendered router via ink-testing-library's stdin shim — works
 * for printable-character keys (mode switches) but NOT for special keys
 * like Esc/Enter (those go through the pure `routeKey` tests in
 * router.test.ts).
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Box, Text } from 'ink';

import { ModeRouter } from './router.js';

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
