/**
 * Footer — keystroke legend (RFC-0023 §7 / §7.6).
 *
 * Sourced from `keymap.ts` so the footer + help screen cannot drift
 * (AISDLC-178.5 AC#3).
 *
 * Per AISDLC-178.1 acceptance criteria #5 the footer renders 9 mode keys:
 *   [b] blockers  [p] PRs  [d] deps  [c] config  [a] analytics
 *   [/] search    [r] refresh        [?] help    [q] quit
 */

import React from 'react';
import { Box, Text } from 'ink';

import { KEYMAP } from './keymap.js';

/** Backwards-compatible export — `[key, label]` pairs. */
export const FOOTER_KEYS: ReadonlyArray<readonly [string, string]> = KEYMAP.map(
  (b) => [b.key, b.footerLabel] as const,
);

export function Footer(): React.ReactElement {
  return (
    <Box paddingX={1}>
      <Text color="gray">
        {FOOTER_KEYS.map(([key, label], i) => (
          <Text key={key}>
            {i > 0 ? '  ' : ''}
            <Text color="cyan">[{key}]</Text> {label}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
