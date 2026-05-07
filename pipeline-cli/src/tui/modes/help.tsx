/**
 * Help screen — RFC-0023 §7.6 / AISDLC-178.5 AC#3.
 *
 * Lists every keystroke with description, sourced from `keymap.ts` so
 * footer + help cannot drift.
 */

import React from 'react';
import { Box, Text } from 'ink';

import { KEYMAP } from '../keymap.js';

export function HelpScreen(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} flexGrow={1}>
      <Text bold color="cyan">
        ? HELP — operator-tui keystrokes
      </Text>
      <Text color="gray">─────────────────────────────────────────────────────────</Text>
      <Box marginTop={1} flexDirection="column">
        {KEYMAP.map((b) => (
          <Box key={b.key}>
            <Text color="cyan">[{b.key}]</Text>
            <Text> </Text>
            <Text>{b.description}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">─────────────────────────────────────────────────────────</Text>
        <Text color="gray" dimColor>
          [Esc] return to overview
        </Text>
      </Box>
    </Box>
  );
}
