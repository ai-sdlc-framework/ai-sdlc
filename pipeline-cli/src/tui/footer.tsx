/**
 * Footer — keystroke legend (RFC-0023 §7 / §7.6).
 *
 * Per AISDLC-178.1 acceptance criteria #5 the footer renders 9 mode keys:
 *   [b] blockers  [p] PRs  [d] deps  [c] config  [a] analytics
 *   [/] search    [r] refresh        [?] help    [q] quit
 *
 * Mode-switch handlers ship in Phase 5 (AISDLC-178.5); the q/Ctrl+C exit
 * path is wired in Phase 1.
 */

import React from 'react';
import { Box, Text } from 'ink';

export const FOOTER_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['b', 'blockers'],
  ['p', 'PRs'],
  ['d', 'deps'],
  ['c', 'config'],
  ['a', 'analytics'],
  ['/', 'search'],
  ['r', 'refresh'],
  ['?', 'help'],
  ['q', 'quit'],
];

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
